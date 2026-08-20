/** Accountless mobile pairing wire vocabulary. @module @deepseek-ai/dsh-pairing-protocol/types */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** The only version accepted by this package. */
export const PAIRING_PROTOCOL_VERSION = 1 as const

/** Maximum lifetime of a QR bootstrap after the desktop creates it. */
export const MAX_BOOTSTRAP_TTL_MS = 5 * 60 * 1_000

/** Largest ciphertext byte payload the transport may carry in one frame. */
export const MAX_FRAME_CIPHERTEXT_BYTES = 64 * 1_024

/** Largest accepted per-direction frame sequence number. */
export const MAX_RELAY_SEQUENCE = 2_147_483_647

/** Public, opaque identifier for a desktop-created pairing rendezvous. */
export type PairingId = Branded<'PairingId'>

/** Public, opaque identifier for a device participating in a pairing. */
export type PairingDeviceId = Branded<'PairingDeviceId'>

/** Short-lived relay bearer token. It is secret and must never be persisted or logged. */
export type PairingRelayToken = Branded<'PairingRelayToken'>

/** Version-one phone operations that a desktop may approve during pairing. */
export const MOBILE_PAIRING_CAPABILITIES = [
  'session:read',
  'session:subscribe',
  'turn:send',
  'turn:cancel',
] as const

/** One allowlisted operation available to an approved mobile device. */
export type MobilePairingCapability = typeof MOBILE_PAIRING_CAPABILITIES[number]

/** Plain bootstrap fields before external QR validation. */
export interface PairingBootstrapInput {
  version: number
  relayUrl: string
  pairingId: string
  desktopDeviceId: string
  relayToken: string
  expiresAt: number
  capabilities: readonly string[]
}

/** A validated, short-lived desktop-issued QR bootstrap. */
export interface PairingBootstrap {
  version: typeof PAIRING_PROTOCOL_VERSION
  relayUrl: string
  pairingId: PairingId
  desktopDeviceId: PairingDeviceId
  relayToken: PairingRelayToken
  expiresAt: number
  capabilities: readonly MobilePairingCapability[]
}

/** Plain encrypted frame fields before external relay-message validation. */
export interface RelayFrameInput {
  version: number
  pairingId: string
  senderDeviceId: string
  recipientDeviceId: string
  sequence: number
  ciphertext: string
}

/** Validated opaque frame forwarded unchanged by the relay. */
export interface RelayFrame {
  version: typeof PAIRING_PROTOCOL_VERSION
  pairingId: PairingId
  senderDeviceId: PairingDeviceId
  recipientDeviceId: PairingDeviceId
  sequence: number
  ciphertext: string
}

/** Closed parser and sequencing failures that callers can map without inspecting sensitive input. */
export type PairingProtocolErrorCode =
  | 'PAIRING_QR_MALFORMED'
  | 'PAIRING_QR_EXPIRED'
  | 'PAIRING_QR_UNSUPPORTED_VERSION'
  | 'PAIRING_CAPABILITY_DENIED'
  | 'RELAY_FRAME_MALFORMED'
  | 'RELAY_FRAME_UNSUPPORTED_VERSION'
  | 'RELAY_FRAME_SEQUENCE_INVALID'
  | 'RELAY_FRAME_SEQUENCE_REPLAY'
  | 'RELAY_FRAME_SEQUENCE_GAP'
  | 'RELAY_FRAME_SEQUENCE_EXHAUSTED'
