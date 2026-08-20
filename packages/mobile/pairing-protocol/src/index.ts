/**
 * Parsing, capability admission, and frame ordering for encrypted mobile
 * pairing. Cryptography, token storage, user approval, and relay I/O remain
 * with the Electron host, Expo app, and relay implementation.
 * @module @deepseek-ai/dsh-pairing-protocol
 */

import { PairingProtocolError } from './error.ts'
import {
  MAX_BOOTSTRAP_TTL_MS,
  MAX_FRAME_CIPHERTEXT_BYTES,
  MAX_RELAY_SEQUENCE,
  MOBILE_PAIRING_CAPABILITIES,
  PAIRING_PROTOCOL_VERSION,
} from './types.ts'
import type {
  MobilePairingCapability,
  PairingBootstrap,
  PairingBootstrapInput,
  PairingDeviceId,
  PairingId,
  PairingRelayToken,
  PairingProtocolErrorCode,
  RelayFrame,
  RelayFrameInput,
} from './types.ts'

export { PairingProtocolError, isPairingProtocolError } from './error.ts'
export {
  MAX_BOOTSTRAP_TTL_MS,
  MAX_FRAME_CIPHERTEXT_BYTES,
  MAX_RELAY_SEQUENCE,
  MOBILE_PAIRING_CAPABILITIES,
  PAIRING_PROTOCOL_VERSION,
} from './types.ts'
export type {
  MobilePairingCapability,
  PairingBootstrap,
  PairingBootstrapInput,
  PairingDeviceId,
  PairingId,
  PairingProtocolErrorCode,
  PairingRelayToken,
  RelayFrame,
  RelayFrameInput,
} from './types.ts'

const QR_PREFIX = `dsh-pairing:v${PAIRING_PROTOCOL_VERSION}:`
const PUBLIC_ID = /^[A-Za-z0-9_-]{16,64}$/
const RELAY_TOKEN = /^[A-Za-z0-9_-]{32,256}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const MAX_QR_LENGTH = 4_096
const MAX_RELAY_URL_LENGTH = 512
const MAX_CIPHERTEXT_LENGTH = Math.ceil(MAX_FRAME_CIPHERTEXT_BYTES * 4 / 3)
const MOBILE_CAPABILITY_SET = new Set<string>(MOBILE_PAIRING_CAPABILITIES)

function failure(code: PairingProtocolErrorCode): never {
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

function readString(value: unknown, code: PairingProtocolErrorCode): string {
  return typeof value === 'string' ? value : failure(code)
}

function readInteger(value: unknown, code: PairingProtocolErrorCode): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : failure(code)
}

function parsePublicId(value: string, code: PairingProtocolErrorCode): PairingId {
  return PUBLIC_ID.test(value) ? value as PairingId : failure(code)
}

function parseDeviceId(value: string, code: PairingProtocolErrorCode): PairingDeviceId {
  return PUBLIC_ID.test(value) ? value as PairingDeviceId : failure(code)
}

function parseRelayToken(value: string, code: PairingProtocolErrorCode): PairingRelayToken {
  return RELAY_TOKEN.test(value) ? value as PairingRelayToken : failure(code)
}

function parseRelayUrl(value: string, code: PairingProtocolErrorCode): string {
  if (value.length > MAX_RELAY_URL_LENGTH) failure(code)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return failure(code)
  }
  if (url.protocol !== 'wss:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    failure(code)
  }
  return url.href
}

function parseCapabilities(value: unknown, code: PairingProtocolErrorCode): readonly MobilePairingCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MOBILE_PAIRING_CAPABILITIES.length) failure(code)
  const capabilities: MobilePairingCapability[] = []
  for (const capability of value) {
    if (typeof capability !== 'string' || !MOBILE_CAPABILITY_SET.has(capability) || capabilities.includes(capability as MobilePairingCapability)) {
      failure(code)
    }
    capabilities.push(capability as MobilePairingCapability)
  }
  return capabilities
}

function canonicalBase64Url(value: string): boolean {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return false
  try {
    const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4))
    return btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') === value
  } catch {
    return false
  }
}

function decodeBootstrapPayload(value: string): string {
  if (!canonicalBase64Url(value)) failure('PAIRING_QR_MALFORMED')
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4))
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failure('PAIRING_QR_MALFORMED')
  }
}

function parseBootstrapObject(value: unknown, nowMs: number): PairingBootstrap {
  const code = 'PAIRING_QR_MALFORMED' as const
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'relayUrl', 'pairingId', 'desktopDeviceId', 'relayToken', 'expiresAt', 'capabilities'])) {
    failure(code)
  }
  if (value.version !== PAIRING_PROTOCOL_VERSION) {
    failure('PAIRING_QR_UNSUPPORTED_VERSION')
  }
  const expiresAt = readInteger(value.expiresAt, code)
  if (expiresAt <= nowMs) failure('PAIRING_QR_EXPIRED')
  if (expiresAt > nowMs + MAX_BOOTSTRAP_TTL_MS) failure(code)
  return {
    version: PAIRING_PROTOCOL_VERSION,
    relayUrl: parseRelayUrl(readString(value.relayUrl, code), code),
    pairingId: parsePublicId(readString(value.pairingId, code), code),
    desktopDeviceId: parseDeviceId(readString(value.desktopDeviceId, code), code),
    relayToken: parseRelayToken(readString(value.relayToken, code), code),
    expiresAt,
    capabilities: parseCapabilities(value.capabilities, 'PAIRING_CAPABILITY_DENIED'),
  }
}

/**
 * Parse one desktop-generated QR value. The QR payload has the exact form
 * `dsh-pairing:v1:<canonical-base64url-utf8-json>` and is accepted only before
 * its expiry and within the fixed bootstrap lifetime.
 *
 * @param value - Untrusted QR scanner output.
 * @param nowMs - Current Unix time in milliseconds, supplied by the caller for deterministic testing.
 * @returns Validated bootstrap data. The relay token is sensitive and must not be logged or persisted.
 */
export function parsePairingBootstrap(value: string, nowMs = Date.now()): PairingBootstrap {
  if (value.length > MAX_QR_LENGTH || !value.startsWith(QR_PREFIX) || !Number.isSafeInteger(nowMs)) {
    failure('PAIRING_QR_MALFORMED')
  }
  const encoded = value.slice(QR_PREFIX.length)
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeBootstrapPayload(encoded))
  } catch {
    return failure('PAIRING_QR_MALFORMED')
  }
  return parseBootstrapObject(decoded, nowMs)
}

/**
 * Validate a desktop-produced bootstrap before encoding it into a QR value.
 *
 * @param input - Bootstrap fields supplied by the desktop trust anchor.
 * @param nowMs - Current Unix time in milliseconds.
 * @returns A validated bootstrap with branded opaque identifiers.
 */
export function validatePairingBootstrap(input: PairingBootstrapInput, nowMs = Date.now()): PairingBootstrap {
  return parseBootstrapObject(input, nowMs)
}

/**
 * Validate mobile capability declarations before a desktop approves them.
 *
 * @param capabilities - Untrusted capability names from a pairing request.
 * @returns Deduplicated, allowlisted capability names in request order.
 */
export function validateMobileCapabilities(capabilities: unknown): readonly MobilePairingCapability[] {
  return parseCapabilities(capabilities, 'PAIRING_CAPABILITY_DENIED')
}

/**
 * Parse one opaque encrypted relay frame. It never decrypts, authenticates, or
 * stores the payload; those are the cryptographic caller's responsibilities.
 *
 * @param value - Untrusted parsed JSON received from the relay.
 * @returns A validated relay envelope and opaque ciphertext.
 */
export function parseRelayFrame(value: unknown): RelayFrame {
  const code = 'RELAY_FRAME_MALFORMED' as const
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'pairingId', 'senderDeviceId', 'recipientDeviceId', 'sequence', 'ciphertext'])) {
    failure(code)
  }
  if (value.version !== PAIRING_PROTOCOL_VERSION) failure('RELAY_FRAME_UNSUPPORTED_VERSION')
  const senderDeviceId = parseDeviceId(readString(value.senderDeviceId, code), code)
  const recipientDeviceId = parseDeviceId(readString(value.recipientDeviceId, code), code)
  if (senderDeviceId === recipientDeviceId) failure(code)
  const sequence = readInteger(value.sequence, 'RELAY_FRAME_SEQUENCE_INVALID')
  if (sequence < 1 || sequence > MAX_RELAY_SEQUENCE) failure('RELAY_FRAME_SEQUENCE_INVALID')
  const ciphertext = readString(value.ciphertext, code)
  if (ciphertext.length > MAX_CIPHERTEXT_LENGTH || !canonicalBase64Url(ciphertext)) failure(code)
  return {
    version: PAIRING_PROTOCOL_VERSION,
    pairingId: parsePublicId(readString(value.pairingId, code), code),
    senderDeviceId,
    recipientDeviceId,
    sequence,
    ciphertext,
  }
}

/**
 * Serialize a locally-created opaque relay frame after the same exact checks
 * applied to untrusted frames.
 *
 * @param frame - Candidate frame supplied by an encryption caller.
 * @returns Canonical JSON for relay transport.
 */
export function serializeRelayFrame(frame: RelayFrameInput): string {
  return JSON.stringify(parseRelayFrame(frame))
}

/**
 * Admit the next frame for one pairing direction. Callers retain one
 * `lastAcceptedSequence` per `(pairingId, senderDeviceId, recipientDeviceId)`.
 * Gaps and duplicates require reconnect recovery instead of silent reordering.
 *
 * @param lastAcceptedSequence - Last accepted sequence, or `0` before the first frame.
 * @param frame - Parsed frame for the same pairing direction.
 * @returns The accepted frame sequence, to retain as the next `lastAcceptedSequence`.
 */
export function acceptRelayFrame(lastAcceptedSequence: number, frame: RelayFrame): number {
  if (!Number.isSafeInteger(lastAcceptedSequence) || lastAcceptedSequence < 0 || lastAcceptedSequence > MAX_RELAY_SEQUENCE) {
    failure('RELAY_FRAME_SEQUENCE_INVALID')
  }
  if (lastAcceptedSequence === MAX_RELAY_SEQUENCE) failure('RELAY_FRAME_SEQUENCE_EXHAUSTED')
  const expected = lastAcceptedSequence + 1
  if (frame.sequence < expected) failure('RELAY_FRAME_SEQUENCE_REPLAY')
  if (frame.sequence > expected) failure('RELAY_FRAME_SEQUENCE_GAP')
  return frame.sequence
}
