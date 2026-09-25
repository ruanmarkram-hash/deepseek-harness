import { describe, expect, it, vi } from 'vitest'
import type { MobileRemoteConnectionConfig } from '../remote'
import {
  ReactNativeMobileRemoteSocketFactory,
  type MobileNativeWebSocket,
} from '../mobile-remote-socket'

const ROUTE_ID = 'remote_route_identifier_123'
const DEVICE_TOKEN = 'd'.repeat(32)

function config(): MobileRemoteConnectionConfig {
  return {
    clientAuthToken: DEVICE_TOKEN,
    connectionEpoch: 1,
    deviceEnrollmentId: 'device_enrollment_identifier_123',
    hostDeviceId: 'host_device_identifier_123',
    hostEnrollmentId: 'host_enrollment_identifier_123',
    hostStaticAgreementPublicKey: 'a'.repeat(43),
    routeGeneration: 1,
    routeId: ROUTE_ID,
  }
}

class FakeWebSocket implements MobileNativeWebSocket {
  readyState = 0
  onclose: ((event: { readonly code?: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onopen: (() => void) | null = null
  readonly closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []
  readonly sent: string[] = []

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = 3
    this.onclose?.({ code })
  }

  send(data: string): void { this.sent.push(data) }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  error(): void { this.onerror?.() }

  message(data: unknown): void { this.onmessage?.({ data }) }

  peerClose(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

function factory(socket: FakeWebSocket, seen: { url?: string; protocols?: readonly string[] } = {}): ReactNativeMobileRemoteSocketFactory {
  return new ReactNativeMobileRemoteSocketFactory((url, protocols) => {
    seen.url = url
    seen.protocols = protocols
    return socket
  })
}

describe('ReactNativeMobileRemoteSocketFactory', () => {
  it('adapts native WebSocket events and forwards send and close through the default factory', async () => {
    const socket = new FakeWebSocket()
    const construct = vi.fn(function () { return socket })
    vi.stubGlobal('WebSocket', construct)
    try {
      const pending = new ReactNativeMobileRemoteSocketFactory().create(config(), new AbortController().signal)
      socket.open()
      const relay = await pending
      expect(construct).toHaveBeenCalledWith('wss://dshrelay.rulabs.dev/v3/routes/' + ROUTE_ID + '/connect',
        ['dsh-remote-v3', 'dsh-device.' + DEVICE_TOKEN])
      socket.message('native-frame')
      const receiver = relay.receive()[Symbol.asyncIterator]()
      expect(await receiver.next()).toEqual({ done: false, value: 'native-frame' })
      relay.send('reply')
      expect(socket.sent).toEqual(['reply'])
      relay.close(1000, 'test')
      expect(socket.closes).toHaveLength(1)
      expect(await receiver.next()).toEqual({ done: true, value: undefined })
    } finally { vi.unstubAllGlobals() }
  })

  it('opens only the fixed deployed V3 device route with the device subprotocol', async () => {
    const socket = new FakeWebSocket()
    const seen: { url?: string; protocols?: readonly string[] } = {}
    const pending = factory(socket, seen).create(config(), new AbortController().signal)
    socket.open()
    await expect(pending).resolves.toBeDefined()
    expect(seen).toEqual({
      url: 'wss://dshrelay.rulabs.dev/v3/routes/' + ROUTE_ID + '/connect',
      protocols: ['dsh-remote-v3', 'dsh-device.' + DEVICE_TOKEN],
    })
  })

  it('receives only ordered text frames after the upgrade opens', async () => {
    const socket = new FakeWebSocket()
    const pending = factory(socket).create(config(), new AbortController().signal)
    socket.open()
    const relay = await pending
    socket.message('first')
    socket.message('second')
    const receiver = relay.receive()[Symbol.asyncIterator]()
    await expect(receiver.next()).resolves.toEqual({ done: false, value: 'first' })
    await expect(receiver.next()).resolves.toEqual({ done: false, value: 'second' })
    await receiver.return?.()
  })

  it('closes an opening attempt when it is aborted', async () => {
    const socket = new FakeWebSocket()
    const controller = new AbortController()
    const pending = factory(socket).create(config(), controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('DSH relay connection cancelled')
    expect(socket.closes).toEqual([{ code: 1000, reason: 'dsh-mobile-closed' }])
  })

  it('closes the carrier and ends receive when its receive signal is aborted', async () => {
    const socket = new FakeWebSocket()
    const pending = factory(socket).create(config(), new AbortController().signal)
    socket.open()
    const relay = await pending
    const controller = new AbortController()
    const receiver = relay.receive(controller.signal)[Symbol.asyncIterator]()
    const next = receiver.next()
    controller.abort()
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    expect(socket.closes).toEqual([{ code: 1000, reason: 'dsh-mobile-closed' }])
  })

  it('ends a pending receiver when the open carrier reports a transport error', async () => {
    const socket = new FakeWebSocket()
    const pending = factory(socket).create(config(), new AbortController().signal)
    socket.open()
    const relay = await pending
    const next = relay.receive()[Symbol.asyncIterator]().next()
    socket.error()
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    expect(socket.closes).toEqual([{ code: 1011, reason: 'dsh-mobile-closed' }])
  })

  it('ends a pending receiver when the open carrier is closed by the relay', async () => {
    const socket = new FakeWebSocket()
    const pending = factory(socket).create(config(), new AbortController().signal)
    socket.open()
    const relay = await pending
    const next = relay.receive()[Symbol.asyncIterator]().next()
    socket.peerClose()
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    expect(socket.closes).toEqual([])
  })

  it('uses a fixed close reason and ends any pending receiver', async () => {
    const socket = new FakeWebSocket()
    const pending = factory(socket).create(config(), new AbortController().signal)
    socket.open()
    const relay = await pending
    const receiver = relay.receive()[Symbol.asyncIterator]()
    const next = receiver.next()
    relay.close(4000, DEVICE_TOKEN)
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    expect(socket.closes).toEqual([{ code: 4000, reason: 'dsh-mobile-closed' }])
  })

  it('fails closed on an oversized or excessive inbound relay frame', async () => {
    const socket = new FakeWebSocket()
    const pending = factory(socket).create(config(), new AbortController().signal)
    socket.open()
    const relay = await pending
    socket.message('x'.repeat(13 * 1024 * 1024))
    await expect(relay.receive()[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined })
    expect(socket.closes).toEqual([{ code: 1009, reason: 'dsh-mobile-closed' }])
  })

  it('fails closed instead of sending an oversized outbound relay frame', async () => {
    const socket = new FakeWebSocket()
    const pending = factory(socket).create(config(), new AbortController().signal)
    socket.open()
    const relay = await pending
    expect(() =>{  relay.send('x'.repeat(13 * 1024 * 1024)) }).toThrow('DSH relay frame exceeds its supported size')
    expect(socket.sent).toEqual([])
    expect(socket.closes).toEqual([{ code: 1009, reason: 'dsh-mobile-closed' }])
  })

  it('fails closed rather than buffering more than four inbound relay frames', async () => {
    const socket = new FakeWebSocket()
    const pending = factory(socket).create(config(), new AbortController().signal)
    socket.open()
    const relay = await pending
    for (let index = 0; index < 5; index += 1) socket.message(`frame-${String(index)}`)
    await expect(relay.receive()[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined })
    expect(socket.closes).toEqual([{ code: 1009, reason: 'dsh-mobile-closed' }])
  })
})
