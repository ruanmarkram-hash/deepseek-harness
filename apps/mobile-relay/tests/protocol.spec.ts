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

function control(overrides: object = {}): string {
  return JSON.stringify({
    type: 'mobile-request',
    version: 1,
    pairingId: PAIRING_ID,
    mobileDeviceId: MOBILE_ID,
    capabilities: ['session:read', 'turn:send'],
    ...overrides,
  })
}

function frame(overrides: object = {}): string {
  return JSON.stringify({
    version: 1,
    pairingId: PAIRING_ID,
    senderDeviceId: DESKTOP_ID,
    recipientDeviceId: MOBILE_ID,
    sequence: 1,
    ciphertext: 'AA',
    ...overrides,
  })
}

describe('pairing creation admission', () => {
  it('accepts only a short-lived desktop creation body and opaque public id', () => {
    expect(parsePairingId(PAIRING_ID)).toBe(PAIRING_ID)
    const body = JSON.stringify({
      version: 1,
      desktopDeviceId: DESKTOP_ID,
      mobileRelayToken: MOBILE_RELAY_TOKEN,
      expiresAt: NOW + 60_000,
    })
    expect(parsePairingCreation(body, NOW))
      .toEqual({ desktopDeviceId: DESKTOP_ID, mobileRelayToken: MOBILE_RELAY_TOKEN, expiresAt: NOW + 60_000 })
  })

  it('rejects long-lived, expanded, malformed, and invalid-id creation input', () => {
    expect(parsePairingId('short')).toBeUndefined()
    const overlong = JSON.stringify({
      version: 1,
      desktopDeviceId: DESKTOP_ID,
      mobileRelayToken: MOBILE_RELAY_TOKEN,
      expiresAt: NOW + 300_001,
    })
    const expanded = JSON.stringify({
      version: 1,
      desktopDeviceId: DESKTOP_ID,
      mobileRelayToken: MOBILE_RELAY_TOKEN,
      expiresAt: NOW + 60_000,
      extra: true,
    })
    expect(parsePairingCreation(overlong, NOW)).toBeUndefined()
    expect(parsePairingCreation(expanded, NOW)).toBeUndefined()
    expect(parsePairingCreation('{', NOW)).toBeUndefined()
    expect(parsePairingCreation('A'.repeat(MAX_CONTROL_MESSAGE_BYTES + 1), NOW)).toBeUndefined()
  })
})

describe('relay secret carriage', () => {
  it('admits a bearer token only in the creation header or exact WebSocket subprotocol pair', () => {
    expect(parseCreationToken(`Bearer ${DESKTOP_RELAY_TOKEN}`)).toBe(DESKTOP_RELAY_TOKEN)
    expect(parseConnectionToken(`dsh-pairing-v1, dsh-desktop.${DESKTOP_RELAY_TOKEN}`)).toEqual({ peer: 'desktop', token: DESKTOP_RELAY_TOKEN })
    expect(parseConnectionToken(`dsh-pairing-v1, dsh-mobile.${MOBILE_RELAY_TOKEN}`)).toEqual({ peer: 'mobile', token: MOBILE_RELAY_TOKEN })
  })

  it('rejects malformed schemes, reordered protocols, surplus protocols, and short tokens', () => {
    for (const value of [
      `Basic ${DESKTOP_RELAY_TOKEN}`,
      `Bearer ${DESKTOP_RELAY_TOKEN.slice(0, 12)}`,
      `dsh-desktop.${DESKTOP_RELAY_TOKEN}, dsh-pairing-v1`,
      `dsh-pairing-v1, dsh-desktop.${DESKTOP_RELAY_TOKEN}, extra`,
      `dsh-pairing-v1, dsh-mobile.${MOBILE_RELAY_TOKEN.slice(0, 12)}`,
    ]) {
      expect(value.startsWith('Bearer ') ? parseCreationToken(value) : parseConnectionToken(value)).toBeUndefined()
    }
  })
})

describe('relay messages', () => {
  it('validates the allowlisted mobile request and delegates opaque frames to the shared protocol parser', () => {
    expect(parseRelayMessage(control())).toEqual({
      kind: 'control',
      control: {
        type: 'mobile-request',
        pairingId: PAIRING_ID,
        mobileDeviceId: MOBILE_ID,
        capabilities: ['session:read', 'turn:send'],
      },
    })
    expect(parseRelayMessage(frame())).toMatchObject({
      kind: 'frame',
      frame: { pairingId: PAIRING_ID, senderDeviceId: DESKTOP_ID, recipientDeviceId: MOBILE_ID, sequence: 1, ciphertext: 'AA' },
    })
  })

  it('rejects privileged or expanded controls and malformed relay envelopes before relay state changes', () => {
    for (const message of [
      control({ capabilities: ['computer:use'] }),
      control({ extra: true }),
      control({ pairingId: 'short' }),
      frame({ ciphertext: 'not-base64!' }),
      frame({ sequence: 0 }),
      '{',
    ]) {
      expect(parseRelayMessage(message)).toBeUndefined()
    }
  })
})
