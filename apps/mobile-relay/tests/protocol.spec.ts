import { describe, expect, it } from 'vitest'
import {
  MAX_CONTROL_MESSAGE_BYTES,
  parseConnectionToken,
  parseCreationToken,
  parsePairingCreation,
  parsePairingId,
  parseRelayMessage,
} from '../src/protocol.ts'

const NOW = 1_800_000_000_000
const PAIRING_ID = 'pairing_identifier_123'
const DESKTOP_ID = 'desktop_identifier_123'
const MOBILE_ID = 'mobile__identifier_123'
const DESKTOP_RELAY_TOKEN = 'desktop_relay_token_that_is_long_123'
const MOBILE_RELAY_TOKEN = 'mobile_relay_token_that_is_long__123'
const DESKTOP_PUBLIC_KEY = 'WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns'
const MOBILE_PUBLIC_KEY = 'Yl6XjlyOjwJNHQsA0eAsiEvRiHPylqY14_qLUTMZxCI'
const PROOF = 'A'.repeat(55)

function init(overrides: object = {}): string {
  return JSON.stringify({
    type: 'mobile-init',
    version: 2,
    pairingId: PAIRING_ID,
    mobileDeviceId: MOBILE_ID,
    mobileEphemeralPublicKey: MOBILE_PUBLIC_KEY,
    capabilities: ['session:read', 'turn:send'],
    encryptedProof: PROOF,
    ...overrides,
  })
}

function frame(overrides: object = {}): string {
  return JSON.stringify({
    version: 2,
    pairingId: PAIRING_ID,
    senderDeviceId: DESKTOP_ID,
    recipientDeviceId: MOBILE_ID,
    sequence: 1,
    ciphertext: 'AA',
    ...overrides,
  })
}

describe('pairing creation admission', () => {
  it('accepts only a short-lived desktop creation with a canonical public key', () => {
    expect(parsePairingId(PAIRING_ID)).toBe(PAIRING_ID)
    const body = JSON.stringify({
      version: 2,
      desktopDeviceId: DESKTOP_ID,
      desktopEphemeralPublicKey: DESKTOP_PUBLIC_KEY,
      mobileRelayToken: MOBILE_RELAY_TOKEN,
      expiresAt: NOW + 60_000,
    })
    expect(parsePairingCreation(body, NOW)).toEqual({
      desktopDeviceId: DESKTOP_ID,
      desktopEphemeralPublicKey: DESKTOP_PUBLIC_KEY,
      mobileRelayToken: MOBILE_RELAY_TOKEN,
      expiresAt: NOW + 60_000,
    })
  })

  it('rejects overlong, expanded, malformed, and invalid-key creation input', () => {
    const base = {
      version: 2,
      desktopDeviceId: DESKTOP_ID,
      desktopEphemeralPublicKey: DESKTOP_PUBLIC_KEY,
      mobileRelayToken: MOBILE_RELAY_TOKEN,
      expiresAt: NOW + 60_000,
    }
    expect(parsePairingId('short')).toBeUndefined()
    expect(parsePairingCreation(JSON.stringify({ ...base, expiresAt: NOW + 300_001 }), NOW))
      .toBeUndefined()
    expect(parsePairingCreation(JSON.stringify({ ...base, extra: true }), NOW)).toBeUndefined()
    expect(parsePairingCreation(JSON.stringify({ ...base, desktopEphemeralPublicKey: 'AA' }), NOW))
      .toBeUndefined()
    expect(parsePairingCreation('{', NOW)).toBeUndefined()
    expect(parsePairingCreation('A'.repeat(MAX_CONTROL_MESSAGE_BYTES + 1), NOW)).toBeUndefined()
  })
})

describe('relay secret carriage', () => {
  it('admits a bearer only in creation headers or exact v2 WebSocket subprotocols', () => {
    expect(parseCreationToken(`Bearer ${DESKTOP_RELAY_TOKEN}`)).toBe(DESKTOP_RELAY_TOKEN)
    expect(parseConnectionToken(`dsh-pairing-v2, dsh-desktop.${DESKTOP_RELAY_TOKEN}`))
      .toEqual({ peer: 'desktop', token: DESKTOP_RELAY_TOKEN })
    expect(parseConnectionToken(`dsh-pairing-v2, dsh-mobile.${MOBILE_RELAY_TOKEN}`))
      .toEqual({ peer: 'mobile', token: MOBILE_RELAY_TOKEN })
  })

  it('rejects old, reordered, surplus, and short token protocols', () => {
    for (const value of [
      `Basic ${DESKTOP_RELAY_TOKEN}`,
      `Bearer ${DESKTOP_RELAY_TOKEN.slice(0, 12)}`,
      `dsh-pairing-v1, dsh-desktop.${DESKTOP_RELAY_TOKEN}`,
      `dsh-desktop.${DESKTOP_RELAY_TOKEN}, dsh-pairing-v2`,
      `dsh-pairing-v2, dsh-desktop.${DESKTOP_RELAY_TOKEN}, extra`,
      `dsh-pairing-v2, dsh-mobile.${MOBILE_RELAY_TOKEN.slice(0, 12)}`,
    ]) {
      expect(value.startsWith('Bearer ') ? parseCreationToken(value) : parseConnectionToken(value))
        .toBeUndefined()
    }
  })
})

describe('relay messages', () => {
  it('forwards exact key-confirmation controls and opaque frames without decryption', () => {
    expect(parseRelayMessage(init())).toMatchObject({
      kind: 'control',
      control: {
        type: 'mobile-init',
        mobileDeviceId: MOBILE_ID,
        mobileEphemeralPublicKey: MOBILE_PUBLIC_KEY,
        encryptedProof: PROOF,
      },
    })
    expect(parseRelayMessage(JSON.stringify({
      type: 'desktop-accept',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      encryptedProof: PROOF,
    }))).toMatchObject({ kind: 'control', control: { type: 'desktop-accept' } })
    expect(parseRelayMessage(frame())).toMatchObject({
      kind: 'frame',
      frame: { pairingId: PAIRING_ID, senderDeviceId: DESKTOP_ID, recipientDeviceId: MOBILE_ID },
    })
  })

  it('rejects privileged, expanded, malformed, and unbounded controls before state changes', () => {
    for (const message of [
      init({ capabilities: ['computer:use'] }),
      init({ extra: true }),
      init({ encryptedProof: 'AA' }),
      init({ pairingId: 'short' }),
      frame({ ciphertext: 'not-base64!' }),
      frame({ sequence: 0 }),
      '{',
    ]) {
      expect(parseRelayMessage(message)).toBeUndefined()
    }
  })
})
