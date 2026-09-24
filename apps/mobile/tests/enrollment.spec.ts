import { describe, expect, it } from 'vitest'
import { createMobileEnrollmentOffer, createNativeMobileIdentityProvider, importMobileHostInvitation, parseMobileHostInvitation, type DshDeviceIdentityNativeModule } from '../enrollment'

const deviceId = 'device_identifier_123'
const hostDeviceId = 'host_device_identifier_123'
const deviceEnrollmentId = 'device_enrollment_identifier_123'
const hostEnrollmentId = 'host_enrollment_identifier_123'
const routeId = 'remote_route_identifier_123'

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const deviceSigningPublicKey = base64Url(new Uint8Array(32).fill(11))
const deviceAgreementPublicKey = base64Url(new Uint8Array(32).fill(12))
const hostStaticAgreementPublicKey = base64Url(new Uint8Array(32).fill(13))

function invitation(): Record<string, unknown> {
  return {
    version: 3,
    routeId,
    routeGeneration: 2,
    connectionEpoch: 1,
    expiresAt: '2026-08-22T00:00:00.000Z',
    clientAuthToken: base64Url(new Uint8Array(24).fill(14)),
    deviceId,
    deviceSigningPublicKey,
    deviceAgreementPublicKey,
    deviceEnrollmentId,
    hostDeviceId,
    hostEnrollmentId,
    hostStaticAgreementPublicKey,
  }
}

function nativeModule(): DshDeviceIdentityNativeModule {
  let present = false
  return {
    deviceIdentity: async () => ({ deviceId, signingPublicKey: deviceSigningPublicKey, agreementPublicKey: deviceAgreementPublicKey }),
    requireUserPresence: async () => { present = true },
    deriveSharedSecret: (peer) => {
      if (!present) throw new Error('Current device-owner authentication is required')
      return peer === hostStaticAgreementPublicKey ? base64Url(new Uint8Array(32).fill(15)) : ''
    },
    clearUserPresence: () => { present = false },
  }
}

describe('mobile V3 enrollment import', () => {
  it('creates only the exact public record the signed Host accepts for local enrollment', async () => {
    const identityProvider = createNativeMobileIdentityProvider(nativeModule())
    await expect(createMobileEnrollmentOffer('  DSH Mobile', identityProvider)).rejects.toThrow(/label/)
    await expect(createMobileEnrollmentOffer('DSH Mobile', identityProvider)).resolves.toEqual({
      deviceId,
      label: 'DSH Mobile',
      signingPublicKey: deviceSigningPublicKey,
      agreementPublicKey: deviceAgreementPublicKey,
    })
  })

  it('accepts only the exact Host-issued V3 invitation field set', () => {
    expect(parseMobileHostInvitation(invitation())).toMatchObject({
      version: 3,
      routeId,
      hostStaticAgreementPublicKey,
    })
    const withHostSecret = { ...invitation(), hostAuthToken: base64Url(new Uint8Array(24).fill(8)) }
    expect(() => parseMobileHostInvitation(withHostSecret)).toThrow(/supported V3/)
    expect(() => parseMobileHostInvitation({ ...invitation(), routeGeneration: 0 })).toThrow(/sequence/)
    expect(() => parseMobileHostInvitation({ ...invitation(), expiresAt: '2026-08-22T00:00:00Z' })).toThrow(/expiration instant/)
    expect(() => parseMobileHostInvitation({ ...invitation(), deviceAgreementPublicKey: `${deviceAgreementPublicKey}=` })).toThrow(/base64url/)
  })

  it('rejects an invitation unless both device public keys and its device id match this phone', async () => {
    const identityProvider = createNativeMobileIdentityProvider(nativeModule())
    const imported = await importMobileHostInvitation(invitation(), identityProvider, () => new Date('2026-08-21T00:00:00.000Z'))
    expect(imported.expiresAt).toBe('2026-08-22T00:00:00.000Z')
    expect(imported.config).toEqual({
      clientAuthToken: invitation().clientAuthToken,
      connectionEpoch: 1,
      deviceEnrollmentId,
      hostDeviceId,
      hostEnrollmentId,
      hostStaticAgreementPublicKey,
      routeGeneration: 2,
      routeId,
    })
    await expect(importMobileHostInvitation({ ...invitation(), deviceSigningPublicKey: base64Url(new Uint8Array(32).fill(16)) }, identityProvider, () => new Date('2026-08-21T00:00:00.000Z'))).rejects.toThrow(/different protected mobile identity/)
    await expect(importMobileHostInvitation({ ...invitation(), deviceAgreementPublicKey: base64Url(new Uint8Array(32).fill(17)) }, identityProvider, () => new Date('2026-08-21T00:00:00.000Z'))).rejects.toThrow(/different protected mobile identity/)
    await expect(importMobileHostInvitation({ ...invitation(), deviceId: 'another_device_identifier_123' }, identityProvider, () => new Date('2026-08-21T00:00:00.000Z'))).rejects.toThrow(/different protected mobile identity/)
  })

  it('fails closed once the Host invitation is expired', async () => {
    const identityProvider = createNativeMobileIdentityProvider(nativeModule())
    await expect(importMobileHostInvitation(invitation(), identityProvider, () => new Date('2026-08-22T00:00:00.000Z'))).rejects.toThrow(/expired/)
    await expect(importMobileHostInvitation(invitation(), identityProvider, () => new Date('invalid'))).rejects.toThrow(/expired/)
  })

  it('uses native protected agreement only after owner presence and fails closed when unavailable', async () => {
    const identityProvider = createNativeMobileIdentityProvider(nativeModule())
    const identity = await identityProvider.deviceIdentity()
    expect(() => identity.agreement.deriveSharedSecret(hostStaticAgreementPublicKey)).toThrow(/Current device-owner authentication/)
    await identityProvider.requireUserPresence()
    expect(identity.agreement.deriveSharedSecret(hostStaticAgreementPublicKey)).toEqual(new Uint8Array(32).fill(15))
    identityProvider.clearUserPresence()
    await expect(createNativeMobileIdentityProvider(null).deviceIdentity()).rejects.toThrow(/Expo Go cannot pair/)
  })
})
