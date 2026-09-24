import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { describe, expect, it, vi } from 'vitest'
import { completeAnywherePairing, parseAnywherePairingCode } from '../anywhere-pairing'
import { fingerprintMobileEnrollmentOffer, type MobileEnrollmentOffer, type MobileHostInvitation } from '../enrollment'
import type { MobileDeviceIdentity, MobileIdentityProvider } from '../remote'
import { pairingError } from '../mobile-pairing-actions'

const pairingId = 'pairing_identity_123'
const pairingCode = 'c'.repeat(32)
const hostAgreementPublicKey = base64Url(new Uint8Array(32).fill(7))
const sharedSecretFixture = new Uint8Array(32).fill(19)
const nonce = new Uint8Array(12).fill(23)

const offer: MobileEnrollmentOffer = {
  deviceId: 'd'.repeat(16),
  label: 'Ruan’s iPhone',
  signingPublicKey: base64Url(new Uint8Array(32).fill(9)),
  agreementPublicKey: base64Url(new Uint8Array(32).fill(8)),
}

const invitation: MobileHostInvitation = {
  version: 3,
  routeId: 'route_identifier_123',
  routeGeneration: 1,
  connectionEpoch: 1,
  expiresAt: '2026-08-27T00:00:00.000Z',
  clientAuthToken: base64Url(new Uint8Array(24).fill(6)),
  deviceId: offer.deviceId,
  deviceSigningPublicKey: offer.signingPublicKey,
  deviceAgreementPublicKey: offer.agreementPublicKey,
  deviceEnrollmentId: 'device_enrollment_123',
  hostDeviceId: 'host_identifier_123',
  hostEnrollmentId: 'host_enrollment_123',
  hostStaticAgreementPublicKey: hostAgreementPublicKey,
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function sealedInvitation(ciphertext = encryptedInvitation()): Record<string, unknown> {
  return {
    version: 1,
    hostStaticAgreementPublicKey: hostAgreementPublicKey,
    nonce: base64Url(nonce),
    ciphertext: base64Url(ciphertext),
  }
}

function encryptedInvitation(): Uint8Array {
  const plaintext = new TextEncoder().encode(JSON.stringify(invitation))
  const aad = new TextEncoder().encode(`dsh3.invitation.${pairingId}`)
  return chacha20poly1305(sharedSecretFixture, nonce, aad).encrypt(plaintext)
}

function identityProvider(sharedSecret: Uint8Array, events: string[]): MobileIdentityProvider {
  let present = false
  return {
    deviceIdentity: async (): Promise<MobileDeviceIdentity> => ({
      deviceId: offer.deviceId as MobileDeviceIdentity['deviceId'],
      signingPublicKey: offer.signingPublicKey,
      agreement: {
        publicKey: offer.agreementPublicKey,
        deriveSharedSecret: (peer) => {
          events.push('derive')
          expect(present).toBe(true)
          expect(peer).toBe(hostAgreementPublicKey)
          return sharedSecret
        },
      },
    }),
    requireUserPresence: async () => { events.push('presence'); present = true },
    clearUserPresence: () => { events.push('clear'); present = false },
  }
}

describe('anywhere mobile pairing', () => {
  it.each([
    [404, 'may have expired or been removed'],
    [409, 'already has a phone offer'],
    [401, 'rejected this pairing code'],
    [403, 'rejected this pairing code'],
    [429, 'too many requests'],
    [500, 'HTTP 500'],
  ])('reports offer HTTP %s without falsely declaring invitation expiry', async (status, expected) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'untrusted secret payload' }, { status })) as typeof fetch
    const error = await completeAnywherePairing(
      `dsh3.${pairingId}.${pairingCode}`, offer, identityProvider(sharedSecretFixture.slice(), []), fetcher,
    ).catch((cause: unknown) => cause)
    expect(pairingError(error)).toContain(expected)
    expect(pairingError(error)).not.toContain('This Host invitation has expired')
    expect(pairingError(error)).not.toContain('untrusted secret payload')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('distinguishes relay connectivity failure from expiry', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('network details')) as typeof fetch
    const error = await completeAnywherePairing(
      `dsh3.${pairingId}.${pairingCode}`, offer, identityProvider(sharedSecretFixture.slice(), []), fetcher,
    ).catch((cause: unknown) => cause)
    expect(pairingError(error)).toContain('Could not reach the pairing relay')
    expect(pairingError(error)).not.toContain('network details')
  })

  it('does not turn an invitation polling server error into expiry', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 })) as typeof fetch
    const error = await completeAnywherePairing(
      `dsh3.${pairingId}.${pairingCode}`, offer, identityProvider(sharedSecretFixture.slice(), []), fetcher, async () => undefined,
    ).catch((cause: unknown) => cause)
    expect(pairingError(error)).toContain('HTTP 503')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('reports approval timeout without claiming that the relay code expired', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as typeof fetch
    const error = await completeAnywherePairing(
      `dsh3.${pairingId}.${pairingCode}`, offer, identityProvider(sharedSecretFixture.slice(), []), fetcher, async () => undefined,
    ).catch((cause: unknown) => cause)
    expect(pairingError(error)).toContain('No Host approval was received within two minutes')
    expect(fetcher).toHaveBeenCalledTimes(61)
  })

  it('pins the signed Host fingerprint for the canonical public offer', () => {
    expect(fingerprintMobileEnrollmentOffer(offer)).toBe('2B5E-242C-B1C4-5D4E-6E0B-4835-55F2-3278-E16C-1148-BB04-31C6-8563-1D18-F045-51EC')
    expect(fingerprintMobileEnrollmentOffer({ ...offer, label: 'A/B' }))
      .toBe('6644-C0D6-075E-2B95-DFFD-2E0F-1D86-BE9D-7728-C59D-FFB9-F5F0-5566-A58D-03D1-6F84')
  })

  it('submits the displayed offer unchanged and opens the approved invitation only after owner presence', async () => {
    const events: string[] = []
    const derived = sharedSecretFixture.slice()
    let call = 0
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      call += 1
      if (call === 1) {
        expect(init?.method).toBe('POST')
        expect(init?.body).toBe(JSON.stringify(offer))
        return new Response(null, { status: 204 })
      }
      if (call === 2) return Response.json(sealedInvitation())
      expect(init?.method).toBe('POST')
      return new Response(null, { status: 204 })
    }) as typeof fetch

    const result = await completeAnywherePairing(
      `dsh3.${pairingId}.${pairingCode}`,
      offer,
      identityProvider(derived, events),
      fetcher,
      async () => undefined,
    )

    expect(result.invitation).toEqual(invitation)
    expect(events).toEqual(['presence', 'derive', 'clear'])
    expect(derived).toEqual(new Uint8Array(32))
    await result.acknowledge()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('clears protected presence and the shared secret when invitation authentication fails', async () => {
    const events: string[] = []
    const derived = sharedSecretFixture.slice()
    const tampered = encryptedInvitation()
    tampered[0] ^= 1
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(sealedInvitation(tampered))) as typeof fetch

    await expect(completeAnywherePairing(
      `dsh3.${pairingId}.${pairingCode}`,
      offer,
      identityProvider(derived, events),
      fetcher,
      async () => undefined,
    )).rejects.toThrow('could not be opened')
    expect(events).toEqual(['presence', 'derive', 'clear'])
    expect(derived).toEqual(new Uint8Array(32))
  })

  it('rejects incomplete or substituted pairing codes before publishing an offer', () => {
    expect(parseAnywherePairingCode(`dsh3.${pairingId}.${pairingCode}`)).toEqual({ pairingId, code: pairingCode })
    expect(() => parseAnywherePairingCode(`${pairingId}.${pairingCode}`)).toThrow(/complete DSH pairing code/)
    expect(() => parseAnywherePairingCode(`dsh3.${pairingId}.${'x'.repeat(31)}`)).toThrow(/complete DSH pairing code/)
  })
})
