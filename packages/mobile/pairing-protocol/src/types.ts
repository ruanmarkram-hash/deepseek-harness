/** Accountless mobile pairing wire vocabulary. @module @deepseek-ai/dsh-pairing-protocol/types */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** The only version accepted by this package. */
export const PAIRING_PROTOCOL_VERSION = 2 as const

/** Maximum lifetime of a QR bootstrap after the desktop creates it. */
export const MAX_BOOTSTRAP_TTL_MS = 5 * 60 * 1_000

/** Byte length of an X25519 public or private key. */
export const PAIRING_X25519_KEY_BYTES = 32

/** Byte length of an XChaCha20-Poly1305 nonce. */
export const PAIRING_PROOF_NONCE_BYTES = 24

/** Byte length of the Poly1305 authentication tag appended to ciphertext. */
export const PAIRING_PROOF_TAG_BYTES = 16

/** Largest encrypted key-confirmation proof, excluding its nonce. */
export const MAX_PAIRING_PROOF_CIPHERTEXT_BYTES = 512

/** Largest ciphertext byte payload the transport may carry in one frame. */
export const MAX_FRAME_CIPHERTEXT_BYTES = 64 * 1_024

/** Largest accepted per-direction frame sequence number. */
export const MAX_RELAY_SEQUENCE = 2_147_483_647

/** Largest UTF-8 text body accepted from a mobile user in one turn request. */
export const MAX_MOBILE_SESSION_SEND_TEXT_BYTES = 8 * 1_024

/** Largest UTF-8 text chunk delivered to a phone in one incremental update. */
export const MAX_MOBILE_SESSION_DELTA_BYTES = 8 * 1_024

/** Largest UTF-8 text body retained for one message in a session snapshot. */
export const MAX_MOBILE_SESSION_SNAPSHOT_TEXT_BYTES = 2 * 1_024

/** Largest UTF-8 title, human-readable error, or opaque identifier field. */
export const MAX_MOBILE_SESSION_SHORT_TEXT_BYTES = 512

/** Largest number of safe text messages included in one session snapshot. */
export const MAX_MOBILE_SESSION_SNAPSHOT_MESSAGES = 24

/** Public, opaque identifier for a desktop-created pairing rendezvous. */
export type PairingId = Branded<'PairingId'>

/** Public, opaque identifier for a device participating in a pairing. */
export type PairingDeviceId = Branded<'PairingDeviceId'>

/** Short-lived relay bearer token. It is secret and must never be persisted or logged. */
export type PairingRelayToken = Branded<'PairingRelayToken'>

/** Canonical base64url X25519 public key carried by the pairing protocol. */
export type PairingEphemeralPublicKey = Branded<'PairingEphemeralPublicKey'>

/** Canonical base64url nonce-prefixed XChaCha20-Poly1305 proof. */
export type PairingEncryptedProof = Branded<'PairingEncryptedProof'>

/** Phone operations that a desktop may approve during pairing. */
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
  desktopEphemeralPublicKey: string
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
  desktopEphemeralPublicKey: PairingEphemeralPublicKey
  relayToken: PairingRelayToken
  expiresAt: number
  capabilities: readonly MobilePairingCapability[]
}

/** Plain mobile initialization fields before WebSocket control validation. */
export interface MobilePairingInitInput {
  type: 'mobile-init'
  version: number
  pairingId: string
  mobileDeviceId: string
  mobileEphemeralPublicKey: string
  capabilities: readonly string[]
  encryptedProof: string
}

/** Validated mobile initialization forwarded unchanged to the desktop. */
export interface MobilePairingInit {
  type: 'mobile-init'
  version: typeof PAIRING_PROTOCOL_VERSION
  pairingId: PairingId
  mobileDeviceId: PairingDeviceId
  mobileEphemeralPublicKey: PairingEphemeralPublicKey
  capabilities: readonly MobilePairingCapability[]
  encryptedProof: PairingEncryptedProof
}

/** Plain desktop acceptance fields before WebSocket control validation. */
export interface DesktopPairingAcceptInput {
  type: 'desktop-accept'
  version: number
  pairingId: string
  mobileDeviceId: string
  encryptedProof: string
}

/** Validated desktop acceptance forwarded unchanged to the mobile device. */
export interface DesktopPairingAccept {
  type: 'desktop-accept'
  version: typeof PAIRING_PROTOCOL_VERSION
  pairingId: PairingId
  mobileDeviceId: PairingDeviceId
  encryptedProof: PairingEncryptedProof
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

/** A closed status vocabulary for a text-only session turn. */
export type MobileSessionTurnState =
  | 'idle'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** A closed, non-sensitive error vocabulary for mobile session delivery. */
export type MobileSessionErrorCode =
  | 'SESSION_UNAVAILABLE'
  | 'TURN_REJECTED'
  | 'TURN_FAILED'
  | 'PAIRING_REVOKED'

/** One safe conversation item included in a desktop-produced snapshot. */
export interface MobileSessionSnapshotMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

/** A nullable, text-only summary of the current turn. */
export interface MobileSessionActiveTurn {
  id: string
  state: MobileSessionTurnState
}

/** Full safe session state sent from the desktop to the paired phone. */
export interface DesktopSessionSnapshot {
  type: 'session-snapshot'
  sessionHandle: string
  requestId: string
  title: string
  messages: readonly MobileSessionSnapshotMessage[]
  activeTurn: MobileSessionActiveTurn | null
}

/** Incremental desktop text for an existing paired session turn. */
export interface DesktopSessionTextDelta {
  type: 'text-delta'
  sessionHandle: string
  requestId: string
  turnId: string
  delta: string
}

/** An exact desktop report of an existing paired session turn state. */
export interface DesktopSessionTurnState {
  type: 'turn-state'
  sessionHandle: string
  requestId: string
  turnId: string
  state: MobileSessionTurnState
}

/** A safe desktop error related to one paired session request. */
export interface DesktopSessionError {
  type: 'error'
  sessionHandle: string
  requestId: string
  code: MobileSessionErrorCode
  message: string
}

/** Every desktop-to-mobile plaintext accepted by the mobile session envelope. */
export type DesktopToMobileSessionMessage =
  | DesktopSessionSnapshot
  | DesktopSessionTextDelta
  | DesktopSessionTurnState
  | DesktopSessionError

/** A mobile text submission for the one desktop-selected local session. */
export interface MobileSessionSendText {
  type: 'send-text'
  sessionHandle: string
  requestId: string
  text: string
}

/** A mobile request to cancel a known text-only session turn. */
export interface MobileSessionCancelTurn {
  type: 'cancel-turn'
  sessionHandle: string
  requestId: string
  turnId: string
}

/** Every mobile-to-desktop plaintext accepted by the mobile session envelope. */
export type MobileToDesktopSessionMessage =
  | MobileSessionSendText
  | MobileSessionCancelTurn

/** Closed parser, sequencing, and key-confirmation failures safe to show without raw input. */

/** Closed parser, sequencing, and key-confirmation failures safe to show without raw input. */
export type PairingProtocolErrorCode =
  | 'PAIRING_QR_MALFORMED'
  | 'PAIRING_QR_EXPIRED'
  | 'PAIRING_QR_UNSUPPORTED_VERSION'
  | 'PAIRING_CAPABILITY_DENIED'
  | 'PAIRING_CONTROL_MALFORMED'
  | 'PAIRING_CONTROL_UNSUPPORTED_VERSION'
  | 'PAIRING_KEY_INVALID'
  | 'PAIRING_PROOF_INVALID'
  | 'PAIRING_KEY_CONFIRMATION_REQUIRED'
  | 'RELAY_FRAME_MALFORMED'
  | 'RELAY_FRAME_UNSUPPORTED_VERSION'
  | 'RELAY_FRAME_SEQUENCE_INVALID'
  | 'RELAY_FRAME_SEQUENCE_REPLAY'
  | 'RELAY_FRAME_SEQUENCE_GAP'
  | 'RELAY_FRAME_SEQUENCE_EXHAUSTED'
  | 'MOBILE_SESSION_MESSAGE_MALFORMED'
  | 'MOBILE_SESSION_FRAME_INVALID'
  | 'MOBILE_SESSION_KEY_ERASED'
