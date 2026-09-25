/** Trusted Host remote-gateway types. @module @deepseek-ai/dsh-remote-gateway/types */

import type { RemoteDeviceId, RemoteDeviceIncarnation } from '@deepseek-ai/dsh-remote-devices'
import type { RemoteWireEnvelope, RemoteWireId } from '@deepseek-ai/dsh-remote-wire'

/** Authenticated route facts supplied by the encrypted relay connection provider. */
export interface TrustedRemoteRoute {
  /** Opaque relay route identifier. */
  readonly routeId: string
  /** Route generation that invalidates superseded relay routes. */
  readonly generation: number
  /** Monotonic connection epoch minted by the authenticated connection provider. */
  readonly connectionEpoch: number
}

/** Immutable public identity facts the connection provider authenticated for this enrollment. */
export interface TrustedRemotePeerIdentity {
  /** Remote device identifier claimed by the authenticated peer. */
  readonly deviceId: RemoteDeviceId
  /** Host-minted enrollment generation bound into the authenticated connection. */
  readonly enrollmentId: RemoteDeviceIncarnation
  /** Authenticated remote signing public key. */
  readonly signingPublicKey: string
  /** Authenticated remote key-agreement public key. */
  readonly agreementPublicKey: string
}

/**
 * A synchronous, connection-local revocation fence supplied to every write.
 * A provider must observe this fence immediately before it commits ciphertext
 * to its carrier; it may not report a write as committed if the fence is no
 * longer active.
 */
export interface TrustedRemoteSendFence {
  /** True only until the gateway closes, supersedes, or revokes this connection. */
  active: boolean
  /** Monotonic local fence generation for provider assertions. */
  generation: number
  /** Aborts synchronously when the gateway closes or revokes this connection. */
  abortSignal: AbortSignal
}

/**
 * Provider receipt for one encrypted carrier write. `committed-before-fence`
 * means the provider can prove it handed ciphertext to the carrier while the
 * supplied fence was active. A provider that cannot prove that returns
 * `not-committed`.
 */
export type TrustedRemoteSendResult =
  | { readonly status: 'committed-before-fence' }
  | { readonly status: 'not-committed' }

/** A bidirectional encrypted connection after relay authentication and decryption. */
export interface TrustedRemoteConnection {
  /** Remote identity proven by the connection provider before the gateway sees frames. */
  readonly peer: TrustedRemotePeerIdentity
  /** Authenticated relay route and connection freshness facts. */
  readonly route: TrustedRemoteRoute
  /** Read the provider-decrypted remote-wire envelopes until disconnect or abort. */
  receive(signal: AbortSignal): AsyncIterable<RemoteWireEnvelope>
  /**
   * Send one gateway-created remote-wire envelope through the encrypted carrier.
   * The provider must fence the physical write with `fence` and return an
   * accurate commit receipt, even when close races an in-flight write.
   */
  send(envelope: RemoteWireEnvelope, fence: TrustedRemoteSendFence): Promise<TrustedRemoteSendResult>
  /** Stop this physical connection without retrying it. */
  close(reason: RemoteGatewayCloseReason): Promise<void>
}

/** The sole connection-provider interface required by the Host gateway. */
export interface TrustedRemoteConnectionProvider {
  /** Yield only mutually-authenticated, route-authorized, decrypted connections. */
  accept(signal: AbortSignal): AsyncIterable<TrustedRemoteConnection>
}

/** Explicit ways the gateway ends a trusted connection. */
export type RemoteGatewayCloseReason =
  | 'gateway-disposed'
  | 'protocol-rejected'
  | 'unauthorized-device'
  | 'superseded'
  | 'transport-failed'

/** Gateway audit operation kind. It never contains an untrusted payload or secret. */
export type RemoteGatewayAuditOperation =
  | 'connection'
  | 'request'
  | 'approval'
  | 'client-response'
  | 'device-control'
  | 'stream-ack'
  | 'event-delivery'

/** Post-decision audit record identifying the authenticated requesting device and route. */
export interface RemoteGatewayAuditEntry {
  /** Authenticated remote device that caused the operation. */
  readonly deviceId: RemoteDeviceId
  /** Authenticated relay route facts attached to the operation. */
  readonly route: TrustedRemoteRoute
  /** Gateway operation that was accepted, refused, or completed. */
  readonly operation: RemoteGatewayAuditOperation
  /** Remote correlation id when the operation has one. */
  readonly requestId?: RemoteWireId
  /** Final outcome of the gateway decision. */
  readonly outcome: 'accepted' | 'rejected' | 'completed'
  /** Stable implementation-owned reason code. */
  readonly reason: string
}

/** Deployment-selected memory bounds for one live Host gateway. */
export interface RemoteGatewayOptions {
  /** Maximum retained completed idempotency entries for one trusted device. */
  readonly maxIdempotencyEntriesPerDevice: number
  /** Maximum ordered Host-event entries retained for one trusted device. */
  readonly maxEventEntriesPerDevice: number
}

/** Status exposed for a connected remote client without exposing its traffic. */
export interface RemoteGatewayConnectionStatus {
  /** Authenticated device currently attached to this connection. */
  readonly deviceId: RemoteDeviceId
  /** Authenticated route facts of the current physical connection. */
  readonly route: TrustedRemoteRoute
  /** Largest Host-event cursor retained for this device. */
  readonly latestCursor: number
  /** Largest contiguous event cursor the client durably acknowledged. */
  readonly acknowledgedCursor: number
  /** Whether the client requested its fresh host snapshot. */
  readonly synchronized: boolean
}
