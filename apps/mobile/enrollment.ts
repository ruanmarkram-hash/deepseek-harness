/**
 * Native mobile identity and strict Host-invitation import for V3 enrollment.
 *
 * This module creates no relay socket and persists no Host route credential in
 * JavaScript. The only private-key operation exposed to the remote client is
 * the fixed protected X25519 agreement operation required by the V3 protocol.
 */

import type { RemoteWireId } from '@deepseek-ai/dsh-remote-wire'
import { sha256 } from '@noble/hashes/sha2.js'
import type { MobileDeviceIdentity, MobileIdentityProvider, MobileRemoteConnectionConfig } from './remote'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const TOKEN = /^[A-Za-z0-9_-]{24,128}$/
const X25519_BYTES = 32
const MAX_V3_EPOCH = 2_147_483_647

/** Exact phone-transferable V3 route material issued after local Host confirmation. */
export interface MobileHostInvitation {
  readonly version: 3
  readonly routeId: string
  readonly routeGeneration: number
  readonly connectionEpoch: number
  /** Canonical Host instant after which the invitation must not be imported. */
  readonly expiresAt: string
  /** Remote-client relay authorization. The Host-only route token is never transferable. */
  readonly clientAuthToken: string
  readonly deviceId: string
  readonly deviceSigningPublicKey: string
  readonly deviceAgreementPublicKey: string
  readonly deviceEnrollmentId: string
  readonly hostDeviceId: string
  readonly hostEnrollmentId: string
  readonly hostStaticAgreementPublicKey: string
}

/** Native public descriptor. Neither private Curve25519 key is serializable to JavaScript. */
export interface NativeMobileDeviceDescriptor {
  readonly deviceId: string
  readonly signingPublicKey: string
  readonly agreementPublicKey: string
}

/** Exact public identity record a signed Host accepts for local device enrollment. */
export interface MobileEnrollmentOffer {
  readonly deviceId: string
  readonly label: string
  readonly signingPublicKey: string
  readonly agreementPublicKey: string
}

/** Narrow Expo module surface. `deriveSharedSecret` is synchronous because V3's fixed protocol consumes it synchronously. */
export interface DshDeviceIdentityNativeModule {
  deviceIdentity(): Promise<NativeMobileDeviceDescriptor>
  requireUserPresence(): Promise<void>
  deriveSharedSecret(peerAgreementPublicKey: string): string
  clearUserPresence(): void
}

/** Validated enrollment values that can be supplied to `MobileRemoteClient` when a socket owner exists. */
export interface ImportedMobileEnrollment {
  readonly identityProvider: MobileIdentityProvider
  readonly config: MobileRemoteConnectionConfig
  /** Canonical Host expiry retained for non-secret pairing status only. */
  readonly expiresAt: string
}

/**
 * Create the public-only record that a user transfers locally to their signed Host.
 *
 * @param label - A human-readable device label for the Host device directory.
 * @param identityProvider - The protected native mobile identity provider.
 * @returns The exact public device enrollment fields accepted by the signed Host.
 */
export async function createMobileEnrollmentOffer(
  label: string,
  identityProvider: MobileIdentityProvider,
): Promise<MobileEnrollmentOffer> {
  const identity = await identityProvider.deviceIdentity()
  return {
    deviceId: identifier(identity.deviceId),
    label: deviceLabel(label),
    signingPublicKey: curve25519PublicKey(identity.signingPublicKey),
    agreementPublicKey: curve25519PublicKey(identity.agreement.publicKey),
  }
}

/**
 * Return the signed Host's full SHA-256 fingerprint for one public offer.
 *
 * Foundation's sorted-key JSON encoder escapes forward slashes by default, so
 * the phone applies the same escaping before hashing the UTF-8 bytes.
 *
 * @param offer - The exact public offer transferred to the signed Host.
 * @returns Uppercase SHA-256 grouped into sixteen four-character blocks.
 */
export function fingerprintMobileEnrollmentOffer(offer: MobileEnrollmentOffer): string {
  const canonical = JSON.stringify({
    agreementPublicKey: offer.agreementPublicKey,
    deviceId: offer.deviceId,
    label: offer.label,
    signingPublicKey: offer.signingPublicKey,
  }).replaceAll('/', '\\/')
  const hex = Array.from(sha256(new TextEncoder().encode(canonical)), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
  return hex.match(/.{4}/g)!.join('-')
}

/** Parse exact V3 Host invitation values, rejecting Host-only, private, and unknown properties. */
export function parseMobileHostInvitation(value: unknown): MobileHostInvitation {
  if (!isRecord(value) || !exactKeys(value, [
    'version', 'routeId', 'routeGeneration', 'connectionEpoch', 'clientAuthToken',
    'expiresAt',
    'deviceId', 'deviceSigningPublicKey', 'deviceAgreementPublicKey', 'deviceEnrollmentId',
    'hostDeviceId', 'hostEnrollmentId', 'hostStaticAgreementPublicKey',
  ]) || value.version !== 3) throw new Error('The Host invitation is not a supported V3 enrollment invitation')
  return {
    version: 3,
    routeId: identifier(value.routeId),
    routeGeneration: sequence(value.routeGeneration),
    connectionEpoch: sequence(value.connectionEpoch),
    expiresAt: canonicalInstant(value.expiresAt),
    clientAuthToken: token(value.clientAuthToken),
    deviceId: identifier(value.deviceId),
    deviceSigningPublicKey: curve25519PublicKey(value.deviceSigningPublicKey),
    deviceAgreementPublicKey: curve25519PublicKey(value.deviceAgreementPublicKey),
    deviceEnrollmentId: identifier(value.deviceEnrollmentId),
    hostDeviceId: identifier(value.hostDeviceId),
    hostEnrollmentId: identifier(value.hostEnrollmentId),
    hostStaticAgreementPublicKey: curve25519PublicKey(value.hostStaticAgreementPublicKey),
  }
}

/**
 * Match a Host invitation to this phone's two protected public identities and
 * return only the existing remote-client configuration. This never opens a
 * route, provisions a relay, or retains the invitation in JavaScript.
 */
export async function importMobileHostInvitation(
  value: unknown,
  identityProvider: MobileIdentityProvider,
  now: () => Date = () => new Date(),
): Promise<ImportedMobileEnrollment> {
  const invitation = parseMobileHostInvitation(value)
  const current = now()
  if (!(current instanceof Date) || !Number.isFinite(current.getTime()) || Date.parse(invitation.expiresAt) <= current.getTime()) {
    throw new Error('This Host invitation has expired')
  }
  const identity = await identityProvider.deviceIdentity()
  if (
    identity.deviceId !== invitation.deviceId
    || identity.signingPublicKey !== invitation.deviceSigningPublicKey
    || identity.agreement.publicKey !== invitation.deviceAgreementPublicKey
  ) throw new Error('This Host invitation belongs to a different protected mobile identity')
  return {
    identityProvider,
    expiresAt: invitation.expiresAt,
    config: {
      clientAuthToken: invitation.clientAuthToken,
      connectionEpoch: invitation.connectionEpoch,
      deviceEnrollmentId: invitation.deviceEnrollmentId,
      hostDeviceId: invitation.hostDeviceId,
      hostEnrollmentId: invitation.hostEnrollmentId,
      hostStaticAgreementPublicKey: invitation.hostStaticAgreementPublicKey,
      routeGeneration: invitation.routeGeneration,
      routeId: invitation.routeId,
    },
  }
}

/** Return the production native identity provider, or one that fails closed outside a custom native build. */
export function createNativeMobileIdentityProvider(
  nativeModule: DshDeviceIdentityNativeModule | null,
): MobileIdentityProvider {
  if (nativeModule === null) return unavailableNativeIdentityProvider()
  return new NativeMobileIdentityProvider(nativeModule)
}

class NativeMobileIdentityProvider implements MobileIdentityProvider {
  private identity: MobileDeviceIdentity | undefined

  constructor(private readonly nativeModule: DshDeviceIdentityNativeModule) {}

  async deviceIdentity(): Promise<MobileDeviceIdentity> {
    const descriptor = await this.nativeModule.deviceIdentity()
    const parsed = parseNativeDescriptor(descriptor)
    const existing = this.identity
    if (existing !== undefined) {
      if (
        existing.deviceId !== parsed.deviceId
        || existing.signingPublicKey !== parsed.signingPublicKey
        || existing.agreement.publicKey !== parsed.agreementPublicKey
      ) {
        throw new Error('The native protected mobile identity changed during this app session')
      }
      return existing
    }
    const identity: MobileDeviceIdentity = {
      deviceId: parsed.deviceId as RemoteWireId,
      signingPublicKey: parsed.signingPublicKey,
      agreement: {
        publicKey: parsed.agreementPublicKey,
        deriveSharedSecret: (peerAgreementPublicKey: string): Uint8Array => decodeBase64Url(
          this.nativeModule.deriveSharedSecret(curve25519PublicKey(peerAgreementPublicKey)),
          X25519_BYTES,
        ),
      },
    }
    this.identity = identity
    return identity
  }

  async requireUserPresence(): Promise<void> {
    await this.nativeModule.requireUserPresence()
  }

  clearUserPresence(): void {
    this.nativeModule.clearUserPresence()
  }
}

function unavailableNativeIdentityProvider(): MobileIdentityProvider {
  const unavailable = (): never => { throw new Error('DSH Mobile requires its signed native identity module. Expo Go cannot pair this device.') }
  return {
    deviceIdentity: async (): Promise<MobileDeviceIdentity> => unavailable(),
    requireUserPresence: async (): Promise<void> => unavailable(),
    clearUserPresence: () => undefined,
  }
}

function parseNativeDescriptor(value: unknown): NativeMobileDeviceDescriptor {
  if (!isRecord(value) || !exactKeys(value, ['deviceId', 'signingPublicKey', 'agreementPublicKey'])) throw new Error('The native mobile identity descriptor is malformed')
  return {
    deviceId: identifier(value.deviceId),
    signingPublicKey: curve25519PublicKey(value.signingPublicKey),
    agreementPublicKey: curve25519PublicKey(value.agreementPublicKey),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error('The Host invitation has an invalid identifier')
  return value
}

function deviceLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Choose a device label between 1 and 64 visible characters')
  }
  return value
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('The Host invitation has an invalid client credential')
  const bytes = decodeBase64Url(value, undefined)
  try {
    if (bytes.byteLength < 18) throw new Error('The Host invitation has an invalid client credential')
  } finally {
    bytes.fill(0)
  }
  return value
}

function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_V3_EPOCH) throw new Error('The Host invitation has an invalid V3 sequence')
  return value
}

function canonicalInstant(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The Host invitation has an invalid expiration instant')
  const instant = new Date(value)
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) throw new Error('The Host invitation has an invalid expiration instant')
  return value
}

function curve25519PublicKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The Host invitation has an invalid Curve25519 public key')
  decodeBase64Url(value, X25519_BYTES).fill(0)
  return value
}

function decodeBase64Url(value: string, exactLength: number | undefined): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) throw new Error('The Host invitation has non-canonical base64url data')
  let binary: string
  try {
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4))
  } catch {
    throw new Error('The Host invitation has invalid base64url data')
  }
  const canonical = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  if (canonical !== value || (exactLength !== undefined && binary.length !== exactLength)) throw new Error('The Host invitation has invalid base64url data')
  return Uint8Array.from(binary, byte => byte.charCodeAt(0))
}
