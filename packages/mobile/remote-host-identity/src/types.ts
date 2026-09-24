/** Public remote-Host identity and local enrollment values. @module @deepseek-ai/dsh-remote-host-identity/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RemoteDeviceEnrollment, RemoteDeviceRecord } from '@deepseek-ai/dsh-remote-devices'

/** Opaque public identifier of the Host's long-lived remote identity. */
export type RemoteHostDeviceId = Branded<'RemoteHostDeviceId'>

/** Opaque relay route identifier created for one local enrollment flow. */
export type RemoteRouteId = Branded<'RemoteRouteId'>

/** Public static identity that an enrolled remote device authenticates. */
export interface RemoteHostPublicIdentity {
  /** Opaque Host device id. */
  readonly hostDeviceId: RemoteHostDeviceId
  /** Base64url Ed25519 verification key. */
  readonly signingPublicKey: string
  /** Base64url X25519 agreement key. */
  readonly agreementPublicKey: string
}

/** One ephemeral route credential set for a local enrollment exchange. */
export interface RemoteEnrollmentRoute {
  /** Host-only relay authorization token. Never transfer this record to a phone. */
  readonly hostAuthToken: string
  /** Phone-transferable invitation with no Host authorization token. */
  readonly invitation: RemoteEnrollmentInvitation
}

/** Phone-transferable local-enrollment invitation. */
export interface RemoteEnrollmentInvitation {
  /** Route id supplied to the blind relay. */
  readonly routeId: RemoteRouteId
  /** Remote-client relay authorization token. */
  readonly clientAuthToken: string
  /** Canonical instant after which both relay tokens and local confirmation are invalid. */
  readonly expiresAt: string
  /** Public identity that the remote client must authenticate. */
  readonly host: RemoteHostPublicIdentity
}

/** Local confirmation material for one remote device. */
export interface RemoteEnrollmentConfirmation {
  /** Current route returned by the local enrollment controller. */
  readonly route: RemoteEnrollmentInvitation
  /** Device identity collected by a physical-local pairing UI. */
  readonly device: RemoteDeviceEnrollment
}

/** Closed failures from Keychain-backed Host identity operations. */
export type RemoteHostIdentityErrorCode =
  | 'REMOTE_HOST_IDENTITY_UNAVAILABLE'
  | 'REMOTE_HOST_IDENTITY_KEYCHAIN_FAILURE'
  | 'REMOTE_HOST_IDENTITY_CORRUPT'
  | 'REMOTE_HOST_IDENTITY_INPUT_INVALID'

/** Local controller interface consumed by a future Host Devices UI. */
export interface RemoteEnrollmentControllerApi {
  /** Mint one non-durable relay route credential set. */
  issueRoute(): Promise<RemoteEnrollmentRoute>
  /** Persist a locally confirmed remote public identity. */
  confirm(input: RemoteEnrollmentConfirmation): Promise<RemoteDeviceRecord>
}
