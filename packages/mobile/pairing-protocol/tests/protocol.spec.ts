import { describe, expect, it } from 'vitest'
import {
  acceptRelayFrame,
  confirmPairingKey,
  createMobileSessionCipher,
  createDesktopPairingProof,
  createMobilePairingProof,
  createPairingEphemeralKeyPair,
  destroyPairingEphemeralKeyPair,
  MAX_BOOTSTRAP_TTL_MS,
  MAX_RELAY_SEQUENCE,
  PairingProtocolError,
  parseDesktopPairingAccept,
  parseMobilePairingInit,
  parseMobileToDesktopSessionMessage,
  parseDesktopToMobileSessionMessage,
  parsePairingBootstrap,
  parseRelayFrame,
  serializeRelayFrame,
  type PairingRandomSource,
  type PairingBootstrapInput,
  type RelayFrameInput,
  validateMobileCapabilities,
  validatePairingBootstrap,
  verifyDesktopPairingProof,
  verifyMobilePairingProof,
} from '@deepseek-ai/dsh-pairing-protocol'

const NOW = 1_800_000_000_000
const PAIRING_ID = 'pairing_identifier_123'
const DESKTOP_ID = 'desktop_identifier_123'
const MOBILE_ID = 'mobile__identifier_123'
const RELAY_TOKEN = 'relay_token_that_is_long_enough_123'

class VectorRandom implements PairingRandomSource {
  private readonly values: Uint8Array[]

  constructor(...values: Uint8Array[]) {
    this.values = values.map(value => new Uint8Array(value))
  }

  randomBytes(length: number): Uint8Array {
    const next = this.values.shift()
    if (next === undefined || next.byteLength !== length) throw new Error('vector exhausted')
    return next
  }
}

function bytes(start: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => start + index)
}

const DESKTOP_KEY_RANDOM = bytes(1, 32)
const MOBILE_KEY_RANDOM = bytes(33, 32)
const MOBILE_PROOF_NONCE = bytes(65, 24)
const DESKTOP_PROOF_NONCE = bytes(89, 24)
const desktopPublicKey = createPairingEphemeralKeyPair(
  new VectorRandom(DESKTOP_KEY_RANDOM),
).publicKey

function qr(payload: object): string {
  return 'dsh-pairing:v2:' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function bootstrap(overrides: Partial<PairingBootstrapInput> = {}): PairingBootstrapInput {
  return {
    version: 2,
    relayUrl: 'wss://relay.example.test/pair',
    pairingId: PAIRING_ID,
    desktopDeviceId: DESKTOP_ID,
    desktopEphemeralPublicKey: desktopPublicKey,
    relayToken: RELAY_TOKEN,
    expiresAt: NOW + 60_000,
    capabilities: ['session:read', 'turn:send'],
    ...overrides,
  }
}

function frame(overrides: object = {}): RelayFrameInput {
  return {
    version: 2,
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
  it('accepts a current desktop-issued QR bootstrap with an exact X25519 key', () => {
    const parsed = parsePairingBootstrap(qr(bootstrap()), NOW)

    expect(parsed).toMatchObject({
      version: 2,
      relayUrl: 'wss://relay.example.test/pair',
      pairingId: PAIRING_ID,
      desktopDeviceId: DESKTOP_ID,
      desktopEphemeralPublicKey: desktopPublicKey,
      relayToken: RELAY_TOKEN,
      expiresAt: NOW + 60_000,
      capabilities: ['session:read', 'turn:send'],
    })
  })

  it('rejects malformed, ambiguous, or non-32-byte QR keys without echoing input', () => {
    for (const value of [
      '',
      'dsh-pairing:v1:AA',
      'dsh-pairing:v2:!!!!',
      'dsh-pairing:v2:A',
      'dsh-pairing:v2:' + 'A'.repeat(4_097),
      qr({ ...bootstrap(), extra: 'rejected' }),
      qr({ ...bootstrap(), desktopEphemeralPublicKey: 'AA' }),
      qr({ ...bootstrap(), relayUrl: 'wss://relay.example.test/pair?token=leak' }),
      qr({ ...bootstrap(), relayUrl: 'ws://relay.example.test/pair' }),
    ]) {
      expect(code(() => parsePairingBootstrap(value, NOW))).toBe('PAIRING_QR_MALFORMED')
    }
  })

  it('rejects expired, overlong-lived, and unsupported bootstraps', () => {
    expect(code(() => parsePairingBootstrap(qr(bootstrap({ expiresAt: NOW })), NOW)))
      .toBe('PAIRING_QR_EXPIRED')
    expect(code(() => parsePairingBootstrap(
      qr(bootstrap({ expiresAt: NOW + MAX_BOOTSTRAP_TTL_MS + 1 })),
      NOW,
    ))).toBe('PAIRING_QR_MALFORMED')
    expect(code(() => parsePairingBootstrap(qr(bootstrap({ version: 1 })), NOW)))
      .toBe('PAIRING_QR_UNSUPPORTED_VERSION')
  })
})

describe('key-confirmation controls', () => {
  it('parses only exact bounded mobile-init and desktop-accept controls', () => {
    const proof = 'A'.repeat(55)
    expect(parseMobilePairingInit({
      type: 'mobile-init',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      mobileEphemeralPublicKey: desktopPublicKey,
      capabilities: ['session:read', 'turn:send'],
      encryptedProof: proof,
    })).toMatchObject({ type: 'mobile-init', encryptedProof: proof })
    expect(parseDesktopPairingAccept({
      type: 'desktop-accept',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      encryptedProof: proof,
    })).toMatchObject({ type: 'desktop-accept', encryptedProof: proof })
    expect(code(() => parseMobilePairingInit({
      type: 'mobile-init',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      mobileEphemeralPublicKey: desktopPublicKey,
      capabilities: ['computer:use'],
      encryptedProof: proof,
    }))).toBe('PAIRING_CAPABILITY_DENIED')
    expect(code(() => parseDesktopPairingAccept({
      type: 'desktop-accept',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      encryptedProof: 'AA',
    }))).toBe('PAIRING_CONTROL_MALFORMED')
  })
})

describe('X25519 and XChaCha20-Poly1305 proof vectors', () => {
  it('binds both public keys, pairing identifiers, and capabilities before frames are allowed', () => {
    const bootstrapValue = validatePairingBootstrap(bootstrap(), NOW)
    const desktopKeyPair = createPairingEphemeralKeyPair(
      new VectorRandom(DESKTOP_KEY_RANDOM),
    )
    const mobileKeyPair = createPairingEphemeralKeyPair(
      new VectorRandom(MOBILE_KEY_RANDOM),
    )
    const mobileProof = createMobilePairingProof({
      bootstrap: bootstrapValue,
      mobileDeviceId: MOBILE_ID as never,
      capabilities: ['session:read', 'turn:send'],
      mobileKeyPair,
      random: new VectorRandom(MOBILE_PROOF_NONCE),
    })
    const init = parseMobilePairingInit({
      type: 'mobile-init',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      mobileEphemeralPublicKey: mobileProof.mobileEphemeralPublicKey,
      capabilities: ['session:read', 'turn:send'],
      encryptedProof: mobileProof.encryptedProof,
    })

    expect(mobileProof).toEqual({
      mobileEphemeralPublicKey: 'WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns',
      encryptedProof: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYx8GqvxXdVwUTuQZ11LxQmXEzHhjHk39k33bt8ps_w4Y1fHwTgRW769Hm',
    })
    verifyMobilePairingProof({
      bootstrap: bootstrapValue,
      init,
      desktopSecretKey: desktopKeyPair.secretKey,
    })

    const desktopProof = createDesktopPairingProof({
      bootstrap: bootstrapValue,
      init,
      desktopSecretKey: desktopKeyPair.secretKey,
      random: new VectorRandom(DESKTOP_PROOF_NONCE),
    })
    expect(desktopProof).toBe('WVpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wAXsiUnDXoQrEe5lpudUEvrWSUNuWe_bwibV8fj1RmJW8HY-SDAG5J6c8qNx-')

    const accept = parseDesktopPairingAccept({
      type: 'desktop-accept',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      encryptedProof: desktopProof,
    })
    verifyDesktopPairingProof({
      bootstrap: bootstrapValue,
      init,
      accept,
      mobileSecretKey: mobileKeyPair.secretKey,
    })

    const confirmation = confirmPairingKey()
    confirmation.requireConfirmed()
    confirmation.revoke()
    expect(code(() => {
      confirmation.requireConfirmed()
    })).toBe('PAIRING_KEY_CONFIRMATION_REQUIRED')

    destroyPairingEphemeralKeyPair(desktopKeyPair)
    destroyPairingEphemeralKeyPair(mobileKeyPair)
    expect(desktopKeyPair.secretKey.every(value => value === 0)).toBe(true)
    expect(mobileKeyPair.secretKey.every(value => value === 0)).toBe(true)
  })

  it('rejects altered transcript fields and proof ciphertext before key confirmation', () => {
    const bootstrapValue = validatePairingBootstrap(bootstrap(), NOW)
    const desktopKeyPair = createPairingEphemeralKeyPair(
      new VectorRandom(DESKTOP_KEY_RANDOM),
    )
    const mobileKeyPair = createPairingEphemeralKeyPair(
      new VectorRandom(MOBILE_KEY_RANDOM),
    )
    const proof = createMobilePairingProof({
      bootstrap: bootstrapValue,
      mobileDeviceId: MOBILE_ID as never,
      capabilities: ['session:read', 'turn:send'],
      mobileKeyPair,
      random: new VectorRandom(MOBILE_PROOF_NONCE),
    })
    const init = parseMobilePairingInit({
      type: 'mobile-init',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      mobileEphemeralPublicKey: proof.mobileEphemeralPublicKey,
      capabilities: ['session:read'],
      encryptedProof: proof.encryptedProof,
    })
    expect(code(() => {
      verifyMobilePairingProof({
        bootstrap: bootstrapValue,
        init,
        desktopSecretKey: desktopKeyPair.secretKey,
      })
    })).toBe('PAIRING_PROOF_INVALID')

    destroyPairingEphemeralKeyPair(desktopKeyPair)
    destroyPairingEphemeralKeyPair(mobileKeyPair)
  })
})

describe('capabilities and relay frames', () => {
  it('allows only declared mobile operations', () => {
    expect(validateMobileCapabilities(['session:read', 'turn:cancel']))
      .toEqual(['session:read', 'turn:cancel'])
  })

  it('denies privileged, duplicate, empty, and non-string capability declarations', () => {
    for (const capabilities of [
      ['computer:use'],
      ['session:read', 'session:read'],
      [],
      [1],
      'session:read',
    ]) {
      expect(code(() => validateMobileCapabilities(capabilities)))
        .toBe('PAIRING_CAPABILITY_DENIED')
    }
  })

  it('parses opaque encrypted data and serializes its canonical frame envelope', () => {
    const parsed = parseRelayFrame(frame())

    expect(parsed).toMatchObject(frame())
    expect(JSON.parse(serializeRelayFrame(frame()))).toEqual(frame())
  })

  it('rejects malformed controls and invalid frame counters', () => {
    for (const [input, expected] of [
      [{ ...frame(), extra: true }, 'RELAY_FRAME_MALFORMED'],
      [{ ...frame(), version: 1 }, 'RELAY_FRAME_UNSUPPORTED_VERSION'],
      [{ ...frame(), senderDeviceId: MOBILE_ID, recipientDeviceId: MOBILE_ID }, 'RELAY_FRAME_MALFORMED'],
      [{ ...frame(), sequence: 0 }, 'RELAY_FRAME_SEQUENCE_INVALID'],
      [{ ...frame(), sequence: MAX_RELAY_SEQUENCE + 1 }, 'RELAY_FRAME_SEQUENCE_INVALID'],
      [{ ...frame(), ciphertext: 'not_base64!' }, 'RELAY_FRAME_MALFORMED'],
    ] as const) {
      expect(code(() => parseRelayFrame(input))).toBe(expected)
    }
  })

  it('requires contiguous per-direction sequencing and fails closed at exhaustion', () => {
    const first = parseRelayFrame(frame({ sequence: 1 }))
    expect(acceptRelayFrame(0, first)).toBe(1)
    expect(code(() => acceptRelayFrame(
      1,
      parseRelayFrame(frame({ sequence: 1 })),
    ))).toBe('RELAY_FRAME_SEQUENCE_REPLAY')
    expect(code(() => acceptRelayFrame(
      1,
      parseRelayFrame(frame({ sequence: 3 })),
    ))).toBe('RELAY_FRAME_SEQUENCE_GAP')
    expect(acceptRelayFrame(
      MAX_RELAY_SEQUENCE - 1,
      parseRelayFrame(frame({ sequence: MAX_RELAY_SEQUENCE })),
    )).toBe(MAX_RELAY_SEQUENCE)
    expect(code(() => acceptRelayFrame(
      MAX_RELAY_SEQUENCE,
      parseRelayFrame(frame({ sequence: MAX_RELAY_SEQUENCE })),
    ))).toBe('RELAY_FRAME_SEQUENCE_EXHAUSTED')
  })
})

function sessionCiphers() {
  const bootstrapValue = validatePairingBootstrap(bootstrap(), NOW)
  const desktopKeyPair = createPairingEphemeralKeyPair(
    new VectorRandom(DESKTOP_KEY_RANDOM),
  )
  const mobileKeyPair = createPairingEphemeralKeyPair(
    new VectorRandom(MOBILE_KEY_RANDOM),
  )
  const init = parseMobilePairingInit({
    type: 'mobile-init',
    version: 2,
    pairingId: PAIRING_ID,
    mobileDeviceId: MOBILE_ID,
    mobileEphemeralPublicKey: mobileKeyPair.publicKey,
    capabilities: ['session:read', 'turn:send'],
    encryptedProof: 'A'.repeat(55),
  })
  return {
    desktop: createMobileSessionCipher({
      bootstrap: bootstrapValue,
      init,
      endpoint: 'desktop',
      localSecretKey: desktopKeyPair.secretKey,
      confirmation: confirmPairingKey(),
      random: new VectorRandom(bytes(113, 24), bytes(137, 24)),
    }),
    mobile: createMobileSessionCipher({
      bootstrap: bootstrapValue,
      init,
      endpoint: 'mobile',
      localSecretKey: mobileKeyPair.secretKey,
      confirmation: confirmPairingKey(),
      random: new VectorRandom(bytes(161, 24), bytes(185, 24)),
    }),
  }
}

describe('closed encrypted mobile session envelope', () => {
  const SESSION = 'session_handle_123'
  const REQUEST = 'request_identifier_123'
  const TURN = 'turn_identifier_123'

  it('round-trips only text session frames with a nonce-prefixed canonical ciphertext', () => {
    const { desktop, mobile } = sessionCiphers()
    const send = {
      type: 'send-text' as const,
      sessionHandle: SESSION,
      requestId: REQUEST,
      text: 'Please continue this specific local session.',
    }
    const requestFrame = mobile.seal(send)

    expect(requestFrame).toMatchObject({
      version: 2,
      pairingId: PAIRING_ID,
      senderDeviceId: MOBILE_ID,
      recipientDeviceId: DESKTOP_ID,
      sequence: 1,
    })
    expect(Buffer.from(requestFrame.ciphertext, 'base64url').byteLength).toBeGreaterThanOrEqual(41)
    expect(desktop.open(requestFrame)).toEqual(send)

    const snapshot = {
      type: 'session-snapshot' as const,
      sessionHandle: SESSION,
      requestId: REQUEST,
      title: 'Current task',
      messages: [{
        id: 'message_identifier_123',
        role: 'assistant' as const,
        text: 'Only safe text appears in this preview.',
      }],
      activeTurn: { id: TURN, state: 'running' as const },
    }
    const responseFrame = desktop.seal(snapshot)
    expect(responseFrame.sequence).toBe(1)
    expect(mobile.open(responseFrame)).toEqual(snapshot)
  })

  it('fails closed for unexpected structures, unsafe fields, or out-of-bound input', () => {
    expect(code(() => parseMobileToDesktopSessionMessage({
      type: 'send-text',
      sessionHandle: SESSION,
      requestId: REQUEST,
      text: 'hello',
      filePath: '/private/data',
    }))).toBe('MOBILE_SESSION_MESSAGE_MALFORMED')
    expect(code(() => parseDesktopToMobileSessionMessage({
      type: 'session-snapshot',
      sessionHandle: SESSION,
      requestId: REQUEST,
      title: 'task',
      messages: Array.from({ length: 25 }, () => ({
        id: 'message_identifier_123', role: 'assistant', text: 'x',
      })),
      activeTurn: null,
    }))).toBe('MOBILE_SESSION_MESSAGE_MALFORMED')
    expect(code(() => parseDesktopToMobileSessionMessage({
      type: 'tool-call',
      sessionHandle: SESSION,
      requestId: REQUEST,
      tool: 'computer-use',
    }))).toBe('MOBILE_SESSION_MESSAGE_MALFORMED')

    const { mobile } = sessionCiphers()
    expect(code(() => mobile.seal({
      type: 'send-text',
      sessionHandle: SESSION,
      requestId: REQUEST,
      text: 'x'.repeat(8 * 1_024 + 1),
    }))).toBe('MOBILE_SESSION_MESSAGE_MALFORMED')
  })

  it('authenticates routing and ciphertext without consuming a tampered sequence', () => {
    const { desktop, mobile } = sessionCiphers()
    const frame = mobile.seal({
      type: 'cancel-turn',
      sessionHandle: SESSION,
      requestId: REQUEST,
      turnId: TURN,
    })
    const altered = {
      ...frame,
      ciphertext: frame.ciphertext.slice(0, 5)
        + (frame.ciphertext[5] === 'A' ? 'B' : 'A')
        + frame.ciphertext.slice(6),
    }
    expect(code(() => desktop.open(altered))).toBe('MOBILE_SESSION_FRAME_INVALID')
    expect(desktop.open(frame)).toMatchObject({ type: 'cancel-turn', turnId: TURN })
    expect(code(() => desktop.open(frame))).toBe('RELAY_FRAME_SEQUENCE_REPLAY')
  })

  it('binds the accepted sequence into AEAD associated data', () => {
    const { desktop, mobile } = sessionCiphers()
    const command = {
      type: 'cancel-turn' as const,
      sessionHandle: SESSION,
      requestId: REQUEST,
      turnId: TURN,
    }
    const first = mobile.seal(command)
    const second = mobile.seal(command)
    const rewrittenSequence = { ...second, sequence: 1 }

    expect(code(() => desktop.open(rewrittenSequence))).toBe('MOBILE_SESSION_FRAME_INVALID')
    expect(desktop.open(first)).toEqual(command)
  })

  it('erases memory-only directional keys and closes the confirmation gate', () => {
    const { mobile } = sessionCiphers()
    mobile.erase()
    expect(code(() => mobile.seal({
      type: 'send-text',
      sessionHandle: SESSION,
      requestId: REQUEST,
      text: 'This must never leave a revoked endpoint.',
    }))).toBe('MOBILE_SESSION_KEY_ERASED')
  })
})
