/** Durable records and change events for trusted remote DSH devices. @module @deepseek-ai/dsh-remote-devices/types */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque public identifier of one enrolled remote device. */
export type RemoteDeviceId = Branded<'RemoteDeviceId'>

/** Opaque Host-minted generation identifying one specific device enrollment. */
export type RemoteDeviceIncarnation = Branded<'RemoteDeviceIncarnation'>

/** Immutable public metadata for a phone or other remote owner device. */
export interface RemoteDeviceRecord {
  /** Opaque device id minted by its remote client. */
  readonly id: RemoteDeviceId
  /** Host-minted opaque enrollment generation. Re-enrollment always changes it. */
  readonly incarnation: RemoteDeviceIncarnation
  /** Human-selected label shown in the local Host devices screen. */
  readonly label: string
  /** Canonical public signing key. The Host never stores this device's private key. */
  readonly signingPublicKey: string
  /** Canonical public key-agreement key. The Host never stores this device's private key. */
  readonly agreementPublicKey: string
  /** Canonical ISO-8601 instant when physical-local enrollment completed. */
  readonly enrolledAt: string
  /** Canonical ISO-8601 instant of the latest authenticated remote presence, if any. */
  readonly lastSeenAt?: string
}

/** Physical-local enrollment material that becomes one trusted device record. */
export interface RemoteDeviceEnrollment {
  /** Remote client-provided opaque id. */
  readonly id: string
  /** Local user-visible device label. */
  readonly label: string
  /** Remote client public signing key. */
  readonly signingPublicKey: string
  /** Remote client public key-agreement key. */
  readonly agreementPublicKey: string
}

/** A post-durability change emitted by the Host-owned device directory. */
export type RemoteDeviceChange =
  | { readonly type: 'enrolled'; readonly device: RemoteDeviceRecord }
  | { readonly type: 'seen'; readonly device: RemoteDeviceRecord }
  | { readonly type: 'revoked'; readonly deviceId: RemoteDeviceId }

/** Closed failures from a trusted-device directory operation. */
export type RemoteDeviceDirectoryErrorCode =
  | 'REMOTE_DEVICE_INVALID'
  | 'REMOTE_DEVICE_ALREADY_ENROLLED'
  | 'REMOTE_DEVICE_KEY_ALREADY_ENROLLED'
  | 'REMOTE_DEVICE_NOT_FOUND'
  | 'REMOTE_DEVICE_TIME_INVALID'
