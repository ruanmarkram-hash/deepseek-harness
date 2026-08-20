/**
 * Closed, memory-only encrypted envelopes for the allowlisted mobile session.
 * @module @deepseek-ai/dsh-pairing-protocol/session
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { PairingProtocolError } from './error.ts'
import {
  acceptRelayFrame,
  decodePairingEphemeralPublicKey,
  parseRelayFrame,
  validateMobileCapabilities,
} from './index.ts'
import {
  MAX_FRAME_CIPHERTEXT_BYTES,
  MAX_MOBILE_SESSION_DELTA_BYTES,
  MAX_MOBILE_SESSION_SEND_TEXT_BYTES,
  MAX_MOBILE_SESSION_SHORT_TEXT_BYTES,
  MAX_MOBILE_SESSION_SNAPSHOT_MESSAGES,
  MAX_MOBILE_SESSION_SNAPSHOT_TEXT_BYTES,
  PAIRING_PROOF_NONCE_BYTES,
  PAIRING_PROOF_TAG_BYTES,
  PAIRING_X25519_KEY_BYTES,
} from './types.ts'
import type {
  DesktopToMobileSessionMessage,
  MobilePairingInit,
  MobileSessionActiveTurn,
  MobileSessionErrorCode,
  MobileSessionSnapshotMessage,
  MobileSessionTurnState,
  MobileToDesktopSessionMessage,
  PairingBootstrap,
  PairingDeviceId,
  PairingEphemeralPublicKey,
  RelayFrame,
} from './types.ts'
import type { PairingKeyConfirmation, PairingRandomSource } from './crypto.ts'

const TEXT = new TextEncoder()
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const OPAQUE_ID = /^[A-Za-z0-9_-]{16,96}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const DESKTOP_TO_MOBILE_LABEL = 'dsh-pairing/v2/session/desktop-to-mobile'
const MOBILE_TO_DESKTOP_LABEL = 'dsh-pairing/v2/session/mobile-to-desktop'
const MIN_CIPHERTEXT_BYTES = PAIRING_PROOF_NONCE_BYTES + PAIRING_PROOF_TAG_BYTES + 1

/** Which endpoint holds the in-memory cipher. */
export type MobileSessionEndpoint = 'desktop' | 'mobile'

/** Inputs needed to derive one endpoint's directional session frame keys. */
export interface CreateMobileSessionCipherInput {
  readonly bootstrap: PairingBootstrap
  readonly init: MobilePairingInit
  readonly endpoint: MobileSessionEndpoint
  readonly localSecretKey: Uint8Array
  readonly confirmation: PairingKeyConfirmation
  readonly random: PairingRandomSource
}

/** A memory-only, ordered encrypted envelope for one paired mobile session. */
export interface MobileSessionCipher {
  /** Encrypt one exact allowlisted message into the next relay frame. */
  seal(message: unknown): RelayFrame
  /** Authenticate, sequence, decrypt, and parse one expected relay frame. */
  open(frame: unknown): DesktopToMobileSessionMessage | MobileToDesktopSessionMessage
  /** Zero directional keys and permanently close this endpoint. */
  erase(): void
}

function failure(
  code: 'MOBILE_SESSION_MESSAGE_MALFORMED' | 'MOBILE_SESSION_FRAME_INVALID' | 'MOBILE_SESSION_KEY_ERASED' | 'PAIRING_KEY_INVALID',
): never {
  throw new PairingProtocolError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function boundedString(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length > maxBytes * 2) {
    return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
  }
  return TEXT.encode(value).byteLength <= maxBytes
    ? value
    : failure('MOBILE_SESSION_MESSAGE_MALFORMED')
}

function opaqueId(value: unknown): string {
  const result = boundedString(value, MAX_MOBILE_SESSION_SHORT_TEXT_BYTES)
  return OPAQUE_ID.test(result) ? result : failure('MOBILE_SESSION_MESSAGE_MALFORMED')
}

function turnState(value: unknown): MobileSessionTurnState {
  return value === 'idle'
    || value === 'running'
    || value === 'completed'
    || value === 'cancelled'
    || value === 'failed'
    ? value
    : failure('MOBILE_SESSION_MESSAGE_MALFORMED')
}

function errorCode(value: unknown): MobileSessionErrorCode {
  return value === 'SESSION_UNAVAILABLE'
    || value === 'TURN_REJECTED'
    || value === 'TURN_FAILED'
    || value === 'PAIRING_REVOKED'
    ? value
    : failure('MOBILE_SESSION_MESSAGE_MALFORMED')
}

function snapshotMessage(value: unknown): MobileSessionSnapshotMessage {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'role', 'text'])) {
    return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
  }
  if (value.role !== 'user' && value.role !== 'assistant') {
    return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
  }
  return {
    id: opaqueId(value.id),
    role: value.role,
    text: boundedString(value.text, MAX_MOBILE_SESSION_SNAPSHOT_TEXT_BYTES),
  }
}

function activeTurn(value: unknown): MobileSessionActiveTurn | null {
  if (value === null) return null
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'state'])) {
    return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
  }
  return { id: opaqueId(value.id), state: turnState(value.state) }
}

/** Parse an exact desktop-to-mobile, text-only session message. */
export function parseDesktopToMobileSessionMessage(value: unknown): DesktopToMobileSessionMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
  }
  if (value.type === 'session-snapshot') {
    if (!hasExactKeys(value, ['type', 'sessionHandle', 'requestId', 'title', 'messages', 'activeTurn'])) {
      return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
    }
    if (!Array.isArray(value.messages) || value.messages.length > MAX_MOBILE_SESSION_SNAPSHOT_MESSAGES) {
      return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
    }
    return {
      type: 'session-snapshot',
      sessionHandle: opaqueId(value.sessionHandle),
      requestId: opaqueId(value.requestId),
      title: boundedString(value.title, MAX_MOBILE_SESSION_SHORT_TEXT_BYTES),
      messages: value.messages.map(snapshotMessage),
      activeTurn: activeTurn(value.activeTurn),
    }
  }
  if (value.type === 'text-delta') {
    if (!hasExactKeys(value, ['type', 'sessionHandle', 'requestId', 'turnId', 'delta'])) {
      return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
    }
    return {
      type: 'text-delta',
      sessionHandle: opaqueId(value.sessionHandle),
      requestId: opaqueId(value.requestId),
      turnId: opaqueId(value.turnId),
      delta: boundedString(value.delta, MAX_MOBILE_SESSION_DELTA_BYTES),
    }
  }
  if (value.type === 'turn-state') {
    if (!hasExactKeys(value, ['type', 'sessionHandle', 'requestId', 'turnId', 'state'])) {
      return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
    }
    return {
      type: 'turn-state',
      sessionHandle: opaqueId(value.sessionHandle),
      requestId: opaqueId(value.requestId),
      turnId: opaqueId(value.turnId),
      state: turnState(value.state),
    }
  }
  if (value.type === 'error') {
    if (!hasExactKeys(value, ['type', 'sessionHandle', 'requestId', 'code', 'message'])) {
      return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
    }
    return {
      type: 'error',
      sessionHandle: opaqueId(value.sessionHandle),
      requestId: opaqueId(value.requestId),
      code: errorCode(value.code),
      message: boundedString(value.message, MAX_MOBILE_SESSION_SHORT_TEXT_BYTES),
    }
  }
  return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
}

/** Parse an exact mobile-to-desktop, text-only session command. */
export function parseMobileToDesktopSessionMessage(value: unknown): MobileToDesktopSessionMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
  }
  if (value.type === 'send-text') {
    if (!hasExactKeys(value, ['type', 'sessionHandle', 'requestId', 'text'])) {
      return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
    }
    return {
      type: 'send-text',
      sessionHandle: opaqueId(value.sessionHandle),
      requestId: opaqueId(value.requestId),
      text: boundedString(value.text, MAX_MOBILE_SESSION_SEND_TEXT_BYTES),
    }
  }
  if (value.type === 'cancel-turn') {
    if (!hasExactKeys(value, ['type', 'sessionHandle', 'requestId', 'turnId'])) {
      return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
    }
    return {
      type: 'cancel-turn',
      sessionHandle: opaqueId(value.sessionHandle),
      requestId: opaqueId(value.requestId),
      turnId: opaqueId(value.turnId),
    }
  }
  return failure('MOBILE_SESSION_MESSAGE_MALFORMED')
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    return failure('MOBILE_SESSION_FRAME_INVALID')
  }
  try {
    const binary = atob(
      value.replaceAll('-', '+').replaceAll('_', '/')
      + '='.repeat((4 - value.length % 4) % 4),
    )
    const canonical = btoa(binary)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    if (canonical !== value) return failure('MOBILE_SESSION_FRAME_INVALID')
    return Uint8Array.from(binary, byte => byte.charCodeAt(0))
  } catch {
    return failure('MOBILE_SESSION_FRAME_INVALID')
  }
}

function sessionTranscript(bootstrap: PairingBootstrap, init: MobilePairingInit): Uint8Array {
  const capabilities = validateMobileCapabilities(init.capabilities)
  if (
    init.pairingId !== bootstrap.pairingId
    || !capabilities.every(capability => bootstrap.capabilities.includes(capability))
  ) {
    return failure('PAIRING_KEY_INVALID')
  }
  return TEXT.encode(JSON.stringify([
    'dsh-pairing',
    bootstrap.version,
    bootstrap.pairingId,
    bootstrap.desktopDeviceId,
    init.mobileDeviceId,
    bootstrap.desktopEphemeralPublicKey,
    init.mobileEphemeralPublicKey,
    ...capabilities,
  ]))
}

function deriveDirectionalKey(
  localSecretKey: Uint8Array,
  peerPublicKey: PairingEphemeralPublicKey,
  transcript: Uint8Array,
  label: string,
): Uint8Array {
  let sharedSecret: Uint8Array | undefined
  try {
    if (!(localSecretKey instanceof Uint8Array) || localSecretKey.byteLength !== PAIRING_X25519_KEY_BYTES) {
      return failure('PAIRING_KEY_INVALID')
    }
    sharedSecret = x25519.getSharedSecret(
      new Uint8Array(localSecretKey),
      decodePairingEphemeralPublicKey(peerPublicKey),
    )
    if (sharedSecret.every(byte => byte === 0)) return failure('PAIRING_KEY_INVALID')
    return hkdf(sha256, sharedSecret, transcript, TEXT.encode(label), 32)
  } catch (error) {
    if (error instanceof PairingProtocolError) throw error
    return failure('PAIRING_KEY_INVALID')
  } finally {
    sharedSecret?.fill(0)
  }
}

function routingAad(frame: RelayFrame): Uint8Array {
  return TEXT.encode(JSON.stringify([
    frame.version,
    frame.pairingId,
    frame.senderDeviceId,
    frame.recipientDeviceId,
    frame.sequence,
  ]))
}

function randomNonce(random: PairingRandomSource): Uint8Array {
  try {
    const nonce = random.randomBytes(PAIRING_PROOF_NONCE_BYTES)
    if (!(nonce instanceof Uint8Array) || nonce.byteLength !== PAIRING_PROOF_NONCE_BYTES) {
      return failure('MOBILE_SESSION_FRAME_INVALID')
    }
    return new Uint8Array(nonce)
  } catch {
    return failure('MOBILE_SESSION_FRAME_INVALID')
  }
}

function sameRouting(
  frame: RelayFrame,
  pairingId: string,
  senderDeviceId: PairingDeviceId,
  recipientDeviceId: PairingDeviceId,
): boolean {
  return frame.pairingId === pairingId
    && frame.senderDeviceId === senderDeviceId
    && frame.recipientDeviceId === recipientDeviceId
}

/**
 * Derive direction-separated XChaCha20-Poly1305 keys after proof confirmation.
 * The returned object retains no private pairing key and cannot be persisted.
 */
export function createMobileSessionCipher(
  input: CreateMobileSessionCipherInput,
): MobileSessionCipher {
  const localDeviceId = input.endpoint === 'desktop'
    ? input.bootstrap.desktopDeviceId
    : input.init.mobileDeviceId
  const peerDeviceId = input.endpoint === 'desktop'
    ? input.init.mobileDeviceId
    : input.bootstrap.desktopDeviceId
  const peerPublicKey = input.endpoint === 'desktop'
    ? input.init.mobileEphemeralPublicKey
    : input.bootstrap.desktopEphemeralPublicKey
  const transcript = sessionTranscript(input.bootstrap, input.init)
  const desktopToMobileKey = deriveDirectionalKey(
    input.localSecretKey,
    peerPublicKey,
    transcript,
    DESKTOP_TO_MOBILE_LABEL,
  )
  const mobileToDesktopKey = deriveDirectionalKey(
    input.localSecretKey,
    peerPublicKey,
    transcript,
    MOBILE_TO_DESKTOP_LABEL,
  )
  transcript.fill(0)
  let outboundSequence = 0
  let inboundSequence = 0
  let erased = false

  function requireActive(): void {
    if (erased) failure('MOBILE_SESSION_KEY_ERASED')
    input.confirmation.requireConfirmed()
  }

  function localMessage(message: unknown): DesktopToMobileSessionMessage | MobileToDesktopSessionMessage {
    return input.endpoint === 'desktop'
      ? parseDesktopToMobileSessionMessage(message)
      : parseMobileToDesktopSessionMessage(message)
  }

  function incomingMessage(message: unknown): DesktopToMobileSessionMessage | MobileToDesktopSessionMessage {
    return input.endpoint === 'desktop'
      ? parseMobileToDesktopSessionMessage(message)
      : parseDesktopToMobileSessionMessage(message)
  }

  return {
    seal(message: unknown): RelayFrame {
      requireActive()
      const parsedMessage = localMessage(message)
      if (outboundSequence >= 2_147_483_647) {
        return failure('MOBILE_SESSION_FRAME_INVALID')
      }
      const sequence = outboundSequence + 1
      const frame: RelayFrame = {
        version: input.bootstrap.version,
        pairingId: input.bootstrap.pairingId,
        senderDeviceId: localDeviceId,
        recipientDeviceId: peerDeviceId,
        sequence,
        ciphertext: '',
      }
      const plaintext = TEXT.encode(JSON.stringify(parsedMessage))
      const nonce = randomNonce(input.random)
      const key = input.endpoint === 'desktop' ? desktopToMobileKey : mobileToDesktopKey
      try {
        const encrypted = xchacha20poly1305(key, nonce, routingAad(frame)).encrypt(plaintext)
        const result = new Uint8Array(nonce.byteLength + encrypted.byteLength)
        result.set(nonce)
        result.set(encrypted, nonce.byteLength)
        if (result.byteLength > MAX_FRAME_CIPHERTEXT_BYTES) {
          return failure('MOBILE_SESSION_FRAME_INVALID')
        }
        frame.ciphertext = encodeBase64Url(result)
        outboundSequence = sequence
        return frame
      } catch (error) {
        if (error instanceof PairingProtocolError) throw error
        return failure('MOBILE_SESSION_FRAME_INVALID')
      } finally {
        plaintext.fill(0)
        nonce.fill(0)
      }
    },
    open(value: unknown): DesktopToMobileSessionMessage | MobileToDesktopSessionMessage {
      requireActive()
      let bytes: Uint8Array | undefined
      let nonce: Uint8Array | undefined
      let ciphertext: Uint8Array | undefined
      let plaintext: Uint8Array | undefined
      try {
        const frame = parseRelayFrame(value)
        if (!sameRouting(
          frame,
          input.bootstrap.pairingId,
          peerDeviceId,
          localDeviceId,
        )) {
          return failure('MOBILE_SESSION_FRAME_INVALID')
        }
        const nextSequence = acceptRelayFrame(inboundSequence, frame)
        bytes = decodeBase64Url(frame.ciphertext)
        if (bytes.byteLength < MIN_CIPHERTEXT_BYTES || bytes.byteLength > MAX_FRAME_CIPHERTEXT_BYTES) {
          return failure('MOBILE_SESSION_FRAME_INVALID')
        }
        nonce = bytes.slice(0, PAIRING_PROOF_NONCE_BYTES)
        ciphertext = bytes.slice(PAIRING_PROOF_NONCE_BYTES)
        const key = input.endpoint === 'desktop' ? mobileToDesktopKey : desktopToMobileKey
        plaintext = xchacha20poly1305(key, nonce, routingAad(frame)).decrypt(ciphertext)
        let decoded: unknown
        try {
          decoded = JSON.parse(UTF8.decode(plaintext))
        } catch {
          return failure('MOBILE_SESSION_FRAME_INVALID')
        }
        const parsed = incomingMessage(decoded)
        inboundSequence = nextSequence
        return parsed
      } catch (error) {
        if (error instanceof PairingProtocolError) {
          if (error.code === 'RELAY_FRAME_SEQUENCE_REPLAY' || error.code === 'RELAY_FRAME_SEQUENCE_GAP') {
            throw error
          }
          if (error.code === 'MOBILE_SESSION_MESSAGE_MALFORMED') {
            return failure('MOBILE_SESSION_FRAME_INVALID')
          }
          throw error
        }
        return failure('MOBILE_SESSION_FRAME_INVALID')
      } finally {
        bytes?.fill(0)
        nonce?.fill(0)
        ciphertext?.fill(0)
        plaintext?.fill(0)
      }
    },
    erase(): void {
      if (erased) return
      erased = true
      desktopToMobileKey.fill(0)
      mobileToDesktopKey.fill(0)
      input.confirmation.revoke()
    },
  }
}
