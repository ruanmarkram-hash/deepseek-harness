import { x25519 } from '@noble/curves/ed25519.js'
import * as ciphers from '@noble/ciphers/chacha.js'
import * as hashes from '@noble/hashes/hkdf.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRemoteWireEnvelope } from '@deepseek-ai/dsh-remote-wire'
import {
  acceptRemoteRelayDevice,
  connectRemoteRelayDevice,
  parseRemoteRelayMessage,
  RemoteRelayProtocolError,
  serializeRemoteRelayMessage,
  isRemoteRelayProtocolError,
  MAX_REMOTE_RELAY_CIPHERTEXT_BYTES,
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

vi.mock('@noble/ciphers/chacha.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/ciphers/chacha.js')>()
  return { ...actual, chacha20poly1305: vi.fn(actual.chacha20poly1305) }
})
vi.mock('@noble/curves/ed25519.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/curves/ed25519.js')>()
  return { ...actual, x25519: {
    ...actual.x25519, getSharedSecret: vi.fn(actual.x25519.getSharedSecret), getPublicKey: vi.fn(actual.x25519.getPublicKey),
  } }
})
vi.mock('@noble/hashes/hkdf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/hashes/hkdf.js')>()
  return { ...actual, hkdf: vi.fn(actual.hkdf) }
})
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

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

function sockets(
  trace?: string[], dropType?: string, transform: (data: string) => string = value => value,
): readonly [RemoteRelaySocket, RemoteRelaySocket] {
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
      outbound.push(transform(data))
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
  it('fences queued and post-encryption sends, closes failed writes, and drains closed receives', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const [hostSocket, deviceSocket] = sockets()
    const [accepted, connected] = await Promise.all([
      accept({ socket: hostSocket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10) }),
      connectRemoteRelayDevice({ socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20) }),
    ])
    const controller = new AbortController()
    controller.abort()
    expect(await connected.send(parseRemoteWireEnvelope(request()), { active: true, generation: 1, abortSignal: controller.signal })).toEqual({ status: 'not-committed' })
    const queuedFence = activeFence()
    const queued = connected.send(parseRemoteWireEnvelope(request()), queuedFence)
    queuedFence.generation += 1
    expect(await queued).toEqual({ status: 'not-committed' })
    const lateFence = activeFence()
    const actual = await vi.importActual<typeof import('@noble/ciphers/chacha.js')>('@noble/ciphers/chacha.js')
    vi.spyOn(ciphers, 'chacha20poly1305').mockImplementationOnce((...args) => {
      lateFence.active = false
      return actual.chacha20poly1305(...args)
    })
    expect(await connected.send(parseRemoteWireEnvelope(request()), lateFence)).toEqual({ status: 'not-committed' })
    expect(await connected.send(parseRemoteWireEnvelope(request()), activeFence())).toEqual({ status: 'committed-before-fence' })
    const iterator = accepted.receive()[Symbol.asyncIterator]()
    expect(await next(iterator)).toMatchObject({ type: 'request' })
    expect(await connected.send(parseRemoteWireEnvelope(request()), activeFence())).toEqual({ status: 'committed-before-fence' })
    accepted.close()
    expect(await iterator.next()).toMatchObject({ done: true })
    accepted.close('idempotent')
    vi.spyOn(deviceSocket, 'send').mockImplementationOnce(() => { throw new Error('write failure') })
    expect(await connected.send(parseRemoteWireEnvelope(request()), activeFence())).toEqual({ status: 'not-committed' })
    expect(await connected.send(parseRemoteWireEnvelope(request()), activeFence())).toEqual({ status: 'not-committed' })
  })

  it('rejects post-handshake wrong types, replay, tampering and plaintext epoch mismatch', async () => {
    for (const mode of ['type', 'replay', 'tamper', 'epoch', 'end']) {
      const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
      const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
      const [hostSocket, deviceSocket] = sockets(undefined, undefined, (raw) => {
        const message = parseRemoteRelayMessage(raw)
        if (message.type !== 'ciphertext') return raw
        if (mode === 'type') {
          const { sequence: _sequence, ...proof } = message
          return serializeRemoteRelayMessage({ ...proof, type: 'ready' })
        }
        if (mode === 'replay') return serializeRemoteRelayMessage({ ...message, sequence: 2 })
        if (mode === 'tamper') return serializeRemoteRelayMessage({ ...message, ciphertext: encode(new Uint8Array(17)) })
        return raw
      })
      const [accepted, connected] = await Promise.all([
        accept({ socket: hostSocket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10) }),
        connectRemoteRelayDevice({ socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20) }),
      ])
      if (mode === 'end') {
        connected.close()
        expect(await accepted.receive()[Symbol.asyncIterator]().next()).toMatchObject({ done: true })
      } else {
        expect(await connected.send(parseRemoteWireEnvelope({ ...request(), connectionEpoch: mode === 'epoch' ? 8 : 7 }), activeFence())).toEqual({ status: 'committed-before-fence' })
        const expected = { type: 'REMOTE_RELAY_HANDSHAKE_INVALID', replay: 'REMOTE_RELAY_REPLAY', tamper: 'REMOTE_RELAY_DECRYPT_FAILED', epoch: 'REMOTE_RELAY_EPOCH_INVALID' }[mode]
        await expect(accepted.receive()[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: expected })
        connected.close()
      }
    }
  })

  it('observes an already-aborted handshake and an abort racing iterator creation', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    for (const early of [true, false]) {
      const controller = new AbortController()
      if (early) controller.abort()
      const socket: RemoteRelaySocket = {
        send(): void {}, close(): void {},
        receive() {
          return { [Symbol.asyncIterator]() { return {
            next(): Promise<IteratorResult<string>> { controller.abort(); return new Promise(() => {}) },
          } } }
        },
      }
      await expect(accept({ socket, signal: controller.signal, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10) })).rejects.toMatchObject({ code: 'REMOTE_RELAY_SOCKET_CLOSED' })
    }
  })
  it('rejects authenticated incorrect handshake labels at all six proof flights', async () => {
    const actual = await vi.importActual<typeof import('@noble/ciphers/chacha.js')>('@noble/ciphers/chacha.js')
    for (const flight of ['ready', 'finish', 'ack', 'commit', 'confirm', 'receipt']) {
      for (const replacement of ['x', `dsh-remote/v3/${flight}extra`]) {
        vi.mocked(ciphers.chacha20poly1305).mockImplementation((...args) => {
          const cipher = actual.chacha20poly1305(...args)
          return { ...cipher, encrypt(plaintext) {
            const text = new TextDecoder().decode(plaintext)
            return cipher.encrypt(text === `dsh-remote/v3/${flight}` ? new TextEncoder().encode(replacement) : plaintext)
          } }
        })
        const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
        const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
        const [hostSocket, deviceSocket] = sockets()
        const results = await Promise.allSettled([
          accept({ socket: hostSocket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10) }),
          connectRemoteRelayDevice({
            socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20),
          }),
        ])
        expect(results.some(result => result.status === 'rejected' && isRemoteRelayProtocolError(result.reason) && result.reason.code === 'REMOTE_RELAY_HANDSHAKE_INVALID')).toBe(true)
      }
    }
  })

  it('closes on provider key failures, zero shared secrets and cryptographic exceptions', async () => {
    const actualCurves = await vi.importActual<typeof import('@noble/curves/ed25519.js')>('@noble/curves/ed25519.js')
    const actualCiphers = await vi.importActual<typeof import('@noble/ciphers/chacha.js')>('@noble/ciphers/chacha.js')
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const publicHost = publicIdentity(host)
    const invalidProvider = { ...host, agreement: { ...host.agreement } }
    Object.defineProperty(invalidProvider.agreement, 'deriveSharedSecret', { value: undefined })
    for (const candidate of [invalidProvider, { ...host, agreement: { ...host.agreement, publicKey: 'AA' } }]) {
      await expect(accept({ socket: probeSocket().socket, identity: candidate, peer: publicIdentity(device), route: ROUTE, random: random(10) })).rejects.toMatchObject({ code: 'REMOTE_RELAY_KEY_INVALID' })
    }
    await expect(connectRemoteRelayDevice({ socket: probeSocket().socket, identity: device, host: { ...publicHost, agreementPublicKey: 'AA' }, route: ROUTE, random: random(20) })).rejects.toMatchObject({ code: 'REMOTE_RELAY_KEY_INVALID' })
    const invalidRandom = random(10)
    Object.defineProperty(invalidRandom, 'randomBytes', { value: () => undefined })
    for (const randomSource of [invalidRandom, { randomBytes: (): Uint8Array => { throw new Error('provider detail') } }]) {
      const socket = { ...probeSocket().socket, close(): void { throw new Error('close detail') } }
      await expect(accept({ socket, identity: host, peer: publicIdentity(device), route: ROUTE, random: randomSource })).rejects.toMatchObject({ code: 'REMOTE_RELAY_KEY_INVALID' })
    }
    vi.spyOn(x25519, 'getPublicKey').mockImplementationOnce(() => { throw new Error('provider detail') })
    await expect(accept({ socket: probeSocket().socket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10) })).rejects.toMatchObject({ code: 'REMOTE_RELAY_KEY_INVALID' })
    for (const setup of [
      () => { vi.spyOn(host.agreement, 'deriveSharedSecret').mockImplementationOnce(() => { throw new Error('provider detail') }) },
      () => { vi.spyOn(host.agreement, 'deriveSharedSecret').mockReturnValueOnce(new Uint8Array(1)) },
      () => { vi.spyOn(host.agreement, 'deriveSharedSecret').mockReturnValueOnce(new Uint8Array(32)) },
      () => { vi.spyOn(x25519, 'getSharedSecret').mockImplementationOnce(() => { throw new Error('provider detail') }) },
      () => {
        vi.spyOn(x25519, 'getSharedSecret')
          .mockImplementationOnce(actualCurves.x25519.getSharedSecret)
          .mockImplementationOnce(actualCurves.x25519.getSharedSecret)
          .mockReturnValueOnce(new Uint8Array(32))
      },
      () => {
        vi.spyOn(x25519, 'getSharedSecret')
          .mockImplementationOnce(actualCurves.x25519.getSharedSecret)
          .mockImplementationOnce(actualCurves.x25519.getSharedSecret)
          .mockImplementationOnce(() => { throw new Error('provider detail') })
      },
      () => { vi.spyOn(hashes, 'hkdf').mockImplementationOnce(() => { throw new Error('provider detail') }) },
      () => { vi.spyOn(ciphers, 'chacha20poly1305').mockImplementationOnce(() => { throw new Error('provider detail') }) },
      () => {
        vi.spyOn(ciphers, 'chacha20poly1305').mockImplementationOnce((...args) => ({
          ...actualCiphers.chacha20poly1305(...args), encrypt: () => new Uint8Array(MAX_REMOTE_RELAY_CIPHERTEXT_BYTES + 1),
        }))
      },
    ]) {
      setup()
      const [hostSocket, deviceSocket] = sockets()
      const results = await Promise.allSettled([
        accept({ socket: hostSocket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10) }),
        connectRemoteRelayDevice({ socket: deviceSocket, identity: device, host: publicHost, route: ROUTE, random: random(20) }),
      ])
      expect(results.every(result => result.status === 'rejected')).toBe(true)
      vi.restoreAllMocks()
    }
  })

  it('rechecks changing JavaScript provider keys and the final serialized message size', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const peer = publicIdentity(device)
    let reads = 0
    Object.defineProperty(peer, 'agreementPublicKey', { get: () => ++reads === 1 ? device.agreement.publicKey : 'AA' })
    vi.spyOn(host.agreement, 'deriveSharedSecret').mockImplementation(() => new Uint8Array(32).fill(7))
    const [hostSocket, deviceSocket] = sockets()
    const results = await Promise.allSettled([
      accept({ socket: hostSocket, identity: host, peer, route: ROUTE, random: random(10) }),
      connectRemoteRelayDevice({ socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20) }),
    ])
    expect(results.some(result => result.status === 'rejected' && isRemoteRelayProtocolError(result.reason) && result.reason.code === 'REMOTE_RELAY_KEY_INVALID')).toBe(true)
    const hello = {
      version: 3, type: 'hello', ...ROUTE,
      senderDeviceId: DEVICE_ID, senderEnrollmentId: DEVICE_ENROLLMENT_ID,
      recipientDeviceId: HOST_ID, recipientEnrollmentId: HOST_ENROLLMENT_ID,
      ephemeralPublicKey: encode(new Uint8Array(32)), nonce: encode(new Uint8Array(12)),
    }
    let nonceReads = 0
    Object.defineProperty(hello, 'nonce', {
      get: () => ++nonceReads === 1 ? encode(new Uint8Array(12)) : 'x'.repeat(MAX_REMOTE_RELAY_CIPHERTEXT_BYTES * 2),
    })
    expect(() => serializeRemoteRelayMessage(hello)).toThrow('REMOTE_RELAY_CIPHERTEXT_INVALID')
    expect(nonceReads).toBe(2)
  })
  it('rejects malformed scalar, size, encoding and exact-key boundaries for every flight', () => {
    const common = {
      version: 3, ...ROUTE, senderDeviceId: DEVICE_ID, senderEnrollmentId: DEVICE_ENROLLMENT_ID,
      recipientDeviceId: HOST_ID, recipientEnrollmentId: HOST_ENROLLMENT_ID,
    }
    const hello = { ...common, type: 'hello', ephemeralPublicKey: encode(new Uint8Array(32)), nonce: encode(new Uint8Array(12)) }
    expect(isRemoteRelayProtocolError(new RemoteRelayProtocolError('REMOTE_RELAY_MALFORMED'))).toBe(true)
    expect(isRemoteRelayProtocolError(new Error('ordinary'))).toBe(false)
    for (const value of [null, 1, '{', 'null', '[]', 'x'.repeat(12_000_000)]) {
      expect(() => parseRemoteRelayMessage(value)).toThrow(RemoteRelayProtocolError)
    }
    expect(() => parseRemoteRelayMessage('漢'.repeat(MAX_REMOTE_RELAY_CIPHERTEXT_BYTES))).toThrow('REMOTE_RELAY_CIPHERTEXT_INVALID')
    for (const value of [null, [], { ...hello, version: 2 }, { ...hello, type: 1 }, { ...hello, type: 'future' }, { ...hello, routeId: null }, { ...hello, generation: 0 }, { ...hello, connectionEpoch: 0 }, { ...hello, senderDeviceId: null }]) expect(() => serializeRemoteRelayMessage(value)).toThrow(RemoteRelayProtocolError)
    for (const value of [null, '%', 'A', 'AB', encode(new Uint8Array(33)), 'AA']) expect(() => serializeRemoteRelayMessage({ ...hello, ephemeralPublicKey: value })).toThrow(RemoteRelayProtocolError)
    expect(() => serializeRemoteRelayMessage({ ...hello, nonce: 'AA' })).toThrow('REMOTE_RELAY_KEY_INVALID')
    for (const type of ['ready', 'finish', 'ack', 'commit', 'confirm', 'receipt', 'ciphertext']) {
      const value = { ...common, type, nonce: hello.nonce, ciphertext: encode(new Uint8Array(17)), ...(type === 'ciphertext' ? { sequence: 1 } : {}) }
      expect(parseRemoteRelayMessage(serializeRemoteRelayMessage(value))).toEqual(value)
      for (const invalid of [{ ...value, extra: true }, { ...value, nonce: 'AA' }, { ...value, ciphertext: 'AA' }, { ...value, ciphertext: encode(new Uint8Array(type === 'ciphertext' ? MAX_REMOTE_RELAY_CIPHERTEXT_BYTES + 1 : 513)) }]) expect(() => serializeRemoteRelayMessage(invalid)).toThrow(RemoteRelayProtocolError)
    }
  })

  it('refuses every out-of-order handshake flight and changed route coordinate', async () => {
    const host = identity(HOST_ID, HOST_ENROLLMENT_ID, 7)
    const device = identity(DEVICE_ID, DEVICE_ENROLLMENT_ID, 9)
    const variants = ['hello', 'welcome', 'ready', 'finish', 'ack', 'commit', 'confirm', 'receipt']
    for (const flight of variants) {
      const [hostSocket, deviceSocket] = sockets(undefined, undefined, (raw) => {
        const message = parseRemoteRelayMessage(raw)
        return message.type === flight ? JSON.stringify({ ...message, type: flight === 'hello' ? 'welcome' : flight === 'welcome' ? 'hello' : flight === 'ready' ? 'finish' : 'ready' }) : raw
      })
      const results = await Promise.allSettled([
        accept({ socket: hostSocket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10) }),
        connectRemoteRelayDevice({ socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20) }),
      ])
      expect(results.some(result => result.status === 'rejected' && isRemoteRelayProtocolError(result.reason) && result.reason.code === 'REMOTE_RELAY_HANDSHAKE_INVALID')).toBe(true)
    }
    for (const [field, value] of Object.entries({ routeId: 'other_route_identifier', generation: 2, connectionEpoch: 8, senderDeviceId: 'other_device_identifier', senderEnrollmentId: 'other_enrollment_identifier', recipientDeviceId: 'other_device_identifier', recipientEnrollmentId: 'other_enrollment_identifier' })) {
      const [hostSocket, deviceSocket] = sockets(undefined, undefined, (raw) => {
        return JSON.stringify({ ...parseRemoteRelayMessage(raw), [field]: value })
      })
      const results = await Promise.allSettled([
        accept({ socket: hostSocket, identity: host, peer: publicIdentity(device), route: ROUTE, random: random(10) }),
        connectRemoteRelayDevice({ socket: deviceSocket, identity: device, host: publicIdentity(host), route: ROUTE, random: random(20) }),
      ])
      expect(results.some(result => result.status === 'rejected' && isRemoteRelayProtocolError(result.reason) && result.reason.code === 'REMOTE_RELAY_PEER_INVALID')).toBe(true)
    }
  })
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
