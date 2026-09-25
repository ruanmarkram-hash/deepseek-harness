/** macOS Keychain Host identity and local-only remote enrollment for DSH. @module @deepseek-ai/dsh-remote-host-identity */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteEnrollmentController } from './controller.ts'
import { RemoteHostIdentityError } from './error.ts'
import { RemoteHostIdentity } from './identity.ts'

export { RemoteEnrollmentController } from './controller.ts'
export { RemoteHostIdentity } from './identity.ts'
export type { ProtectedRemoteHostIdentityHandle } from './identity.ts'
export { RemoteHostIdentityError, isRemoteHostIdentityError } from './error.ts'
export type {
  RemoteEnrollmentConfirmation,
  RemoteEnrollmentControllerApi,
  RemoteEnrollmentInvitation,
  RemoteEnrollmentRoute,
  RemoteHostDeviceId,
  RemoteHostIdentityErrorCode,
  RemoteHostPublicIdentity,
  RemoteRouteId,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** macOS Keychain-backed static identity for this DSH Host profile. */
    remoteHostIdentity: RemoteHostIdentity
    /** Local-only issuer and confirmation controller for remote enrollment. */
    remoteEnrollment: RemoteEnrollmentController
  }
}

/** Cordis plugin name. */
export const name = 'remote-host-identity'
/** Identity opens only after the Host's durable public device directory exists. */
export const inject = ['remoteDevices']

/**
 * Mount a Host identity from an injected native secure-store provider.
 * The plugin creates no HTTP endpoint, relay connection, QR code, or durable
 * relay token; a Host Devices screen receives `ctx.remoteEnrollment` later.
 * @param ctx - Web Host context.
 * @returns resolution once Keychain identity is available.
 */
export function apply(_ctx: Context): Promise<void> {
  return Promise.reject(new RemoteHostIdentityError('REMOTE_HOST_IDENTITY_UNAVAILABLE', 'a signed native Keychain provider is required for remote Host identity'))
}
