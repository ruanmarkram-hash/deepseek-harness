/** Host V3 route allocation, protected-helper, and gateway-provider types. @module @deepseek-ai/dsh-remote-host-v3/types */

import type { RemoteDeviceId, RemoteDeviceIncarnation } from '@deepseek-ai/dsh-remote-devices'
import type { TrustedRemoteConnectionProvider } from '@deepseek-ai/dsh-remote-gateway'

/**
 * Public receipt emitted by the inherited runtime pipe after it durably enrolls one locally-confirmed device.
 * The signed Host must bind its route and phone invitation to these exact Host-minted incarnations.
 */
export interface RemoteHostV3EnrollmentReceipt {
  /** Public device identity confirmed by the signed Host locally. */
  readonly deviceId: RemoteDeviceId
  /** Local visible label persisted with the device identity. */
  readonly label: string
  /** Canonical 32-byte Ed25519 public key. */
  readonly signingPublicKey: string
  /** Canonical 32-byte X25519 public key. */
  readonly agreementPublicKey: string
  /** Host-minted device enrollment incarnation. */
  readonly deviceEnrollmentId: RemoteDeviceIncarnation
  /** The allocator's sole Host enrollment incarnation authority. */
  readonly hostEnrollmentId: string
}

/** Public, durable coordinates for exactly one Host-to-device relay route. */
export interface RemoteHostV3Route {
  /** Opaque Cloudflare Durable Object route id. */
  readonly routeId: string
  /** Device whose full public enrollment tuple owns this route. */
  readonly deviceId: RemoteDeviceId
  /** Immutable enrollment incarnation that invalidates a revoked device route. */
  readonly deviceEnrollmentId: RemoteDeviceIncarnation
  /** Protected Host identity id recorded when the route was created. */
  readonly hostDeviceId: string
  /** Allocator-owned sole Host identity incarnation bound into relay messages. */
  readonly hostEnrollmentId: string
  /** Relay credential generation. Native code rotates it without exposing Host tokens. */
  readonly generation: number
  /** Last relay epoch known to have mutually completed. */
  readonly lastConnectionEpoch: number
  /** Epoch currently attempting mutual completion, if any. */
  readonly pendingConnectionEpoch?: number
  /** Canonical local creation instant. */
  readonly createdAt: string
}

/** Public projection of an epoch already finalized by the signed native transport. */
export type RemoteHostV3FinalizedEpoch = Pick<RemoteHostV3Route, 'routeId' | 'deviceId' | 'deviceEnrollmentId' | 'hostDeviceId' | 'hostEnrollmentId' | 'generation'> & {
  /** Authenticated native transport epoch; never an uncompleted reservation. */
  readonly connectionEpoch: number
}

/** Read end of the private transport handed from the signed Host app to its verified runtime child. */
export interface RemoteHostV3RuntimePipe extends TrustedRemoteConnectionProvider {
  /** Fixed handoff kind; the pipe is inherited at process launch, never discovered through a socket path or localhost port. */
  readonly kind: 'inherited-private-pipe'
}

/** Signed Host-app ownership supplied at runtime, never by an unsigned `dsh web` process. */
export interface RemoteHostV3NativeProvider {
  /** Absolute path of the signed DSH Host.app executable that spawned this runtime child. */
  readonly hostAppPath: string
  /** Already authenticated and decrypted V3 connections from the inherited private pipe. */
  readonly runtimePipe: RemoteHostV3RuntimePipe
}

/** Public local status service. Route provisioning and tokens remain owned by the signed Host app. */
export interface RemoteHostV3ControllerApi {
  /** @returns durable public routes without route tokens, private keys, or ciphertext. */
  listRoutes(): readonly RemoteHostV3Route[]
}
