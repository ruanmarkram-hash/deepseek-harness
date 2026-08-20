/** Strict HTTP and WebSocket vocabulary owned by the mobile-pairing relay. */

import {
  decodePairingEphemeralPublicKey,
  PAIRING_PROTOCOL_VERSION,
  parseDesktopPairingAccept,
  parseMobilePairingInit,
  parseRelayFrame,
} from '@deepseek-ai/dsh-pairing-protocol'
import type {
  DesktopPairingAccept,
  MobilePairingInit,
  RelayFrame,
} from '@deepseek-ai/dsh-pairing-protocol'

/** Maximum non-ciphertext JSON payload accepted by the relay. */
export const MAX_CONTROL_MESSAGE_BYTES = 4 * 1_024

/** Maximum serialized opaque frame accepted by the relay. */
export const MAX_RELAY_MESSAGE_BYTES = 96 * 1_024

/** Fixed rate limit for one connected device. */
export const MAX_MESSAGES_PER_SECOND = 30

/** Maximum UTF-8 bytes accepted for a pairing-creation control body. */
export const MAX_CREATION_BODY_BYTES = MAX_CONTROL_MESSAGE_BYTES

const PUBLIC_ID = /^[A-Za-z0-9_-]{16,64}$/
const RELAY_TOKEN = /^[A-Za-z0-9_-]{32,256}$/

/** A creation request made by the desktop trust anchor. */
export interface PairingCreation {
  desktopDeviceId: string
  desktopEphemeralPublicKey: string
  mobileRelayToken: string
  expiresAt: number
}

/** A role-bound secret presented during a WebSocket upgrade. */
export interface ConnectionToken {
  readonly peer: 'desktop' | 'mobile'
  readonly token: string
}

/** Authenticated controls used only to initialize, accept, or revoke a pairing. */
export type RelayControl =
  | {
    readonly type: 'desktop-hello'
    readonly pairingId: string
    readonly desktopDeviceId: string
  }
  | MobilePairingInit
  | DesktopPairingAccept
  | { readonly type: 'desktop-revoke'; readonly pairingId: string }

/** Result of validating one client WebSocket payload. */
export type RelayMessage =
  | { readonly kind: 'control'; readonly control: RelayControl }
  | { readonly kind: 'frame'; readonly frame: RelayFrame }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function readPublicId(value: unknown): string | undefined {
  return typeof value === 'string' && PUBLIC_ID.test(value) ? value : undefined
}

function readFutureExpiry(value: unknown, nowMs: number): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  const max = nowMs + 5 * 60 * 1_000
  return value > nowMs && value <= max ? value : undefined
}

function readEphemeralPublicKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const decoded = decodePairingEphemeralPublicKey(value)
    decoded.fill(0)
    return value
  } catch {
    return undefined
  }
}

/**
 * Validate an opaque pairing identifier without recording or transforming it.
 *
 * @param value - Candidate identifier from a request path or internal dispatch header.
 * @returns The identifier when it has the protocol's public-id form.
 */
export function parsePairingId(value: string | null): string | undefined {
  return value !== null && PUBLIC_ID.test(value) ? value : undefined
}

/**
 * Read the relay bearer token from the authorization header.
 *
 * @param value - Authorization header supplied by the desktop during creation.
 * @returns The secret token without the scheme, or undefined for malformed input.
 */
export function parseCreationToken(value: string | null): string | undefined {
  if (value === null || !value.startsWith('Bearer ')) return undefined
  const token = value.slice('Bearer '.length)
  return RELAY_TOKEN.test(token) ? token : undefined
}

/**
 * Read the bearer token from WebSocket subprotocol values without accepting it
 * in URLs or the selected response protocol.
 *
 * @param value - Sec-WebSocket-Protocol request header.
 * @returns The submitted secret token, or undefined unless the exact two protocols are present.
 */
export function parseConnectionToken(value: string | null): ConnectionToken | undefined {
  if (value === null || value.length > 512) return undefined
  const protocols = value.split(',').map(protocol => protocol.trim())
  if (protocols.length !== 2 || protocols[0] !== 'dsh-pairing-v2') return undefined
  const tokenProtocol = protocols[1]
  if (tokenProtocol === undefined) return undefined
  for (const [peer, prefix] of [
    ['desktop', 'dsh-desktop.'],
    ['mobile', 'dsh-mobile.'],
  ] as const) {
    if (!tokenProtocol.startsWith(prefix)) continue
    const token = tokenProtocol.slice(prefix.length)
    return RELAY_TOKEN.test(token) ? { peer, token } : undefined
  }
  return undefined
}

/**
 * Parse the exact desktop pairing-creation body.
 *
 * @param value - Untrusted HTTP JSON text.
 * @param nowMs - Current Unix time in milliseconds.
 * @returns The bounded desktop identity, key, and pairing expiry.
 */
export function parsePairingCreation(
  value: string,
  nowMs = Date.now(),
): PairingCreation | undefined {
  if (value.length > MAX_CONTROL_MESSAGE_BYTES || !Number.isSafeInteger(nowMs)) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (
    !isRecord(parsed)
    || !hasExactKeys(parsed, [
      'version',
      'desktopDeviceId',
      'desktopEphemeralPublicKey',
      'mobileRelayToken',
      'expiresAt',
    ])
    || parsed.version !== PAIRING_PROTOCOL_VERSION
  ) {
    return undefined
  }
  const desktopDeviceId = readPublicId(parsed.desktopDeviceId)
  const desktopEphemeralPublicKey = readEphemeralPublicKey(
    parsed.desktopEphemeralPublicKey,
  )
  const mobileRelayToken = typeof parsed.mobileRelayToken === 'string'
    && RELAY_TOKEN.test(parsed.mobileRelayToken)
    ? parsed.mobileRelayToken
    : undefined
  const expiresAt = readFutureExpiry(parsed.expiresAt, nowMs)
  return (
    desktopDeviceId === undefined
    || desktopEphemeralPublicKey === undefined
    || mobileRelayToken === undefined
    || expiresAt === undefined
  )
    ? undefined
    : {
      desktopDeviceId,
      desktopEphemeralPublicKey,
      mobileRelayToken,
      expiresAt,
    }
}

function parseControl(value: Record<string, unknown>): RelayControl | undefined {
  if (value.version !== PAIRING_PROTOCOL_VERSION || typeof value.type !== 'string') {
    return undefined
  }
  switch (value.type) {
    case 'desktop-hello': {
      if (!hasExactKeys(value, ['type', 'version', 'pairingId', 'desktopDeviceId'])) {
        return undefined
      }
      const desktopDeviceId = readPublicId(value.desktopDeviceId)
      const pairingId = readPublicId(value.pairingId)
      return desktopDeviceId === undefined || pairingId === undefined
        ? undefined
        : { type: 'desktop-hello', pairingId, desktopDeviceId }
    }
    case 'mobile-init':
      try {
        return parseMobilePairingInit(value)
      } catch {
        return undefined
      }
    case 'desktop-accept':
      try {
        return parseDesktopPairingAccept(value)
      } catch {
        return undefined
      }
    case 'desktop-revoke': {
      if (!hasExactKeys(value, ['type', 'version', 'pairingId'])) return undefined
      const pairingId = readPublicId(value.pairingId)
      return pairingId === undefined ? undefined : { type: 'desktop-revoke', pairingId }
    }
    default:
      return undefined
  }
}

/**
 * Parse one client message. Relay frames use the shared protocol parser; the
 * small control vocabulary establishes, confirms, or ends a pairing.
 *
 * @param value - WebSocket string payload.
 * @returns One validated control or opaque encrypted frame.
 */
export function parseRelayMessage(value: string): RelayMessage | undefined {
  if (value.length > MAX_RELAY_MESSAGE_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if ('type' in parsed) {
    if (value.length > MAX_CONTROL_MESSAGE_BYTES) return undefined
    const control = parseControl(parsed)
    return control === undefined ? undefined : { kind: 'control', control }
  }
  try {
    return { kind: 'frame', frame: parseRelayFrame(parsed) }
  } catch {
    return undefined
  }
}
