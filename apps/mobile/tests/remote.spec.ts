import { x25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it, vi } from 'vitest'
import { acceptRemoteRelayDevice, type RemoteRelaySocket } from '@deepseek-ai/dsh-remote-relay-protocol'
import type { RemoteWireEnvelope, RemoteWireEventEnvelope, RemoteWireId, RemoteWireJson } from '@deepseek-ai/dsh-remote-wire'
import { MobileRemoteClient, type MobileDeviceIdentity, type MobileRemoteConnectionConfig, type MobileRemoteState } from '../remote'
import { mobileConnectionView, MobileConnectionNotices } from '../mobile-connection-view'
import { disconnectRemoteWhenBackgrounded } from '../mobile-app-state'
import { connectStoredHost } from '../mobile-connection-action'
import { NativeMobileRemoteStateStore } from '../mobile-remote-state'

const route = { routeId: 'remote_route_identifier_123', generation: 3, connectionEpoch: 2 }
const hostDeviceId = 'host_device_identifier_123'
const deviceId = 'device_identifier_123'
const hostEnrollmentId = 'host_enrollment_identifier_123'
const deviceEnrollmentId = 'device_enrollment_identifier_123'

class Queue {
  private readonly values: string[] = []
  private waiter: ((value: IteratorResult<string>) => void) | undefined
  private closed = false

  push(value: string): void {
    if (this.closed) return
    const waiter = this.waiter
    if (waiter === undefined) {
      this.values.push(value)
      return
    }
    this.waiter = undefined
    waiter({ done: false, value })
  }

  end(): void {
    this.closed = true
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.({ done: true, value: undefined })
  }

  async next(): Promise<IteratorResult<string>> {
    const value = this.values.shift()
    if (value !== undefined) return { done: false, value }
    if (this.closed) return { done: true, value: undefined }
    return new Promise((resolve) => { this.waiter = resolve })
  }
}

function sockets(dropMessage?: 'commit' | 'confirm' | 'receipt'): readonly [RemoteRelaySocket, RemoteRelaySocket] {
  const left = new Queue()
  const right = new Queue()
  const side = (inbound: Queue, outbound: Queue): RemoteRelaySocket => ({
    send(data): void {
      const parsed: unknown = JSON.parse(data)
      const type = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { readonly type?: unknown }).type
        : undefined
      if (dropMessage === type) {
        outbound.end()
        return
      }
      outbound.push(data)
    },
    close(): void { inbound.end(); outbound.end() },
    async *receive(): AsyncIterable<string> {
      for (;;) {
        const next = await inbound.next()
        if (next.done) return
        yield next.value
      }
    },
  })
  return [side(left, right), side(right, left)]
}

function random(seed: number) {
  let value = seed
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) {
      value = (value * 1_103_515_245 + 12_345) >>> 0
      bytes[index] = value & 0xff
    }
    return bytes
  }
}

function encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decode(value: string): Uint8Array {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4))
  return Uint8Array.from(binary, byte => byte.charCodeAt(0))
}

function identity(id: string, fill: number): MobileDeviceIdentity {
  const secret = new Uint8Array(32).fill(fill)
  return {
    deviceId: id as RemoteWireId,
    signingPublicKey: encode(new Uint8Array(32).fill(fill + 1)),
    agreement: {
      publicKey: encode(x25519.getPublicKey(secret)),
      deriveSharedSecret(peerAgreementPublicKey): Uint8Array { return x25519.getSharedSecret(secret, decode(peerAgreementPublicKey)) },
    },
  }
}

function config(host: MobileDeviceIdentity): MobileRemoteConnectionConfig {
  return {
    clientAuthToken: 'secret-not-rendered',
    connectionEpoch: route.connectionEpoch,
    deviceEnrollmentId,
    hostDeviceId,
    hostEnrollmentId,
    hostStaticAgreementPublicKey: host.agreement.publicKey,
    routeGeneration: route.generation,
    routeId: route.routeId,
  }
}

function event(cursor: number, epoch = route.connectionEpoch): RemoteWireEventEnvelope {
  return {
    version: 3,
    type: 'event',
    connectionEpoch: epoch,
    cursor,
    eventId: `event_identifier_${cursor.toString().padStart(12, '0')}` as RemoteWireId,
    requestId: `request_identifier_${cursor.toString().padStart(10, '0')}` as RemoteWireId,
    event: 'host/session-added',
    payload: { sessionId: 'session_identifier_123456' },
  }
}

async function hostAcceptance(socket: RemoteRelaySocket, host: MobileDeviceIdentity, device: MobileDeviceIdentity, epoch: number, methods?: string[], describe: RemoteWireJson = { mode: 'replay', cursor: 0 }) {
  const connection = await acceptRemoteRelayDevice({
    socket,
    identity: { ...host, enrollmentId: hostEnrollmentId },
    peer: { deviceId, enrollmentId: deviceEnrollmentId, agreementPublicKey: device.agreement.publicKey },
    random: { randomBytes: random(20) },
    route: { ...route, connectionEpoch: epoch },
    epochFinalizer: { finalize: async (): Promise<void> => undefined },
  })
  const iterator = connection.receive()[Symbol.asyncIterator]()
  for (const method of ['device.describe', 'session.list'] as const) {
    const incoming = await iterator.next()
    if (incoming.done) throw new Error(`Host stream ended before bootstrap request ${method}`)
    if (incoming.value.type !== 'device-control' && incoming.value.type !== 'request') {
      throw new Error(`Expected Host bootstrap request ${method}`)
    }
    const valid = method === 'device.describe'
      ? incoming.value.type === 'device-control' && incoming.value.action === method
      : incoming.value.type === 'request' && incoming.value.method === method
    if (!valid) throw new Error(`Expected Host bootstrap request ${method}`)
    methods?.push(method)
    await connection.send({
      version: 3,
      type: 'response',
      connectionEpoch: epoch,
      requestId: incoming.value.requestId,
      result: { ok: true, value: method === 'session.list' ? { items: [] } : describe },
    }, { active: true, generation: 1, abortSignal: new AbortController().signal })
  }
  return {
    ...connection,
    async *receive(): AsyncIterable<RemoteWireEnvelope> {
      for (;;) {
        const incoming = await iterator.next()
        if (incoming.done) return
        yield incoming.value
      }
    },
  }
}

function client(socket: RemoteRelaySocket, identity: MobileDeviceIdentity, states: string[]): MobileRemoteClient {
  return new MobileRemoteClient({
    identityProvider: {
      deviceIdentity: async () => identity,
      requireUserPresence: async () => undefined,
      clearUserPresence: () => undefined },
    onEvent: () => undefined,
    onSnapshot: () => undefined,
    onState: state => states.push(state.kind),
    randomBytes: random(9),
    epochProvider: {
      nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
      recordAuthenticatedConnection: async () => undefined },
    socketFactory: { create: async () => socket },
  })
}

describe('MobileRemoteClient', () => {
  it('retains a safe failure across backgrounding, then restores a cleared client for an explicit encrypted retry', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    let record: string | null = null
    const persisted = new NativeMobileRemoteStateStore({
      loadRemoteState: async () => record,
      saveRemoteState: async (value) => { record = value },
      clearRemoteState: async () => { record = null },
    })
    let failPresence = true
    const identityProvider = {
      deviceIdentity: async () => device,
      requireUserPresence: vi.fn(async () => { if (failPresence) throw new Error('SECRET_NATIVE_ERROR') }),
      clearUserPresence: vi.fn(),
    }
    await persisted.saveInvitation({ config: { ...config(host), clientAuthToken: 'a'.repeat(32) }, expiresAt: '2026-09-01T00:00:00.000Z', identityProvider })
    const notices = new MobileConnectionNotices()
    const lease = notices.claim()
    const states: MobileRemoteState[] = []
    const current = (): MobileRemoteState => states.at(-1) ?? { kind: 'unconfigured' }
    const view = () => mobileConnectionView(current(), notices.current)
    const socketFactory = { create: vi.fn(async () => deviceSocket) }
    const remote = new MobileRemoteClient({
      identityProvider, epochProvider: persisted, socketFactory, randomBytes: random(9),
      onEvent: () => undefined, onSnapshot: () => undefined,
      onState: (state) => { states.push(state); lease.update({ kind: 'state', state }) },
      onDisconnect: (notice) => { lease.update({ kind: 'disconnect', notice }) },
    })
    const reconnect = vi.spyOn(remote, 'reconnect')
    try {
      await connectStoredHost(remote, current(), persisted, vi.fn())
      const failed = view()
      disconnectRemoteWhenBackgrounded('background', (reason) => { remote.disconnect(reason) })
      const backgrounded = view()
      expect(current().kind).toBe('disconnected')
      await expect(remote.request('session.list', {})).rejects.toThrow('not connected')
      disconnectRemoteWhenBackgrounded('active', (reason) => { remote.disconnect(reason) })
      expect(view()).toEqual(backgrounded)
      expect(socketFactory.create).not.toHaveBeenCalled()
      expect(identityProvider.requireUserPresence).toHaveBeenCalledOnce()
      failPresence = false
      const accepting = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
      await Promise.all([accepting, connectStoredHost(remote, current(), persisted, vi.fn())])
      expect(reconnect).not.toHaveBeenCalled()
      expect(current().kind).toBe('connected')
      expect(notices.current).toBeUndefined()
      expect(identityProvider.requireUserPresence).toHaveBeenCalledTimes(2)
      expect((await persisted.restore())?.nextConnectionEpoch).toBe(route.connectionEpoch + 1)
      expect({ failed, backgrounded, connected: view() }).toMatchInlineSnapshot(`
        {
          "backgrounded": {
            "disabled": false,
            "label": "Connect to Host",
            "message": "Connection stopped at owner-presence. Owner authentication did not complete. You can retry. The app reported background. The connection and authentication were cleared. Connect again to authenticate.",
          },
          "connected": {
            "disabled": true,
            "label": "Host connected",
            "message": "The live Host workspace is ready.",
          },
          "failed": {
            "disabled": false,
            "label": "Retry connection",
            "message": "Connection stopped at owner-presence. Owner authentication did not complete. You can retry.",
          },
        }
      `)
      remote.disconnect()
      await persisted.clear()
      lease.update({ kind: 'clear' })
      expect(view().message).toBeUndefined()
      expect(await persisted.restore()).toBeUndefined()
    } finally { remote.disconnect(); lease.release() }
  })

  it('records cancellation at owner presence and ignores late authentication even when observers throw', async () => {
    const host = identity(hostDeviceId, 7)
    let release: (() => void) | undefined
    let presence = false
    const clearUserPresence = vi.fn(() => { presence = false })
    const socketFactory = { create: vi.fn(async () => { throw new Error('No socket after cancellation') }) }
    const notices = new MobileConnectionNotices()
    const lease = notices.claim()
    const states: MobileRemoteState[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const remote = new MobileRemoteClient({
      identityProvider: {
        deviceIdentity: async () => identity(deviceId, 9), clearUserPresence,
        requireUserPresence: async () => { await new Promise<void>((resolve) => { release = resolve }); presence = true },
      },
      onEvent: () => undefined, onSnapshot: () => undefined,
      onState: (state) => { states.push(state); lease.update({ kind: 'state', state }); throw new Error('SECRET_OBSERVER') },
      onDisconnect: (notice) => { lease.update({ kind: 'disconnect', notice }); throw new Error('SECRET_OBSERVER') },
      randomBytes: random(9), socketFactory,
      epochProvider: { nextConnectionEpoch: async (_config, epoch) => epoch, recordAuthenticatedConnection: async () => undefined },
    })
    try {
      const pending = remote.connect(config(host))
      await vi.waitFor(() => { expect(release).toBeDefined() })
      disconnectRemoteWhenBackgrounded('inactive', (reason) => { remote.disconnect(reason) })
      expect(states.map(state => state.kind)).toEqual(['connecting'])
      remote.disconnect('background')
      release?.()
      await pending
      await vi.waitFor(() => { expect(presence).toBe(false) })
      expect(socketFactory.create).not.toHaveBeenCalled()
      expect(states.map(state => state.kind)).toEqual(['connecting', 'disconnected'])
      expect(mobileConnectionView({ kind: 'disconnected' }, notices.current)).toMatchInlineSnapshot(`
        {
          "disabled": false,
          "label": "Connect to Host",
          "message": "The app reported background. The connection and authentication were cleared. Interrupted at owner-presence. Connect again to authenticate.",
        }
      `)
      expect(warn.mock.calls.flat().join(' ')).not.toContain('SECRET')
    } finally { remote.disconnect(); lease.release(); warn.mockRestore() }
  })
  it.each([
    ['owner-presence', 'presence'],
    ['identity', 'identity'],
    ['relay-open', 'socket'],
    ['hello-send', 'random'],
    ['hello-send', 'send'],
    ['host-handshake', 'receive'],
    ['host-bootstrap', 'snapshot'],
  ] as const)('reports only fixed %s diagnostics for a %s failure', async (stage, failure) => {
    const sentinel = 'SECRET_SENTINEL https://private.invalid/route-id?token=credential native-key-error'
    const fail = (): never => { throw new Error(sentinel) }
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: MobileRemoteState[] = []
    let sends = 0
    const socket: RemoteRelaySocket = {
      send(data): void {
        if (failure === 'send') fail()
        sends += 1
        deviceSocket.send(data)
      },
      close: (code, reason) =>{  deviceSocket.close(code, reason) },
      receive: (signal) => {
        if (failure === 'receive') fail()
        return deviceSocket.receive(signal)
      },
    }
    const remote = new MobileRemoteClient({
      identityProvider: {
        requireUserPresence: async () => { if (failure === 'presence') fail() },
        deviceIdentity: async () => failure === 'identity' ? fail() : device,
        clearUserPresence: () => undefined,
      },
      onEvent: () => undefined,
      onSnapshot: () => { if (failure === 'snapshot') fail() },
      onState: state => states.push(state),
      randomBytes: failure === 'random' ? fail : random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expected) => expected,
        recordAuthenticatedConnection: async () => undefined,
      },
      socketFactory: { create: async () => failure === 'socket' ? fail() : socket },
    })
    const accepting = failure === 'snapshot'
      ? hostAcceptance(hostSocket, host, device, route.connectionEpoch)
      : Promise.resolve()
    await Promise.all([remote.connect(config(host)), accepting])
    const stopped = states.at(-1)
    expect(stopped?.kind).toBe('error')
    if (stopped?.kind !== 'error') throw new Error('Missing connection diagnostic')
    expect(stopped.message).toContain(`Connection stopped at ${stage}.`)
    expect(stopped.message).toContain('You can retry.')
    expect(JSON.stringify(states)).not.toMatch(/SECRET_SENTINEL|private\.invalid|route-id|credential|native-key-error/)
    expect(sends > 0).toBe(failure === 'receive' || failure === 'snapshot')
    remote.disconnect()
  })

  it.each(['device.describe', 'session.list', 'snapshot'])('retires a stalled %s after a receipt and retries only the next committed epoch', async (stall) => {
    vi.useFakeTimers()
    try {
      const host = identity(hostDeviceId, 7)
      const device = identity(deviceId, 9)
      const [hostSocket, deviceSocket] = sockets()
      const [retryHostSocket, retryDeviceSocket] = sockets()
      const states: string[] = []
      const view: ReturnType<typeof mobileConnectionView>[] = []
      const committed: number[] = []
      let socketCalls = 0
      let snapshotCalls = 0
      let releaseSnapshot: (() => void) | undefined
      let nextEpoch = route.connectionEpoch
      const remote = new MobileRemoteClient({
        connectionTimeoutMs: 20_000,
        identityProvider: {
          deviceIdentity: async () => device,
          requireUserPresence: async () => undefined,
          clearUserPresence: () => undefined },
        onEvent: () => undefined,
        onSnapshot: () => {
          snapshotCalls += 1
          if (stall === 'snapshot' && snapshotCalls === 1) return new Promise<void>((resolve) => { releaseSnapshot = resolve })
        },
        onState: (state) => { states.push(state.kind); view.push(mobileConnectionView(state)) },
        randomBytes: random(9),
        epochProvider: {
          nextConnectionEpoch: async (_config, expected) => { expect(expected).toBe(nextEpoch); return nextEpoch },
          recordAuthenticatedConnection: async (_config, epoch) => { committed.push(epoch); nextEpoch = epoch + 1 },
        },
        socketFactory: { create: async () => socketCalls++ === 0 ? deviceSocket : retryDeviceSocket },
      })
      const accepting = acceptRemoteRelayDevice({
        socket: hostSocket,
        identity: { ...host, enrollmentId: hostEnrollmentId },
        peer: { deviceId, enrollmentId: deviceEnrollmentId, agreementPublicKey: device.agreement.publicKey },
        random: { randomBytes: random(20) },
        route,
        epochFinalizer: { finalize: async () => undefined } })
      const attempt = remote.connect(config(host))
      const accepted = await accepting
      const incoming = accepted.receive()[Symbol.asyncIterator]()
      const describe = await incoming.next()
      expect(describe.done).toBe(false)
      if (describe.done || describe.value.type !== 'device-control') throw new Error('Missing device description')
      if (stall !== 'device.describe') {
        await accepted.send({ version: 3, type: 'response', connectionEpoch: route.connectionEpoch, requestId: describe.value.requestId, result: { ok: true, value: { mode: 'replay', cursor: 0 } } }, { active: true, generation: 1, abortSignal: new AbortController().signal })
        const list = await incoming.next()
        expect(list.done).toBe(false)
        if (list.done || list.value.type !== 'request') throw new Error('Missing session list')
        if (stall === 'snapshot') await accepted.send({ version: 3, type: 'response', connectionEpoch: route.connectionEpoch, requestId: list.value.requestId, result: { ok: true, value: { items: [] } } }, { active: true, generation: 1, abortSignal: new AbortController().signal })
      }
      expect(committed).toEqual([route.connectionEpoch])
      await vi.advanceTimersByTimeAsync(20_000)
      await attempt
      expect(states).toEqual(['connecting', 'error'])
      expect(view).toMatchInlineSnapshot(`
        [
          {
            "disabled": true,
            "label": "Connecting…",
            "message": "Authenticating and loading the Host workspace…",
          },
          {
            "disabled": false,
            "label": "Retry connection",
            "message": "The encrypted Host connection timed out at host-bootstrap. You can retry.",
          },
        ]
      `)
      await expect(remote.request('session.list', {})).rejects.toThrow('not connected')
      const retryHost = hostAcceptance(retryHostSocket, host, device, route.connectionEpoch + 1)
      await Promise.all([retryHost, remote.reconnect()])
      expect(committed).toEqual([route.connectionEpoch, route.connectionEpoch + 1])
      expect(states).toEqual(['connecting', 'error', 'connecting', 'connected'])
      releaseSnapshot?.()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(states.at(-1)).toBe('connected')
      remote.disconnect()
    } finally { vi.useRealTimers() }
  })

  it('reports connected only after the real relay protocol validates Host finish', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: string[] = []
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    const remote = client(deviceSocket, device, states)
    await Promise.all([hostConnection, remote.connect(config(host))])
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('does not publish connected until device.describe and the Host snapshot are applied', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: string[] = []
    const methods: string[] = []
    let releaseSnapshot: (() => void) | undefined
    const remote = new MobileRemoteClient({
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: async () => new Promise<void>((resolve) => { releaseSnapshot = resolve }),
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => deviceSocket },
    })
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch, methods)
    const connecting = remote.connect(config(host))
    await hostConnection
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(methods).toEqual(['device.describe', 'session.list'])
    expect(states).toEqual(['connecting'])
    releaseSnapshot?.()
    await connecting
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('does not report connected until it durably records the Host receipt epoch', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: string[] = []
    const recorded: number[] = []
    const remote = new MobileRemoteClient({
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async (_config, epoch) => { recorded.push(epoch) },
      },
      socketFactory: { create: async () => deviceSocket },
    })
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    await Promise.all([hostConnection, remote.connect(config(host))])
    expect(recorded).toEqual([route.connectionEpoch])
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('closes a receipt-authenticated transport when its next epoch cannot become durable', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: string[] = []
    const remote = new MobileRemoteClient({
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => { throw new Error('Keychain write failed') },
      },
      socketFactory: { create: async () => deviceSocket },
    })
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    await Promise.allSettled([hostConnection, remote.connect(config(host))])
    expect(states).toEqual(['connecting', 'error'])
  })

  it('does not report connected when the Host encrypted commit is absent', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets('commit')
    const states: string[] = []
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    const remote = client(deviceSocket, device, states)
    await remote.connect(config(host))
    hostSocket.close()
    await Promise.allSettled([hostConnection])
    expect(states).toEqual(['connecting', 'error'])
  })

  it('does not advance the device epoch until it authenticates the Host finality receipt', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets('receipt')
    const states: string[] = []
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    const remote = client(deviceSocket, device, states)
    await remote.connect(config(host))
    hostSocket.close()
    await Promise.allSettled([hostConnection])
    expect(states).toEqual(['connecting', 'error'])
  })

  it('reconciles one Host-finalized epoch after an interrupted finality receipt', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [firstHostSocket, firstDeviceSocket] = sockets('receipt')
    const [secondHostSocket, secondDeviceSocket] = sockets()
    const states: string[] = []
    const suppliedEpochs: number[] = []
    let socketIndex = 0
    const remote = new MobileRemoteClient({
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => { suppliedEpochs.push(expectedEpoch); return expectedEpoch + 1 },
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => [firstDeviceSocket, secondDeviceSocket][socketIndex++] ?? secondDeviceSocket },
    })
    const firstHost = hostAcceptance(firstHostSocket, host, device, 2)
    await remote.connect({ ...config(host), connectionEpoch: 2 })
    firstHostSocket.close()
    await Promise.allSettled([firstHost])
    const secondHost = hostAcceptance(secondHostSocket, host, device, 3)
    await Promise.all([secondHost, remote.reconnect()])
    expect(suppliedEpochs).toEqual([2])
    expect(states).toEqual(['connecting', 'error', 'connecting', 'connected'])
  })

  it('rejects a route when its Host-minted device enrollment incarnation differs', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: string[] = []
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    const remote = client(deviceSocket, device, states)
    await Promise.allSettled([hostConnection, remote.connect({ ...config(host), deviceEnrollmentId: 'replacement_enrollment_identifier_123' })])
    expect(states).toEqual(['connecting', 'error'])
  })

  it('reconnects with the Host-provided next epoch after a verified live connection', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [firstHostSocket, firstDeviceSocket] = sockets()
    const [secondHostSocket, secondDeviceSocket] = sockets()
    const states: string[] = []
    const epochs: number[] = []
    let socketIndex = 0
    const remote = new MobileRemoteClient({
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => { epochs.push(expectedEpoch); return expectedEpoch },
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => [firstDeviceSocket, secondDeviceSocket][socketIndex++] ?? secondDeviceSocket },
    })
    const initial = { ...config(host), connectionEpoch: 2 }
    const firstHost = hostAcceptance(firstHostSocket, host, device, 2)
    const [verifiedFirstHost] = await Promise.all([firstHost, remote.connect(initial)])
    await remote.reconnect()
    expect(socketIndex).toBe(1)
    expect(states).toEqual(['connecting', 'connected'])
    verifiedFirstHost.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    const secondHost = hostAcceptance(secondHostSocket, host, device, 3)
    const [verifiedSecondHost] = await Promise.all([secondHost, remote.reconnect()])
    expect(verifiedSecondHost.route.connectionEpoch).toBe(3)
    expect(epochs).toEqual([3])
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connecting', 'connected'])
  })

  it.each(['background', 'unmount', 'manual'] as const)('aborts and physically closes a pending handshake on %s', async (reason) => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [, deviceSocket] = sockets()
    const states: string[] = []
    const onDisconnect = vi.fn()
    let abortSignal: AbortSignal | undefined
    let closed = false
    const remote = new MobileRemoteClient({
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      onDisconnect,
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: {
        create: async (_config, signal) => {
          abortSignal = signal
          return {
            ...deviceSocket,
            close: () => { closed = true; deviceSocket.close() },
          }
        },
      },
    })
    const pending = remote.connect(config(host))
    await new Promise(resolve => setTimeout(resolve, 0))
    remote.disconnect(reason)
    await pending
    expect(abortSignal?.aborted).toBe(true)
    expect(closed).toBe(true)
    expect(states).toEqual(['connecting', 'disconnected'])
    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith({ reason, stage: 'host-handshake' })
  })

  it('clears owner presence and creates no socket when disconnect wins a pending owner-presence request', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const states: string[] = []
    let releasePresence: (() => void) | undefined
    let clearCalls = 0
    let deviceIdentityCalls = 0
    let socketCalls = 0
    const remote = new MobileRemoteClient({
      identityProvider: {
        deviceIdentity: async () => { deviceIdentityCalls += 1; return device },
        requireUserPresence: async () => new Promise<void>((resolve) => { releasePresence = resolve }),
        clearUserPresence: () => { clearCalls += 1 },
      },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: {
        create: async () => {
          socketCalls += 1
          throw new Error('A cancelled owner-presence request must not open a socket')
        },
      },
    })
    const pending = remote.connect(config(host))
    await new Promise(resolve => setTimeout(resolve, 0))
    remote.disconnect()
    releasePresence?.()
    await pending
    expect(clearCalls).toBeGreaterThan(0)
    expect(deviceIdentityCalls).toBe(0)
    expect(socketCalls).toBe(0)
    expect(states).toEqual(['connecting', 'disconnected'])
  })

  it('times out a pending owner-presence request without opening a relay socket', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const states: MobileRemoteState[] = []
    let clearCalls = 0
    let deviceIdentityCalls = 0
    let socketCalls = 0
    const remote = new MobileRemoteClient({
      connectionTimeoutMs: 5,
      identityProvider: {
        deviceIdentity: async () => { deviceIdentityCalls += 1; return device },
        requireUserPresence: async () => new Promise<void>(() => undefined),
        clearUserPresence: () => { clearCalls += 1 },
      },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => { socketCalls += 1; throw new Error('Timed out presence must not open a socket') } },
    })
    await remote.connect(config(host))
    expect(clearCalls).toBeGreaterThan(0)
    expect(deviceIdentityCalls).toBe(0)
    expect(socketCalls).toBe(0)
    expect(states).toEqual([
      { kind: 'connecting' },
      { kind: 'error', message: 'The encrypted Host connection timed out at owner-presence. You can retry.' },
    ])
  })

  it('aborts a pending raw socket open and closes a late socket after its connection deadline', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [, deviceSocket] = sockets()
    const states: MobileRemoteState[] = []
    let abortSignal: AbortSignal | undefined
    let releaseSocket: ((socket: RemoteRelaySocket) => void) | undefined
    let closed = false
    const remote = new MobileRemoteClient({
      connectionTimeoutMs: 5,
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: {
        create: async (_config, signal) => {
          abortSignal = signal
          return new Promise((resolve) => { releaseSocket = resolve })
        },
      },
    })
    await remote.connect(config(host))
    releaseSocket?.({ ...deviceSocket, close: () => { closed = true; deviceSocket.close() } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(abortSignal?.aborted).toBe(true)
    expect(closed).toBe(true)
    expect(states).toEqual([
      { kind: 'connecting' },
      { kind: 'error', message: 'The encrypted Host connection timed out at relay-open. You can retry.' },
    ])
  })

  it('aborts and physically closes an opened socket when the V3 handshake stalls', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [, deviceSocket] = sockets()
    const states: MobileRemoteState[] = []
    let closed = false
    let clearCalls = 0
    const remote = new MobileRemoteClient({
      connectionTimeoutMs: 5,
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => { clearCalls += 1 },
      },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: {
        create: async () => ({ ...deviceSocket, close: () => { closed = true; deviceSocket.close() } }),
      },
    })
    await remote.connect(config(host))
    expect(clearCalls).toBeGreaterThan(0)
    expect(closed).toBe(true)
    expect(states).toEqual([
      { kind: 'connecting' },
      { kind: 'error', message: 'The encrypted Host connection timed out at host-handshake. You can retry.' },
    ])
  })

  it('does not let a superseded attempt deadline overwrite a later verified connection', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: string[] = []
    let presenceCalls = 0
    let releaseFirstPresence: (() => void) | undefined
    let clearCalls = 0
    const remote = new MobileRemoteClient({
      connectionTimeoutMs: 20,
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => {
          presenceCalls += 1
          if (presenceCalls === 1) return new Promise<void>((resolve) => { releaseFirstPresence = resolve })
        },
        clearUserPresence: () => { clearCalls += 1 },
      },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => deviceSocket },
    })
    const first = remote.connect(config(host))
    await new Promise(resolve => setTimeout(resolve, 0))
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    await Promise.all([first, remote.connect(config(host)), hostConnection])
    const clearCallsAfterConnection = clearCalls
    releaseFirstPresence?.()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(clearCalls).toBe(clearCallsAfterConnection)
    expect(states).toEqual(['connecting', 'connecting', 'connected'])
  })

  it('projects concurrent Host events once, in durable cursor order, before acknowledging them', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: string[] = []
    const projected: number[] = []
    let cursor = 0
    const remote = new MobileRemoteClient({
      cursorStore: {
        apply: async (message) => { cursor = message.cursor },
        read: async () => cursor,
        replace: async (next) => { cursor = next },
      },
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: message => projected.push(message.cursor),
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => deviceSocket },
    })
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    const [verifiedHost] = await Promise.all([hostConnection, remote.connect(config(host))])
    const fence = { active: true, generation: 1, abortSignal: new AbortController().signal }
    await Promise.all([verifiedHost.send(event(1), fence), verifiedHost.send(event(1), fence), verifiedHost.send(event(2), fence)])
    const incoming = verifiedHost.receive()[Symbol.asyncIterator]()
    const first = await incoming.next()
    const second = await incoming.next()
    expect([first.value, second.value]).toEqual([
      { version: 3, type: 'stream-ack', connectionEpoch: route.connectionEpoch, cursor: 1 },
      { version: 3, type: 'stream-ack', connectionEpoch: route.connectionEpoch, cursor: 2 },
    ])
    expect(projected).toEqual([1, 2])
    expect(cursor).toBe(2)
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('retires the source transport on a Host event cursor gap instead of remaining connected', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: string[] = []
    const remote = new MobileRemoteClient({
      cursorStore: { apply: async () => undefined, read: async () => 0, replace: async () => undefined },
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => deviceSocket },
    })
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    const [verifiedHost] = await Promise.all([hostConnection, remote.connect(config(host))])
    await verifiedHost.send(event(2), { active: true, generation: 1, abortSignal: new AbortController().signal })
    const closed = await verifiedHost.receive()[Symbol.asyncIterator]().next()
    expect(closed.done).toBe(true)
    expect(states).toEqual(['connecting', 'connected', 'reconnecting'])
    await expect(remote.request('session.list', {})).rejects.toThrow('not connected')
  })

  it('retires the source transport when its durable event cursor write fails', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: string[] = []
    const remote = new MobileRemoteClient({
      cursorStore: { apply: async () => { throw new Error('Keychain unavailable') }, read: async () => 0, replace: async () => undefined },
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => deviceSocket },
    })
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    const [verifiedHost] = await Promise.all([hostConnection, remote.connect(config(host))])
    await verifiedHost.send(event(1), { active: true, generation: 1, abortSignal: new AbortController().signal })
    const closed = await verifiedHost.receive()[Symbol.asyncIterator]().next()
    expect(closed.done).toBe(true)
    expect(states).toEqual(['connecting', 'connected', 'reconnecting'])
    await expect(remote.request('session.list', {})).rejects.toThrow('not connected')
  })

  it('replaces a stale mobile cursor and projection when a restarted Host returns a snapshot', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [firstHostSocket, firstDeviceSocket] = sockets()
    const [secondHostSocket, secondDeviceSocket] = sockets()
    const states: string[] = []
    const snapshots: RemoteWireJson[] = []
    const projected: number[] = []
    let cursor = 9
    let socketIndex = 0
    const remote = new MobileRemoteClient({
      cursorStore: {
        apply: async (message) => { cursor = message.cursor },
        read: async () => cursor,
        replace: async (next) => { cursor = next },
      },
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: message => projected.push(message.cursor),
      onSnapshot: (value) => { snapshots.push(value) },
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => [firstDeviceSocket, secondDeviceSocket][socketIndex++] ?? secondDeviceSocket },
    })
    const firstHost = hostAcceptance(firstHostSocket, host, device, 2)
    const [verifiedFirstHost] = await Promise.all([firstHost, remote.connect({ ...config(host), connectionEpoch: 2 })])
    verifiedFirstHost.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    const baseline = { mode: 'snapshot', cursor: 0, snapshot: { sessions: { items: [{ sessionId: 'session_identifier_123456', running: false }] } } } as const
    const secondHost = hostAcceptance(secondHostSocket, host, device, 3, undefined, baseline)
    const [verifiedSecondHost] = await Promise.all([secondHost, remote.reconnect()])
    expect(snapshots).toContainEqual(baseline.snapshot)
    expect(cursor).toBe(0)
    await verifiedSecondHost.send(event(1, 3), { active: true, generation: 1, abortSignal: new AbortController().signal })
    const acknowledgement = await verifiedSecondHost.receive()[Symbol.asyncIterator]().next()
    expect(acknowledgement.value).toEqual({ version: 3, type: 'stream-ack', connectionEpoch: 3, cursor: 1 })
    expect(projected).toEqual([1])
    expect(cursor).toBe(1)
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connecting', 'connected'])
  })

  it('keeps the live projection through a transient replay-mode reconnect', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [firstHostSocket, firstDeviceSocket] = sockets()
    const [secondHostSocket, secondDeviceSocket] = sockets()
    const states: string[] = []
    let socketIndex = 0
    let projection = ['initial']
    let baselineCalls = 0
    const remote = new MobileRemoteClient({
      cursorStore: { apply: async () => undefined, read: async () => 4, replace: async () => undefined },
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: () => { projection = [...projection, 'session-list'] },
      onBaselineSnapshot: () => { baselineCalls += 1; projection = [] },
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => [firstDeviceSocket, secondDeviceSocket][socketIndex++] ?? secondDeviceSocket },
    })
    const firstHost = hostAcceptance(firstHostSocket, host, device, 2)
    const [verifiedFirstHost] = await Promise.all([firstHost, remote.connect({ ...config(host), connectionEpoch: 2 })])
    projection = ['replayed-message', 'replayed-tool']
    verifiedFirstHost.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    const secondHost = hostAcceptance(secondHostSocket, host, device, 3)
    await Promise.all([secondHost, remote.reconnect()])
    expect(baselineCalls).toBe(0)
    expect(projection).toEqual(['replayed-message', 'replayed-tool', 'session-list'])
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connecting', 'connected'])
  })

  it('never acknowledges a delayed old-transport event through its replacement transport', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [firstHostSocket, firstDeviceSocket] = sockets()
    const [secondHostSocket, secondDeviceSocket] = sockets()
    const states: string[] = []
    let socketIndex = 0
    let releaseApply: (() => void) | undefined
    let startedApply: (() => void) | undefined
    const applying = new Promise<void>((resolve) => { startedApply = resolve })
    const remote = new MobileRemoteClient({
      cursorStore: {
        apply: async () => new Promise<void>((resolve) => { releaseApply = resolve; startedApply?.() }),
        read: async () => 0,
        replace: async () => undefined,
      },
      identityProvider: {
        deviceIdentity: async () => device,
        requireUserPresence: async () => undefined,
        clearUserPresence: () => undefined },
      onEvent: () => undefined,
      onSnapshot: () => undefined,
      onState: state => states.push(state.kind),
      randomBytes: random(9),
      epochProvider: {
        nextConnectionEpoch: async (_config, expectedEpoch) => expectedEpoch,
        recordAuthenticatedConnection: async () => undefined },
      socketFactory: { create: async () => [firstDeviceSocket, secondDeviceSocket][socketIndex++] ?? secondDeviceSocket },
    })
    const firstHost = hostAcceptance(firstHostSocket, host, device, 2)
    const [verifiedFirstHost] = await Promise.all([firstHost, remote.connect({ ...config(host), connectionEpoch: 2 })])
    await verifiedFirstHost.send(event(1, 2), { active: true, generation: 1, abortSignal: new AbortController().signal })
    await applying
    verifiedFirstHost.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    const secondHost = hostAcceptance(secondHostSocket, host, device, 3)
    const [verifiedSecondHost] = await Promise.all([secondHost, remote.reconnect()])
    releaseApply?.()
    const iterator = verifiedSecondHost.receive()[Symbol.asyncIterator]()
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<RemoteWireEnvelope>>(resolve => setTimeout(() =>{  resolve({ done: true, value: undefined }) }, 10)),
    ])
    expect(next.done).toBe(true)
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connecting', 'connected'])
  })

  it('matches a response only through the verified Host connection', async () => {
    const host = identity(hostDeviceId, 7)
    const device = identity(deviceId, 9)
    const [hostSocket, deviceSocket] = sockets()
    const states: string[] = []
    const hostConnection = hostAcceptance(hostSocket, host, device, route.connectionEpoch)
    const remote = client(deviceSocket, device, states)
    const [verifiedHost] = await Promise.all([hostConnection, remote.connect(config(host))])
    const pending = remote.request('session.list', {})
    const incoming = await verifiedHost.receive()[Symbol.asyncIterator]().next()
    if (incoming.done || incoming.value.type !== 'request') throw new Error('Expected encrypted Host request')
    await verifiedHost.send(
      { version: 3, type: 'response', connectionEpoch: route.connectionEpoch, requestId: incoming.value.requestId, result: { ok: true, value: { items: [] } } },
      { active: true, generation: 1, abortSignal: new AbortController().signal },
    )
    await expect(pending).resolves.toEqual({ ok: true, value: { items: [] } })
    expect(states).toEqual(['connecting', 'connected'])
  })
})
