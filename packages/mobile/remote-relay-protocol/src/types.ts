/** Trusted remote relay v3 types. @module @deepseek-ai/dsh-remote-relay-protocol/types */

import type { RemoteWireEnvelope } from '@deepseek-ai/dsh-remote-wire'

/** The only relay transport version accepted by this package. */
export const REMOTE_RELAY_PROTOCOL_VERSION = 3 as const
/** X25519 private and public key byte length. */
export const REMOTE_RELAY_X25519_BYTES = 32
/** RFC 8439 ChaCha20-Poly1305 IETF nonce byte length. */
export const REMOTE_RELAY_NONCE_BYTES = 12
/** Largest opaque application ciphertext, excluding its nonce and JSON carriage. */
export const MAX_REMOTE_RELAY_CIPHERTEXT_BYTES = 9 * 1024 * 1024
/** Largest accepted ciphertext sequence and connection epoch. */
export const MAX_REMOTE_RELAY_SEQUENCE = 2_147_483_647

/** A public role in one encrypted route. */
export type RemoteRelayPeer = 'host' | 'device'

/** Immutable route coordinates supplied by the Host's trusted-connection provider. */
export interface RemoteRelayRoute {
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
}

/** Public identity material known to a peer before an authenticated connection begins. */
export interface RemoteRelayPeerIdentity {
  readonly deviceId: string
  /** Host-minted immutable identity incarnation. Device re-enrollment always receives a new value. */
  readonly enrollmentId: string
  readonly agreementPublicKey: string
}

/** Protected X25519 operation provider. It never exposes the local private key. */
export interface RemoteRelayAgreementProvider {
  /** Canonical base64url X25519 public key. */
  readonly publicKey: string
  /**
   * Derive a fresh caller-owned 32-byte X25519 secret for a canonical peer public key.
   * @param peerAgreementPublicKey - canonical base64url X25519 public key.
   * @returns fresh caller-owned shared-secret bytes for immediate KDF consumption.
   */
  deriveSharedSecret(peerAgreementPublicKey: string): Uint8Array
}

/** Locally protected identity used without exposing an X25519 private key. */
export interface RemoteRelayIdentity {
  readonly deviceId: string
  /** Host-minted immutable identity incarnation bound into every authenticated relay message. */
  readonly enrollmentId: string
  readonly agreement: RemoteRelayAgreementProvider
}

/** A platform-supplied cryptographically secure random source. */
export interface RemoteRelayRandomSource {
  /** @param length - exact count of fresh random bytes requested. @returns fresh cryptographic random bytes. */
  randomBytes(length: number): Uint8Array
}

/** Minimal WebSocket adapter, allowing Node, browser, React Native, and native hosts to share this protocol. */
export interface RemoteRelaySocket {
  /** @param data - exact JSON WebSocket text frame. */
  send(data: string): void
  /** @param code - optional WebSocket close code. @param reason - non-sensitive close reason. */
  close(code?: number, reason?: string): void
  /** @param signal - cancellation signal for waiting. @returns incoming text frames in arrival order. */
  receive(signal?: AbortSignal): AsyncIterable<string>
}

/** First flight from a remote device. The relay forwards it but never stores it. */
export interface RemoteRelayHello {
  readonly version: 3
  readonly type: 'hello'
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
  readonly senderDeviceId: string
  readonly senderEnrollmentId: string
  readonly recipientDeviceId: string
  readonly recipientEnrollmentId: string
  readonly ephemeralPublicKey: string
  readonly nonce: string
}

/** Host response committing to one device hello. */
export interface RemoteRelayWelcome {
  readonly version: 3
  readonly type: 'welcome'
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
  readonly senderDeviceId: string
  readonly senderEnrollmentId: string
  readonly recipientDeviceId: string
  readonly recipientEnrollmentId: string
  readonly ephemeralPublicKey: string
  readonly nonce: string
}

/** Encrypted key-confirmation flight. A Host exposes a connection only after validating this message. */
export interface RemoteRelayReady {
  readonly version: 3
  readonly type: 'ready'
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
  readonly senderDeviceId: string
  readonly senderEnrollmentId: string
  readonly recipientDeviceId: string
  readonly recipientEnrollmentId: string
  readonly nonce: string
  readonly ciphertext: string
}

/** Encrypted Host completion flight. The device is not live until it validates this message. */
export interface RemoteRelayFinish {
  readonly version: 3
  readonly type: 'finish'
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
  readonly senderDeviceId: string
  readonly senderEnrollmentId: string
  readonly recipientDeviceId: string
  readonly recipientEnrollmentId: string
  readonly nonce: string
  readonly ciphertext: string
}

/** Encrypted device acknowledgement after it validates the Host finish. */
export interface RemoteRelayAck {
  readonly version: 3
  readonly type: 'ack'
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
  readonly senderDeviceId: string
  readonly senderEnrollmentId: string
  readonly recipientDeviceId: string
  readonly recipientEnrollmentId: string
  readonly nonce: string
  readonly ciphertext: string
}

/** Encrypted Host commit after it validates the device acknowledgement. */
export interface RemoteRelayCommit {
  readonly version: 3
  readonly type: 'commit'
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
  readonly senderDeviceId: string
  readonly senderEnrollmentId: string
  readonly recipientDeviceId: string
  readonly recipientEnrollmentId: string
  readonly nonce: string
  readonly ciphertext: string
}

/** Encrypted device proof that it received and authenticated the Host commit. */
export interface RemoteRelayConfirm {
  readonly version: 3
  readonly type: 'confirm'
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
  readonly senderDeviceId: string
  readonly senderEnrollmentId: string
  readonly recipientDeviceId: string
  readonly recipientEnrollmentId: string
  readonly nonce: string
  readonly ciphertext: string
}

/** Encrypted Host receipt emitted only after its durable epoch finalizer succeeds. */
export interface RemoteRelayReceipt {
  readonly version: 3
  readonly type: 'receipt'
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
  readonly senderDeviceId: string
  readonly senderEnrollmentId: string
  readonly recipientDeviceId: string
  readonly recipientEnrollmentId: string
  readonly nonce: string
  readonly ciphertext: string
}

/** Opaque encrypted remote-wire frame. The relay does not retain or decrypt its ciphertext. */
export interface RemoteRelayCiphertext {
  readonly version: 3
  readonly type: 'ciphertext'
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
  readonly senderDeviceId: string
  readonly senderEnrollmentId: string
  readonly recipientDeviceId: string
  readonly recipientEnrollmentId: string
  readonly sequence: number
  readonly nonce: string
  readonly ciphertext: string
}

/** Exact V3 WebSocket payloads accepted by a blind relay. */
export type RemoteRelayMessage =
  | RemoteRelayHello
  | RemoteRelayWelcome
  | RemoteRelayReady
  | RemoteRelayFinish
  | RemoteRelayAck
  | RemoteRelayCommit
  | RemoteRelayConfirm
  | RemoteRelayReceipt
  | RemoteRelayCiphertext

/** Stable errors that never include route capabilities, keys, or received bytes. */
export type RemoteRelayProtocolErrorCode =
  | 'REMOTE_RELAY_MALFORMED'
  | 'REMOTE_RELAY_UNSUPPORTED_VERSION'
  | 'REMOTE_RELAY_ID_INVALID'
  | 'REMOTE_RELAY_ROUTE_INVALID'
  | 'REMOTE_RELAY_EPOCH_INVALID'
  | 'REMOTE_RELAY_SEQUENCE_INVALID'
  | 'REMOTE_RELAY_KEY_INVALID'
  | 'REMOTE_RELAY_CIPHERTEXT_INVALID'
  | 'REMOTE_RELAY_PEER_INVALID'
  | 'REMOTE_RELAY_HANDSHAKE_INVALID'
  | 'REMOTE_RELAY_DECRYPT_FAILED'
  | 'REMOTE_RELAY_REPLAY'
  | 'REMOTE_RELAY_SOCKET_CLOSED'

/** Mutable Host-owned close fence sampled immediately before one socket write. */
export interface RemoteRelaySendFence {
  active: boolean
  generation: number
  abortSignal: AbortSignal
}

/** Result of attempting one encrypted WebSocket write under a close fence. */
export type RemoteRelaySendResult =
  | { readonly status: 'committed-before-fence' }
  | { readonly status: 'not-committed' }

/** A fully mutually authenticated, forward-secret connection ready to carry strict remote-wire envelopes. */
export interface TrustedRemoteRelayConnection {
  /** Authenticated immutable peer identity, including the Host-minted enrollment incarnation. */
  readonly peer: RemoteRelayPeerIdentity
  readonly deviceId: string
  readonly route: RemoteRelayRoute
  /** @param signal - cancellation signal while waiting for remote data. @returns strict decrypted v3 envelopes. */
  receive(signal?: AbortSignal): AsyncIterable<RemoteWireEnvelope>
  /**
   * Serialize one encrypted write against a Host-owned close fence.
   * `committed-before-fence` means the local WebSocket accepted the bytes before
   * the sampled fence changed, not remote delivery acknowledgement.
   * @param envelope - strict v3 envelope sent after encryption and sequence allocation.
   * @param fence - Host revocation and replacement fence sampled immediately before writing.
   * @returns whether a socket write committed before the fence closed.
   */
  send(envelope: RemoteWireEnvelope, fence: RemoteRelaySendFence): Promise<RemoteRelaySendResult>
  /** @param reason - non-sensitive close reason. */
  close(reason?: string): void
}

/**
 * Host-owned durable epoch finalizer invoked only after an authenticated device
 * confirmation. It must atomically record the supplied epoch as final or reject.
 */
export interface RemoteRelayEpochFinalizer {
  /** @param route - authenticated route coordinates. @param peer - authenticated device identity. */
  finalize(route: RemoteRelayRoute, peer: RemoteRelayPeerIdentity): Promise<void>
}
