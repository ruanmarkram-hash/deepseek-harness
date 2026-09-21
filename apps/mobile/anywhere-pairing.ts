/** Internet-only QR/code rendezvous for a signed DSH Host. */

import type { MobileEnrollmentOffer, MobileHostInvitation } from './enrollment'
import type { MobileIdentityProvider } from './remote'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

const RELAY_ORIGIN = 'https://dshrelay.rulabs.dev'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/

/** A locally authored internet-pairing error safe to show without reclassification. */
export class AnywherePairingError extends Error {}

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
    throw new AnywherePairingError('Enter the complete DSH pairing code shown by the signed Host')
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
  const offerResponse = await pairingFetch(fetcher, `${RELAY_ORIGIN}/v3/pairings/${encodeURIComponent(pairing.pairingId)}/offer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-dsh-pairing-code': pairing.code },
    body: JSON.stringify(offer),
  })
  if (!offerResponse.ok) throw pairingResponseError(offerResponse.status)
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(2_000)
    const invitationResponse = await pairingFetch(fetcher, `${RELAY_ORIGIN}/v3/pairings/${encodeURIComponent(pairing.pairingId)}/invitation`, {
      headers: { 'cache-control': 'no-store', 'x-dsh-pairing-code': pairing.code },
    })
    if (invitationResponse.status === 204) continue
    if (!invitationResponse.ok) throw pairingResponseError(invitationResponse.status)
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
        const response = await pairingFetch(fetcher, `${RELAY_ORIGIN}/v3/pairings/${encodeURIComponent(pairing.pairingId)}/invitation`, {
          method: 'POST',
          headers: { 'cache-control': 'no-store', 'x-dsh-pairing-code': pairing.code },
        })
        if (!response.ok && response.status !== 404) throw pairingResponseError(response.status)
      } }
    } catch {
      throw new AnywherePairingError('The protected Host invitation could not be opened on this phone')
    } finally {
      sharedSecret?.fill(0)
      plaintext?.fill(0)
      identityProvider.clearUserPresence()
    }
  }
  throw new AnywherePairingError('No Host approval was received within two minutes. Check the Host, then generate a fresh pairing code to retry.')
}

async function pairingFetch(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try { return await fetcher(url, init) } catch {
    throw new AnywherePairingError('Could not reach the pairing relay. Check your internet connection and try again.')
  }
}

function pairingResponseError(status: number): AnywherePairingError {
  if (status === 404) return new AnywherePairingError('This pairing code is unavailable. It may have expired or been removed. Generate a fresh code from the Host.')
  if (status === 409) return new AnywherePairingError('This pairing code already has a phone offer or has been used. Check the Host for a pending approval, or generate a fresh code.')
  if (status === 401 || status === 403) return new AnywherePairingError('The relay rejected this pairing code. Scan or enter the complete code from the Host again.')
  if (status === 429) return new AnywherePairingError('The pairing relay received too many requests. Wait a moment before trying again.')
  return new AnywherePairingError(`The pairing relay could not complete the request (HTTP ${status}). Try again shortly.`)
}

function pause(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function parseSealedInvitation(value: unknown): SealedInvitation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AnywherePairingError('The protected Host invitation is malformed')
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
  ) throw new AnywherePairingError('The protected Host invitation is malformed')
  return record as unknown as SealedInvitation
}
function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = globalThis.atob(normalized)
  return Uint8Array.from(binary, byte => byte.charCodeAt(0))
}
