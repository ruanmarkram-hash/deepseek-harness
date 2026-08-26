/** Host-local remote enrollment controller with no network listener. @module @deepseek-ai/dsh-remote-host-identity/controller */

import { randomBytes } from 'node:crypto'
import type { RemoteDeviceDirectory, RemoteDeviceRecord } from '@deepseek-ai/dsh-remote-devices'
import { RemoteHostIdentityError } from './error.ts'
import { RemoteHostIdentity } from './identity.ts'
import type { RemoteEnrollmentConfirmation, RemoteEnrollmentControllerApi, RemoteEnrollmentInvitation, RemoteEnrollmentRoute, RemoteRouteId } from './types.ts'

/**
 * Creates ephemeral relay credentials and persists only a locally-confirmed
 * remote public identity. Routes live only in controller memory until one
 * confirmation consumes them; the device directory never receives tokens.
 */
export class RemoteEnrollmentController implements RemoteEnrollmentControllerApi {
  /** In-memory one-time routes; process restart intentionally invalidates every unconfirmed route. */
  private readonly pendingRoutes = new Map<RemoteRouteId, RemoteEnrollmentRoute>()

  /**
   * @param identity - Keychain-only Host identity.
   * @param devices - Durable public trusted-device directory.
   * @param random - Injectable opaque-value source.
   */
  constructor(
    private readonly identity: RemoteHostIdentity,
    private readonly devices: RemoteDeviceDirectory,
    private readonly random: (size: number) => Uint8Array = randomBytes,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** @inheritdoc */
  issueRoute(): Promise<RemoteEnrollmentRoute> {
    this.dropExpiredRoutes()
    if (this.pendingRoutes.size >= MAX_PENDING_ROUTES) {
      const oldest = this.pendingRoutes.keys().next()
      if (!oldest.done) this.pendingRoutes.delete(oldest.value)
    }
    const issuedAt = this.now()
    const invitation = {
      routeId: opaqueRandomId(this.random) as RemoteRouteId,
      clientAuthToken: opaqueRandomId(this.random),
      expiresAt: new Date(issuedAt.getTime() + ROUTE_LIFETIME_MS).toISOString(),
      host: this.identity.publicIdentity(),
    }
    const route = { hostAuthToken: opaqueRandomId(this.random), invitation }
    this.pendingRoutes.set(invitation.routeId, route)
    return Promise.resolve({ hostAuthToken: route.hostAuthToken, invitation: copyInvitation(invitation) })
  }

  /** @inheritdoc */
  async confirm(input: RemoteEnrollmentConfirmation): Promise<RemoteDeviceRecord> {
    this.dropExpiredRoutes()
    const issued = this.pendingRoutes.get(input.route.routeId)
    if (issued === undefined || !sameInvitation(issued.invitation, input.route)) {
      throw new RemoteHostIdentityError('REMOTE_HOST_IDENTITY_INPUT_INVALID', 'remote enrollment route is not pending')
    }
    this.pendingRoutes.delete(input.route.routeId)
    return this.devices.enroll({ ...input.device })
  }

  /** Discard expired credentials before any route can be issued or accepted. */
  private dropExpiredRoutes(): void {
    const now = this.now()
    for (const [routeId, route] of this.pendingRoutes) {
      if (isExpired(route, now)) this.pendingRoutes.delete(routeId)
    }
  }
}

/** Compare a submitted route with the exact one-time record without logging either token. */
function sameInvitation(left: RemoteEnrollmentInvitation, right: RemoteEnrollmentInvitation): boolean {
  return left.routeId === right.routeId
    && left.clientAuthToken === right.clientAuthToken
    && left.expiresAt === right.expiresAt
    && left.host.hostDeviceId === right.host.hostDeviceId
    && left.host.signingPublicKey === right.host.signingPublicKey
    && left.host.agreementPublicKey === right.host.agreementPublicKey
}

/** Fixed security lifetime for an unattended local-enrollment route. */
const ROUTE_LIFETIME_MS = 5 * 60 * 1000
/** Fixed memory limit that prevents abandoned pairing attempts retaining unbounded tokens. */
const MAX_PENDING_ROUTES = 32

/** Remove every expired in-memory route before creating or accepting an enrollment. */
function isExpired(route: RemoteEnrollmentRoute, now: Date): boolean {
  return Date.parse(route.invitation.expiresAt) <= now.getTime()
}

/** Return an external route copy so callers cannot mutate the pending one-time record. */
function copyInvitation(route: RemoteEnrollmentInvitation): RemoteEnrollmentInvitation {
  return { ...route, host: { ...route.host } }
}

/** Encode a random opaque route or relay token without exposing key material. */
function opaqueRandomId(random: (size: number) => Uint8Array): string {
  return Buffer.from(random(24)).toString('base64url')
}
