import { afterEach, expect, it, vi } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import * as cipher from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import * as pairing from '../src/index.ts'
import { nextSessionSequence } from '../src/sequence.ts'

vi.mock('@noble/curves/ed25519.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/curves/ed25519.js')>()
  return { ...actual, x25519: {
    ...actual.x25519, getSharedSecret: vi.fn(actual.x25519.getSharedSecret), getPublicKey: vi.fn(actual.x25519.getPublicKey),
  } }
})
vi.mock('@noble/ciphers/chacha.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/ciphers/chacha.js')>()
  return { ...actual, chacha20poly1305: vi.fn(actual.chacha20poly1305) }
})

afterEach(() => { vi.restoreAllMocks() })

it('stops the internal sequence counter at the largest accepted relay sequence', () => {
  expect(nextSessionSequence(0)).toBe(1)
  expect(nextSessionSequence(2_147_483_646)).toBe(2_147_483_647)
  expect(() => nextSessionSequence(2_147_483_647)).toThrow('MOBILE_SESSION_FRAME_INVALID')
})

function material() {
  const random = { randomBytes: (length: number) => new Uint8Array(length).fill(7) }
  const desktop = pairing.createPairingEphemeralKeyPair(random)
  const mobile = pairing.createPairingEphemeralKeyPair({ randomBytes: length => new Uint8Array(length).fill(9) })
  const bootstrap = pairing.validatePairingBootstrap({
    version: 2, relayUrl: 'wss://relay.example.test/pair', pairingId: 'pairing_identifier_123',
    desktopDeviceId: 'desktop_identifier_123', desktopEphemeralPublicKey: desktop.publicKey,
    relayToken: 'relay_token_identifier_long_enough_123', expiresAt: Date.now() + 60_000, capabilities: ['session:read', 'turn:send'],
  })
  const init = pairing.parseMobilePairingInit({
    type: 'mobile-init', version: 2, pairingId: bootstrap.pairingId, mobileDeviceId: 'mobile_identifier_123',
    mobileEphemeralPublicKey: mobile.publicKey, capabilities: bootstrap.capabilities, encryptedProof: 'A'.repeat(40),
  })
  const input = { bootstrap, init, endpoint: 'desktop' as const, localSecretKey: desktop.secretKey, confirmation: pairing.confirmPairingKey(), random }
  const transcript = new TextEncoder().encode(JSON.stringify([
    'dsh-pairing', 2, bootstrap.pairingId, bootstrap.desktopDeviceId, init.mobileDeviceId,
    desktop.publicKey, mobile.publicKey, ...init.capabilities,
  ]))
  const shared = x25519.getSharedSecret(desktop.secretKey, pairing.decodePairingEphemeralPublicKey(mobile.publicKey))
  return { random, desktop, mobile, bootstrap, init, input, transcript, shared }
}

it('turns entropy, key, and provider failures into stable protocol errors', () => {
  for (const random of [{ randomBytes: () => new Uint8Array(1) }, { randomBytes: (): Uint8Array => { throw new Error('private provider detail') } }]) {
    expect(() => pairing.createPairingEphemeralKeyPair(random)).toThrow('PAIRING_KEY_INVALID')
  }
  const m = material()
  const proofInput = {
    bootstrap: m.bootstrap, mobileDeviceId: m.init.mobileDeviceId, capabilities: m.init.capabilities,
    mobileKeyPair: m.mobile, random: m.random,
  }
  expect(() => pairing.createMobilePairingProof({ ...proofInput, capabilities: ['turn:cancel'] })).toThrow('PAIRING_PROOF_INVALID')
  expect(() => pairing.createMobilePairingProof({ ...proofInput, mobileKeyPair: { ...m.mobile, secretKey: new Uint8Array(1) } })).toThrow('PAIRING_KEY_INVALID')
  expect(() => pairing.createMobileSessionCipher({ ...m.input, localSecretKey: new Uint8Array(1) })).toThrow('PAIRING_KEY_INVALID')
  const otherInit = pairing.parseMobilePairingInit({ ...m.init, pairingId: 'other_pairing_identifier' })
  expect(() => pairing.createMobileSessionCipher({ ...m.input, init: otherInit })).toThrow('PAIRING_KEY_INVALID')
  expect(() => pairing.createMobileSessionCipher({ ...m.input, init: { ...m.init, capabilities: ['turn:cancel'] } })).toThrow('PAIRING_KEY_INVALID')
  const getShared = vi.spyOn(x25519, 'getSharedSecret')
  getShared.mockReturnValueOnce(new Uint8Array(32))
  expect(() => pairing.createMobilePairingProof(proofInput)).toThrow('PAIRING_KEY_INVALID')
  getShared.mockReturnValueOnce(new Uint8Array(32))
  expect(() => pairing.createMobileSessionCipher(m.input)).toThrow('PAIRING_KEY_INVALID')
  getShared.mockImplementationOnce(() => { throw new Error('provider failed') })
  expect(() => pairing.createMobilePairingProof(proofInput)).toThrow('PAIRING_KEY_INVALID')
  getShared.mockImplementationOnce(() => { throw new Error('provider failed') })
  expect(() => pairing.createMobileSessionCipher(m.input)).toThrow('PAIRING_KEY_INVALID')
  vi.spyOn(x25519, 'getPublicKey').mockImplementationOnce(() => { throw new Error('provider failed') })
  expect(() => pairing.createPairingEphemeralKeyPair(m.random)).toThrow('PAIRING_KEY_INVALID')
})

it('rejects authenticated proofs with either shorter or longer incorrect labels', () => {
  const m = material()
  const label = 'dsh-pairing/v2/mobile-init'
  const key = hkdf(sha256, m.shared, m.transcript, new TextEncoder().encode(label), 32)
  for (const plaintext of ['x', label + 'extra']) {
    const nonce = new Uint8Array(12)
    const encrypted = cipher.chacha20poly1305(key, nonce, m.transcript).encrypt(new TextEncoder().encode(plaintext))
    const encryptedProof = pairing.encodePairingEncryptedProof(new Uint8Array([...nonce, ...encrypted]))
    expect(() =>{  pairing.verifyMobilePairingProof({ bootstrap: m.bootstrap, init: { ...m.init, encryptedProof }, desktopSecretKey: m.desktop.secretKey }) }).toThrow('PAIRING_PROOF_INVALID')
  }
  const accept = pairing.parseDesktopPairingAccept({ type: 'desktop-accept', version: 2, pairingId: 'wrong_pairing_identifier', mobileDeviceId: m.init.mobileDeviceId, encryptedProof: 'A'.repeat(40) })
  expect(() =>{  pairing.verifyDesktopPairingProof({ bootstrap: m.bootstrap, init: m.init, accept, mobileSecretKey: m.mobile.secretKey }) }).toThrow('PAIRING_PROOF_INVALID')
})

it('rejects authenticated non-JSON or disallowed plaintext without advancing inbound sequence', () => {
  const m = material()
  const desktop = pairing.createMobileSessionCipher(m.input)
  const label = 'dsh-pairing/v2/session/mobile-to-desktop'
  const key = hkdf(sha256, m.shared, m.transcript, new TextEncoder().encode(label), 32)
  const frame = {
    version: 2, pairingId: m.bootstrap.pairingId, senderDeviceId: m.init.mobileDeviceId,
    recipientDeviceId: m.bootstrap.desktopDeviceId, sequence: 1,
  }
  const aad = new TextEncoder().encode(JSON.stringify([
    frame.version, frame.pairingId, frame.senderDeviceId, frame.recipientDeviceId, frame.sequence,
  ]))
  for (const plaintext of ['{', JSON.stringify({ type: 'future' }), JSON.stringify({ type: 'send-text', sessionHandle: 'session_identifier_123', requestId: 'request_identifier_123', text: 'accepted' })]) {
    const nonce = new Uint8Array(12)
    const encrypted = cipher.chacha20poly1305(key, nonce, aad).encrypt(new TextEncoder().encode(plaintext))
    const value = { ...frame, ciphertext: Buffer.from(new Uint8Array([...nonce, ...encrypted])).toString('base64url') }
    if (plaintext.includes('accepted')) expect(desktop.open(value)).toMatchObject({ text: 'accepted' })
    else expect(() => desktop.open(value)).toThrow('MOBILE_SESSION_FRAME_INVALID')
  }
})

it('handles failed crypto and encoding operations without exposing provider details', () => {
  const m = material()
  const message = { type: 'error', sessionHandle: 'session_identifier_123', requestId: 'request_identifier_123', code: 'TURN_FAILED', message: 'safe' }
  for (const random of [{ randomBytes: () => new Uint8Array(1) }, { randomBytes: (): Uint8Array => { throw new Error('provider detail') } }]) {
    const desktop = pairing.createMobileSessionCipher({ ...m.input, random })
    expect(() => desktop.seal(message)).toThrow('MOBILE_SESSION_FRAME_INVALID')
  }
  const desktop = pairing.createMobileSessionCipher(m.input)
  vi.spyOn(cipher, 'chacha20poly1305').mockImplementationOnce(() => { throw new Error('provider detail') })
  expect(() => desktop.seal(message)).toThrow('MOBILE_SESSION_FRAME_INVALID')
  vi.spyOn(cipher, 'chacha20poly1305').mockImplementationOnce(() => { throw new Error('provider detail') })
  expect(() => pairing.createDesktopPairingProof({ bootstrap: m.bootstrap, init: m.init, desktopSecretKey: m.desktop.secretKey, random: m.random })).toThrow('PAIRING_PROOF_INVALID')
  vi.spyOn(globalThis, 'atob').mockImplementationOnce(() => { throw new Error('decoder detail') })
  expect(() => pairing.decodePairingEphemeralPublicKey(m.desktop.publicKey)).toThrow('PAIRING_KEY_INVALID')
  vi.restoreAllMocks()
  const atobOriginal = globalThis.atob
  vi.spyOn(globalThis, 'atob').mockImplementationOnce(atobOriginal).mockImplementationOnce(() => { throw new Error('decoder detail') })
  expect(() => pairing.decodePairingEphemeralPublicKey(m.desktop.publicKey)).toThrow('PAIRING_KEY_INVALID')
})

it('rejects ciphertext expansion from escaped snapshot text without advancing its sequence', () => {
  const m = material()
  const desktop = pairing.createMobileSessionCipher(m.input)
  const snapshot = {
    type: 'session-snapshot', sessionHandle: 'session_identifier_123', requestId: 'request_identifier_123', title: 'bounded', activeTurn: null,
    messages: Array.from({ length: 24 }, (_, index) => ({ id: `message_identifier_${index}`, role: 'user', text: '\0'.repeat(2048) })),
  }
  expect(() => desktop.seal(snapshot)).toThrow('MOBILE_SESSION_FRAME_INVALID')
  expect(desktop.seal({ type: 'error', sessionHandle: 'session_identifier_123', requestId: 'request_identifier_123', code: 'TURN_FAILED', message: 'safe' }).sequence).toBe(1)
})

it('maps a decoder failure after public frame validation to the stable frame error', () => {
  const m = material()
  const desktop = pairing.createMobileSessionCipher(m.input)
  const mobile = pairing.createMobileSessionCipher({ ...m.input, endpoint: 'mobile', localSecretKey: m.mobile.secretKey })
  const frame = mobile.seal({ type: 'send-text', sessionHandle: 'session_identifier_123', requestId: 'request_identifier_123', text: 'safe' })
  const decode = globalThis.atob
  vi.spyOn(globalThis, 'atob').mockImplementationOnce(decode).mockImplementationOnce(() => { throw new Error('decoder detail') })
  expect(() => desktop.open(frame)).toThrow('MOBILE_SESSION_FRAME_INVALID')
})
