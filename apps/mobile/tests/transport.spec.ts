import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-crypto', () => ({
  getRandomValues<T extends Uint8Array>(bytes: T): T {
    return bytes.fill(19) as T
  },
}))

import {
  PAIRING_PROTOCOL_VERSION,
  createDesktopPairingProof,
  createMobileSessionCipher,
  createPairingEphemeralKeyPair,
  confirmPairingKey,
  validatePairingBootstrap,
  type MobilePairingInit,
  type PairingRandomSource,
} from '@deepseek-ai/dsh-pairing-protocol'
import {
  MOBILE_FOREGROUND_CAPABILITIES,
  MOBILE_RELAY_ORIGIN,
  MOBILE_RELAY_V2_DEPLOYED,
  MobilePairingTransport,
  createExpoRandomSource,
  mobileRelayConnectionUrl,
  type MobileRelaySocket,
  type MobileTransportState,
} from '../transport'

const pairingId = 'a'.repeat(32)
const desktopDeviceId = 'b'.repeat(32)

class FixedRandom implements PairingRandomSource {
  private value = 1

  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length)
    bytes.fill(this.value)
    this.value += 1
    return bytes
  }
}

class FakeSocket implements MobileRelaySocket {
  onclose: ((event: { readonly code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onopen: (() => void) | null = null
  readonly sent: string[] = []
  closed = false

  close(): void {
    this.closed = true
  }

  send(data: string): void {
    this.sent.push(data)
  }

  open(): void {
    this.onopen?.()
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
}

function qr(bootstrap: ReturnType<typeof validatePairingBootstrap>): string {
  const payload = JSON.stringify({
    version: bootstrap.version,
    relayUrl: bootstrap.relayUrl,
    pairingId: bootstrap.pairingId,
    desktopDeviceId: bootstrap.desktopDeviceId,
    desktopEphemeralPublicKey: bootstrap.desktopEphemeralPublicKey,
    relayToken: bootstrap.relayToken,
    expiresAt: bootstrap.expiresAt,
    capabilities: bootstrap.capabilities,
  })
  return `dsh-pairing:v${PAIRING_PROTOCOL_VERSION}:${btoa(payload).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`
}

function bootstrap(now = 100): ReturnType<typeof validatePairingBootstrap> {
  const random = new FixedRandom()
  const desktopKey = createPairingEphemeralKeyPair(random)
  return validatePairingBootstrap({
    version: PAIRING_PROTOCOL_VERSION,
    relayUrl: `${MOBILE_RELAY_ORIGIN}/`,
    pairingId,
    desktopDeviceId,
    desktopEphemeralPublicKey: desktopKey.publicKey,
    relayToken: 'c'.repeat(32),
    expiresAt: now + 60_000,
    capabilities: ['session:read', 'session:subscribe', 'turn:send', 'turn:cancel'],
  }, now)
}

describe('MobilePairingTransport', () => {
  it('uses the Expo random module directly and never falls back to a global or weak source', () => {
    const random = createExpoRandomSource({
      getRandomValues(bytes) {
        bytes.fill(23)
        return bytes
      },
    })

    expect([...random.randomBytes(4)]).toEqual([23, 23, 23, 23])
    expect(() => createExpoRandomSource({ getRandomValues: () => { throw new Error('native-random-unavailable') } }).randomBytes(4)).toThrow('protocol-invalid')
  })

  it('uses the compiled relay origin and keeps the bearer out of the URL', () => {
    const value = bootstrap()
    const url = mobileRelayConnectionUrl(value)

    expect(url).toBe(`${MOBILE_RELAY_ORIGIN}/v1/pairings/${pairingId}/connect`)
    expect(url).not.toContain(value.relayToken)
    expect(() => mobileRelayConnectionUrl({ ...value, relayUrl: 'wss://example.test/' })).toThrow()
  })

  it('uses the deployed production v2 setting to parse a bootstrap and enter the socket lifecycle', () => {
    const socket = new FakeSocket()
    const states: MobileTransportState[] = []
    const transport = new MobilePairingTransport({
      createSocket: (url) => {
        expect(url).toBe(`${MOBILE_RELAY_ORIGIN}/v1/pairings/${pairingId}/connect`)
        return socket
      },
      now: () => 100,
      onDesktopMessage: () => undefined,
      onState: state => states.push(state),
      random: new FixedRandom(),
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      unschedule: () => undefined,
    })

    transport.start(qr(bootstrap()))
    socket.open()

    expect(MOBILE_RELAY_V2_DEPLOYED).toBe(true)
    expect(socket.sent).toHaveLength(1)
    expect(states.map(state => state.kind)).toEqual(['connecting', 'awaiting-desktop-approval'])
  })

  it('sends mobile-init only after the foreground socket opens and waits for desktop acceptance', () => {
    const socket = new FakeSocket()
    const states: MobileTransportState[] = []
    const transport = new MobilePairingTransport({
      createSocket: (url, protocols) => {
        expect(url).toBe(`${MOBILE_RELAY_ORIGIN}/v1/pairings/${pairingId}/connect`)
        expect(protocols[0]).toBe('dsh-pairing-v2')
        expect(protocols[1]).toBe(`dsh-mobile.${'c'.repeat(32)}`)
        return socket
      },
      now: () => 100,
      onDesktopMessage: () => undefined,
      onState: state => states.push(state),
      random: new FixedRandom(),
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      unschedule: () => undefined,
    })

    transport.start(qr(bootstrap()))
    expect(socket.sent).toEqual([])
    socket.open()

    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
      type: 'mobile-init',
      version: PAIRING_PROTOCOL_VERSION,
      pairingId,
      capabilities: MOBILE_FOREGROUND_CAPABILITIES,
    })
    expect('cancelTurn' in transport).toBe(false)
    expect(states.map(state => state.kind)).toEqual(['connecting', 'awaiting-desktop-approval'])
    expect(transport.connected()).toBe(false)
  })

  it('opens the session envelope only after a valid desktop proof and rejects pre-accept frames', () => {
    const socket = new FakeSocket()
    const events: MobileTransportState[] = []
    const desktopMessages: unknown[] = []
    const mobileRandom = new FixedRandom()
    const activeBootstrap = bootstrap()
    const transport = new MobilePairingTransport({
      createSocket: () => socket,
      now: () => 100,
      onDesktopMessage: message => desktopMessages.push(message),
      onState: state => events.push(state),
      random: mobileRandom,
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      unschedule: () => undefined,
    })

    transport.start(qr(activeBootstrap))
    socket.open()
    socket.receive({ version: PAIRING_PROTOCOL_VERSION, pairingId, senderDeviceId: desktopDeviceId, recipientDeviceId: 'd'.repeat(32), sequence: 1, ciphertext: 'a'.repeat(40) })

    expect(transport.connected()).toBe(false)
    expect(socket.closed).toBe(true)
    expect(events.at(-1)).toEqual({ kind: 'ended', reason: 'protocol-invalid' })
    expect(desktopMessages).toEqual([])
  })

  it('decrypts only a valid desktop session envelope after desktop acceptance', () => {
    const socket = new FakeSocket()
    const received: unknown[] = []
    const mobileRandom = new FixedRandom()
    const desktopRandom = new FixedRandom()
    const desktopKey = createPairingEphemeralKeyPair(new FixedRandom())
    const bootstrapWithDesktopSecret = validatePairingBootstrap({
      version: PAIRING_PROTOCOL_VERSION,
      relayUrl: `${MOBILE_RELAY_ORIGIN}/`,
      pairingId,
      desktopDeviceId,
      desktopEphemeralPublicKey: desktopKey.publicKey,
      relayToken: 'c'.repeat(32),
      expiresAt: 60_100,
      capabilities: ['session:read', 'session:subscribe', 'turn:send', 'turn:cancel'],
    }, 100)
    const transport = new MobilePairingTransport({
      createSocket: () => socket,
      now: () => 100,
      onDesktopMessage: message => received.push(message),
      onState: () => undefined,
      random: mobileRandom,
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      unschedule: () => undefined,
    })

    transport.start(qr(bootstrapWithDesktopSecret))
    socket.open()
    const init = JSON.parse(socket.sent[0] ?? '{}') as MobilePairingInit
    const encryptedProof = createDesktopPairingProof({
      bootstrap: bootstrapWithDesktopSecret,
      init,
      desktopSecretKey: desktopKey.secretKey,
      random: desktopRandom,
    })
    socket.receive({
      type: 'desktop-accept',
      version: PAIRING_PROTOCOL_VERSION,
      pairingId,
      mobileDeviceId: init.mobileDeviceId,
      encryptedProof,
    })

    expect(transport.connected()).toBe(true)
    const desktopCipher = createMobileSessionCipher({
      bootstrap: bootstrapWithDesktopSecret,
      init,
      endpoint: 'desktop',
      localSecretKey: desktopKey.secretKey,
      confirmation: confirmPairingKey(),
      random: desktopRandom,
    })
    socket.receive(desktopCipher.seal({
      type: 'session-snapshot',
      sessionHandle: 'e'.repeat(32),
      requestId: 'f'.repeat(32),
      title: 'Desktop-selected session',
      messages: [],
      activeTurn: null,
    }))

    expect(received).toEqual([expect.objectContaining({ type: 'session-snapshot', title: 'Desktop-selected session' })])
  })
})
