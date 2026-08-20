import { describe, expect, it } from 'vitest'
import {
  acceptRelayFrame,
  MAX_BOOTSTRAP_TTL_MS,
  MAX_RELAY_SEQUENCE,
  PairingProtocolError,
  type RelayFrameInput,
  parsePairingBootstrap,
  parseRelayFrame,
  serializeRelayFrame,
  validateMobileCapabilities,
} from '@deepseek-ai/dsh-pairing-protocol'

const NOW = 1_800_000_000_000
const PAIRING_ID = 'pairing_identifier_123'
const DESKTOP_ID = 'desktop_identifier_123'
const MOBILE_ID = 'mobile__identifier_123'
const RELAY_TOKEN = 'relay_token_that_is_long_enough_123'

function qr(payload: object): string {
  return `dsh-pairing:v1:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

function bootstrap(overrides: object = {}): object {
  return {
    version: 1,
    relayUrl: 'wss://relay.example.test/pair',
    pairingId: PAIRING_ID,
    desktopDeviceId: DESKTOP_ID,
    relayToken: RELAY_TOKEN,
    expiresAt: NOW + 60_000,
    capabilities: ['session:read', 'turn:send'],
    ...overrides,
  }
}

function frame(overrides: object = {}): RelayFrameInput {
  return {
    version: 1,
    pairingId: PAIRING_ID,
    senderDeviceId: DESKTOP_ID,
    recipientDeviceId: MOBILE_ID,
    sequence: 1,
    ciphertext: 'AA',
    ...overrides,
  }
}

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PairingProtocolError)
    return (error as PairingProtocolError).code
  }
  throw new Error('Expected pairing protocol failure')
}

describe('parsePairingBootstrap', () => {
  it('accepts a current desktop-issued QR bootstrap and preserves its opaque fields', () => {
    const parsed = parsePairingBootstrap(qr(bootstrap()), NOW)

    expect(parsed).toMatchObject({
      version: 1,
      relayUrl: 'wss://relay.example.test/pair',
      pairingId: PAIRING_ID,
      desktopDeviceId: DESKTOP_ID,
      relayToken: RELAY_TOKEN,
      expiresAt: NOW + 60_000,
      capabilities: ['session:read', 'turn:send'],
    })
  })

  it('rejects malformed and ambiguous QR values without echoing input', () => {
    for (const value of [
      '',
      'dsh-pairing:v2:AA',
      'dsh-pairing:v1:!!!!',
      'dsh-pairing:v1:A',
      `dsh-pairing:v1:${'A'.repeat(4_097)}`,
      qr({ ...bootstrap(), extra: 'rejected' }),
      qr({ ...bootstrap(), relayUrl: 'wss://relay.example.test/pair?token=leak' }),
      qr({ ...bootstrap(), relayUrl: 'ws://relay.example.test/pair' }),
    ]) {
      expect(code(() => parsePairingBootstrap(value, NOW))).toBe('PAIRING_QR_MALFORMED')
    }
  })

  it('rejects expired and overlong-lived bootstraps', () => {
    expect(code(() => parsePairingBootstrap(qr(bootstrap({ expiresAt: NOW })), NOW))).toBe('PAIRING_QR_EXPIRED')
    expect(code(() => parsePairingBootstrap(qr(bootstrap({ expiresAt: NOW + MAX_BOOTSTRAP_TTL_MS + 1 })), NOW)))
      .toBe('PAIRING_QR_MALFORMED')
  })

  it('rejects unsupported versions before admitting the rest of the payload', () => {
    expect(code(() => parsePairingBootstrap(qr(bootstrap({ version: 2 })), NOW))).toBe('PAIRING_QR_UNSUPPORTED_VERSION')
  })
})

describe('validateMobileCapabilities', () => {
  it('allows only declared mobile operations', () => {
    expect(validateMobileCapabilities(['session:read', 'turn:cancel'])).toEqual(['session:read', 'turn:cancel'])
  })

  it('denies privileged, duplicate, empty, and non-string capability declarations', () => {
    for (const capabilities of [
      ['computer:use'],
      ['session:read', 'session:read'],
      [],
      [1],
      'session:read',
    ]) {
      expect(code(() => validateMobileCapabilities(capabilities))).toBe('PAIRING_CAPABILITY_DENIED')
    }
  })
})

describe('relay frames', () => {
  it('parses opaque encrypted data without decrypting it and serializes the canonical envelope', () => {
    const parsed = parseRelayFrame(frame())

    expect(parsed).toMatchObject(frame())
    expect(JSON.parse(serializeRelayFrame(frame()))).toEqual(frame())
  })

  it('rejects malformed untrusted frames, extra fields, unknown versions, and invalid sequence numbers', () => {
    for (const [input, expected] of [
      [{ ...frame(), extra: true }, 'RELAY_FRAME_MALFORMED'],
      [{ ...frame(), version: 2 }, 'RELAY_FRAME_UNSUPPORTED_VERSION'],
      [{ ...frame(), senderDeviceId: MOBILE_ID, recipientDeviceId: MOBILE_ID }, 'RELAY_FRAME_MALFORMED'],
      [{ ...frame(), sequence: 0 }, 'RELAY_FRAME_SEQUENCE_INVALID'],
      [{ ...frame(), sequence: MAX_RELAY_SEQUENCE + 1 }, 'RELAY_FRAME_SEQUENCE_INVALID'],
      [{ ...frame(), ciphertext: 'not_base64!' }, 'RELAY_FRAME_MALFORMED'],
    ] as const) {
      expect(code(() => parseRelayFrame(input))).toBe(expected)
    }
  })

  it('requires contiguous per-direction sequencing and fails closed at the sequence ceiling', () => {
    const first = parseRelayFrame(frame({ sequence: 1 }))
    expect(acceptRelayFrame(0, first)).toBe(1)

    expect(code(() => acceptRelayFrame(1, parseRelayFrame(frame({ sequence: 1 }))))).toBe('RELAY_FRAME_SEQUENCE_REPLAY')
    expect(code(() => acceptRelayFrame(1, parseRelayFrame(frame({ sequence: 3 }))))).toBe('RELAY_FRAME_SEQUENCE_GAP')
    expect(acceptRelayFrame(MAX_RELAY_SEQUENCE - 1, parseRelayFrame(frame({ sequence: MAX_RELAY_SEQUENCE })))).toBe(MAX_RELAY_SEQUENCE)
    expect(code(() => acceptRelayFrame(MAX_RELAY_SEQUENCE, parseRelayFrame(frame({ sequence: MAX_RELAY_SEQUENCE }))))).toBe('RELAY_FRAME_SEQUENCE_EXHAUSTED')
  })
})
