/** Internet-only QR/code rendezvous for a signed DSH Host. */

import type { MobileEnrollmentOffer, MobileHostInvitation } from './enrollment'
import type { MobileIdentityProvider } from './remote'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

const RELAY_ORIGIN = 'https://dshrelay.rulabs.dev'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/

export interface AnywherePairingCode {
  readonly pairingId: string
  readonly code: string
}
interface SealedInvitation {
  readonly version: 1
  readonly hostStaticAgreementPublicKey: string
  readonly nonce: string
  readonly ciphertext: string
}
export interface AnywherePairingResult { readonly invitation: MobileHostInvitation; acknowledge(): Promise<void> }

/** Accept the typed code and the exact text encoded in the Host’s QR code. */
export function parseAnywherePairingCode(value: string): AnywherePairingCode {
  const parts = value.trim().split('.')
  if (parts.length !== 3 || parts[0] !== 'dsh3' || !ID.test(parts[1] ?? '') || !TOKEN.test(parts[2] ?? '')) {
    throw new Error('Enter the complete DSH pairing code shown by the signed Host')
  }
  return { pairingId: parts[1]!, code: parts[2]! }
}

/** Submit this phone’s public identity, then wait for the Host-approved invitation. */
export async function completeAnywherePairing(
  encodedCode: string,
  offer: MobileEnrollmentOffer,
  identityProvider: MobileIdentityProvider,
  fetcher: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = pause,
): Promise<AnywherePairingResult> {
  const pairing = parseAnywherePairingCode(encodedCode)
  const offerResponse = await fetcher(`${RELAY_ORIGIN}/v3/pairings/${encodeURIComponent(pairing.pairingId)}/offer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-dsh-pairing-code': pairing.code },
    body: JSON.stringify(offer),
  })
  if (!offerResponse.ok) throw new Error('The Host pairing code is unavailable, already used, or expired')
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(2_000)
    const invitationResponse = await fetcher(`${RELAY_ORIGIN}/v3/pairings/${encodeURIComponent(pairing.pairingId)}/invitation`, {
      headers: { 'cache-control': 'no-store', 'x-dsh-pairing-code': pairing.code },
    })
    if (invitationResponse.status === 204) continue
    if (!invitationResponse.ok) throw new Error('The Host pairing code expired before approval')
    const sealed = parseSealedInvitation(await invitationResponse.json())
    let sharedSecret: Uint8Array | undefined
    let plaintext: Uint8Array | undefined
    try {
      await identityProvider.requireUserPresence()
      const identity = await identityProvider.deviceIdentity()
      sharedSecret = identity.agreement.deriveSharedSecret(sealed.hostStaticAgreementPublicKey)
      const authenticatedData = new TextEncoder().encode(`dsh3.invitation.${pairing.pairingId}`)
      plaintext = chacha20poly1305(sharedSecret, decodeBase64Url(sealed.nonce), authenticatedData)
        .decrypt(decodeBase64Url(sealed.ciphertext))
      const invitation = JSON.parse(new TextDecoder().decode(plaintext)) as MobileHostInvitation
      return { invitation, acknowledge: async () => {
        const response = await fetcher(`${RELAY_ORIGIN}/v3/pairings/${encodeURIComponent(pairing.pairingId)}/invitation`, {
          method: 'POST',
          headers: { 'cache-control': 'no-store', 'x-dsh-pairing-code': pairing.code },
        })
        if (!response.ok && response.status !== 404) throw new Error('Could not complete the protected invitation transfer')
      } }
    } catch {
      throw new Error('The protected Host invitation could not be opened on this phone')
    } finally {
      sharedSecret?.fill(0)
      plaintext?.fill(0)
      identityProvider.clearUserPresence()
    }
  }
  throw new Error('The Host did not approve this phone before the pairing window closed')
}

function pause(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function parseSealedInvitation(value: unknown): SealedInvitation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The protected Host invitation is malformed')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 4
    || record.version !== 1
    || typeof record.hostStaticAgreementPublicKey !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(record.hostStaticAgreementPublicKey)
    || typeof record.nonce !== 'string'
    || !/^[A-Za-z0-9_-]{16}$/.test(record.nonce)
    || typeof record.ciphertext !== 'string'
    || !/^[A-Za-z0-9_-]{32,16384}$/.test(record.ciphertext)
  ) throw new Error('The protected Host invitation is malformed')
  return record as unknown as SealedInvitation
}
function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = globalThis.atob(normalized)
  return Uint8Array.from(binary, byte => byte.charCodeAt(0))
}
