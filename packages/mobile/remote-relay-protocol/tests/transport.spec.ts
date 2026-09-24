import { x25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import {
  acceptRemoteRelayDevice,
  connectRemoteRelayDevice,
  parseRemoteRelayMessage,
  RemoteRelayProtocolError,
} from '@deepseek-ai/dsh-remote-relay-protocol'
import type {
  RemoteRelayIdentity,
  RemoteRelayPeerIdentity,
  RemoteRelayRandomSource,
  RemoteRelaySocket,
} from '@deepseek-ai/dsh-remote-relay-protocol'

const HOST_ID = 'host_device_identifier_123'
const DEVICE_ID = 'device_identifier_123'
const HOST_ENROLLMENT_ID = 'host_enrollment_identifier_123'
const DEVICE_ENROLLMENT_ID = 'device_enrollment_identifier_123'
const ROUTE = { routeId: 'remote_route_identifier_123', generation: 1, connectionEpoch: 7 }

class Queue {
  private readonly values: string[] = []
  private waiter: ((value: IteratorResult<string>) => void) | undefined
  private closed = false

  push(value: string): void {
    if (this.closed) return
    const waiter = this.waiter
    if (waiter !== undefined) {
      this.waiter = undefined
      waiter({ done: false, value })
      return
    }
    this.values.push(value)
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

function sockets(trace?: string[], dropType?: string): readonly [RemoteRelaySocket, RemoteRelaySocket] {
  const left = new Queue()
  const right = new Queue()
  const side = (inbound: Queue, outbound: Queue): RemoteRelaySocket => ({
    send(data): void {
      const parsed: unknown = JSON.parse(data)
      if (typeof parsed !== 'object' || parsed === null || !('type' in parsed) || typeof parsed.type !== 'string') {
        throw new Error('expected typed transport frame')
      }
      const type = parsed.type
      trace?.push(type)
      if (dropType === type) return
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

function random(seed: number): RemoteRelayRandomSource {
  let value = seed
  return {
    randomBytes(length): Uint8Array {
      const result = new Uint8Array(length)
      for (let index = 0; index < length; index += 1) {
        value = (value * 1_103_515_245 + 12_345) >>> 0
        result[index] = value & 0xff
      }
      return result
    },
  }
}

function identity(deviceId: string, enrollmentId: string, fill: number): RemoteRelayIdentity {
  const secret = new Uint8Array(32).fill(fill)
  return {
    deviceId,
    enrollmentId,
    agreement: {
      publicKey: encode(x25519.getPublicKey(secret)),
      deriveSharedSecret(peerAgreementPublicKey): Uint8Array {
        return x25519.getSharedSecret(secret, decode(peerAgreementPublicKey))
      },
    },
  }
}

function publicIdentity(value: RemoteRelayIdentity): RemoteRelayPeerIdentity {
  return { deviceId: value.deviceId, enrollmentId: value.enrollmentId, agreementPublicKey: value.agreement.publicKey }
}

function encode(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decode(value: string): Uint8Array {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4))
  return Uint8Array.from(binary, byte => byte.charCodeAt(0))
}

function request(): Record<string, unknown> {
  return {
    version: 3, type: 'request', connectionEpoch: 7,
    requestId: 'request_identifier_123', idempotencyKey: 'idempotency_identifier_123',
    method: 'session.prompt', payload: { sessionId: 'session_identifier_123', content: [{ type: 'text', text: 'remote' }] },
  }
}

async function next<T>(iterator: AsyncIterator<T>): Promise<T> {
  const value = await iterator.next()
  if (value.done) throw new Error('Expected remote transport message')
  return value.value
}

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteRelayProtocolError)
    return (error as RemoteRelayProtocolError).code
  }
  throw new Error('Expected remote relay rejection')
}

function activeFence() {
  return { active: true, generation: 1, abortSignal: new AbortController().signal }
}

const epochFinalizer = { finalize: async (): Promise<void> => undefined }

function accept(input: Omit<Parameters<typeof acceptRemoteRelayDevice>[0], 'epochFinalizer'>) {
  return acceptRemoteRelayDevice({ ...input, epochFinalizer })
}

function probeSocket(): { readonly socket: RemoteRelaySocket; readonly closeCount: () => number } {
  let closes = 0
  return {
    socket: {
      send(): void {},
      close(): void { closes += 1 },
      async *receive(): AsyncIterable<string> {},
    },
    closeCount: (): number => closes,
  }
}

describe('trusted remote relay v3 transport', () => {
  it('mutually authenticates enrolled static identities, then carries only encrypted strict remote-wire envelopes', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const trace: string[] = []
    const [hostSocket, deviceSocket] = sockets(trace)
    const hostConnection = accept({
      socket: hostSocket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10),
    })
    const deviceConnection = connectRemoteRelayDevice({
      socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20),
    })
    const [accepted, connected] = await Promise.all([hostConnection, deviceConnection])
    expect(accepted.deviceId).toBe(DEVICE_ID)
    expect(await connected.send(request() as never, activeFence())).toEqual({ status: 'committed-before-fence' })
    expect(trace.indexOf('commit')).toBeLessThan(trace.indexOf('ciphertext'))
    expect(await next(accepted.receive()[Symbol.asyncIterator]())).toMatchObject({
      type: 'request', method: 'session.prompt', connectionEpoch: 7,
    })
  })

  it('finalizes the Host epoch only after the encrypted device confirmation and before its receipt', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const trace: string[] = []
    const finalized: number[] = []
    const [hostSocket, deviceSocket] = sockets(trace)
    const accepting = acceptRemoteRelayDevice({
      socket: hostSocket,
      identity: host,
      peer: publicIdentity(device),
      route: ROUTE,
      random: random(10),
      epochFinalizer: { finalize: async (route): Promise<void> => { finalized.push(route.connectionEpoch) } },
    })
    const connecting = connectRemoteRelayDevice({
      socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20),
    })
    await Promise.all([accepting, connecting])
    expect(finalized).toEqual([ROUTE.connectionEpoch])
    expect(trace.indexOf('confirm')).toBeLessThan(trace.indexOf('receipt'))
  })

  it('does not invoke the Host epoch finalizer when the device confirmation is lost', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const finalized: number[] = []
    const controller = new AbortController()
    const [hostSocket, deviceSocket] = sockets(undefined, 'confirm')
    const accepting = acceptRemoteRelayDevice({
      socket: hostSocket,
      signal: controller.signal,
      identity: host,
      peer: publicIdentity(device),
      route: ROUTE,
      random: random(10),
      epochFinalizer: { finalize: async (route): Promise<void> => { finalized.push(route.connectionEpoch) } },
    })
    const connecting = connectRemoteRelayDevice({
      socket: deviceSocket, signal: controller.signal, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20),
    })
    await Promise.resolve()
    controller.abort()
    await expect(Promise.all([accepting, connecting])).rejects.toMatchObject({ code: 'REMOTE_RELAY_SOCKET_CLOSED' })
    expect(finalized).toEqual([])
  })

  it('does not send a receipt after cancellation races with durable epoch finalization', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const trace: string[] = []
    const controller = new AbortController()
    const [hostSocket, deviceSocket] = sockets(trace)
    const accepting = acceptRemoteRelayDevice({
      socket: hostSocket,
      signal: controller.signal,
      identity: host,
      peer: publicIdentity(device),
      route: ROUTE,
      random: random(10),
      epochFinalizer: { finalize: async (): Promise<void> => { controller.abort() } },
    })
    const connecting = connectRemoteRelayDevice({
      socket: deviceSocket, signal: controller.signal, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20),
    })
    await expect(Promise.all([accepting, connecting])).rejects.toMatchObject({ code: 'REMOTE_RELAY_SOCKET_CLOSED' })
    expect(trace).not.toContain('receipt')
  })

  it('rejects a different static client identity before exposing a Host connection', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const enrolled = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const impostor = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 12)
    const [hostSocket, deviceSocket] = sockets()
    const accepted = accept({
      socket: hostSocket, identity: host, peer: publicIdentity(enrolled), route: ROUTE, random: random(10),
    })
    const connected = connectRemoteRelayDevice({
      socket: deviceSocket, identity: impostor, host: publicIdentity(host), route: ROUTE, random: random(20),
    })
    await expect(Promise.all([accepted, connected])).rejects.toMatchObject({ code: 'REMOTE_RELAY_DECRYPT_FAILED' })
  })

  it('rejects a stale enrollment incarnation even when the device id and agreement key match', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const enrolled = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const stale = identity(DEVICE_ID, 'device_enrollment_stale_123', 9)
    const [hostSocket, deviceSocket] = sockets()
    const accepted = accept({ socket: hostSocket, identity: host, peer: publicIdentity(enrolled), route: ROUTE, random: random(10) })
    const connected = connectRemoteRelayDevice({
      socket: deviceSocket, identity: stale, host: publicIdentity(host), route: ROUTE, random: random(20),
    })
    await expect(Promise.all([accepted, connected])).rejects.toMatchObject({ code: 'REMOTE_RELAY_PEER_INVALID' })
  })

  it('does not expose the device connection until the encrypted Host commit arrives', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const [hostSocket, deviceSocket] = sockets(undefined, 'commit')
    const accepted = accept({
      socket: hostSocket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10),
    })
    const connecting = connectRemoteRelayDevice({
      socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20),
    })
    let settled = false
    void connecting.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    hostSocket.close()
    await expect(Promise.all([accepted, connecting])).rejects.toMatchObject({ code: 'REMOTE_RELAY_SOCKET_CLOSED' })
  })

  it('does not expose the Host connection until it validates the device encrypted acknowledgement', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const [hostSocket, deviceSocket] = sockets(undefined, 'ack')
    const accepted = accept({ socket: hostSocket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10) })
    const connecting = connectRemoteRelayDevice({
      socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20),
    })
    let settled = false
    void accepted.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    deviceSocket.close()
    await expect(Promise.all([accepted, connecting])).rejects.toMatchObject({ code: 'REMOTE_RELAY_SOCKET_CLOSED' })
  })

  it.each(['hello', 'welcome', 'ready', 'finish', 'ack', 'commit', 'confirm', 'receipt'])('aborts a pending handshake at the %s flight', async (dropType) => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const controller = new AbortController()
    const [hostSocket, deviceSocket] = sockets(undefined, dropType)
    const accepted = accept({
      socket: hostSocket, signal: controller.signal, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10),
    })
    const connecting = connectRemoteRelayDevice({
      socket: deviceSocket, signal: controller.signal, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20),
    })
    await Promise.resolve()
    controller.abort()
    await expect(Promise.all([accepted, connecting])).rejects.toMatchObject({ code: 'REMOTE_RELAY_SOCKET_CLOSED' })
  })

  it('closes an opened device socket when its local identity is invalid before hello', async () => {
    const probe = probeSocket()
    await expect(connectRemoteRelayDevice({
      socket: probe.socket,
      identity: identity('bad', DEVICE_ENROLLMENT_ID, 9),
      host: publicIdentity(identity(HOST_ID, HOST_ENROLLMENT_ID, 7)),
      route: ROUTE,
      random: random(20),
    })).rejects.toMatchObject({ code: 'REMOTE_RELAY_ID_INVALID' })
    expect(probe.closeCount()).toBe(1)
  })

  it('closes an opened Host socket when its peer identity is invalid before hello', async () => {
    const probe = probeSocket()
    await expect(accept({
      socket: probe.socket,
      identity: identity(HOST_ID, HOST_ENROLLMENT_ID, 7),
      peer: { ...publicIdentity(identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)), deviceId: 'bad' },
      route: ROUTE,
      random: random(10),
    })).rejects.toMatchObject({ code: 'REMOTE_RELAY_ID_INVALID' })
    expect(probe.closeCount()).toBe(1)
  })

  it('closes and wipes an invalid provider RNG buffer before opening a handshake', async () => {
    const probe = probeSocket()
    const providerBuffer = new Uint8Array(31).fill(7)
    const invalidRandom: RemoteRelayRandomSource = { randomBytes: (): Uint8Array => providerBuffer }
    await expect(connectRemoteRelayDevice({
      socket: probe.socket,
      identity: identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9),
      host: publicIdentity(identity(HOST_ID, HOST_ENROLLMENT_ID, 7)),
      route: ROUTE,
      random: invalidRandom,
    })).rejects.toMatchObject({ code: 'REMOTE_RELAY_KEY_INVALID' })
    expect(probe.closeCount()).toBe(1)
    expect(providerBuffer.every(value => value === 0)).toBe(true)
  })

  it('rejects malformed and replay-unsafe opaque frames before any relay may forward them', () => {
    expect(code(() => parseRemoteRelayMessage(JSON.stringify({
      version: 3, type: 'ciphertext', routeId: ROUTE.routeId, generation: 1, connectionEpoch: 7,
      senderDeviceId: DEVICE_ID, senderEnrollmentId: DEVICE_ENROLLMENT_ID,
      recipientDeviceId: HOST_ID, recipientEnrollmentId: HOST_ENROLLMENT_ID, sequence: 0,
      nonce: encode(new Uint8Array(12)), ciphertext: encode(new Uint8Array(17)),
    })))).toBe('REMOTE_RELAY_SEQUENCE_INVALID')
    expect(code(() => parseRemoteRelayMessage(JSON.stringify({
      version: 3, type: 'hello', routeId: ROUTE.routeId, generation: 1, connectionEpoch: 7,
      senderDeviceId: DEVICE_ID, senderEnrollmentId: DEVICE_ENROLLMENT_ID, recipientDeviceId: HOST_ID, recipientEnrollmentId: HOST_ENROLLMENT_ID, ephemeralPublicKey: 'AA', nonce: 'AA', extra: true,
    })))).toBe('REMOTE_RELAY_MALFORMED')
  })

  it('does not commit a frame once its close fence is inactive', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const [hostSocket, deviceSocket] = sockets()
    const [accepted, connected] = await Promise.all([
      accept({ socket: hostSocket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10) }),
      connectRemoteRelayDevice({ socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20) }),
    ])
    const controller = new AbortController()
    controller.abort()
    expect(await connected.send(request() as never, { active: false, generation: 1, abortSignal: controller.signal })).toEqual({ status: 'not-committed' })
    accepted.close()
  })
})
