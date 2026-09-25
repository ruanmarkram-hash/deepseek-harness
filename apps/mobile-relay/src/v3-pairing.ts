/**
 * Short-lived public rendezvous for an explicitly approved V3 enrollment.
 *
 * This durable object is deliberately not a route relay. It keeps only hashed
 * capabilities, a public mobile offer, and a phone-safe invitation while the
 * Host is waiting for the person at the Mac to approve the phone fingerprint.
 */

import { DurableObject } from 'cloudflare:workers'
import { boundedTextBody } from './bounded-body.ts'
import type { V3Env } from './v3.ts'

export interface V3PairingEnv extends V3Env {
  V3_PAIRINGS: DurableObjectNamespace<V3Pairing>
}

const ACTION = 'x-dsh-v3-pairing-action'
const PAIRING_ID = 'x-dsh-v3-pairing-id'
const MAX_BODY_BYTES = 8 * 1024
const MAX_TTL_MS = 10 * 60 * 1000
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/
const LABEL = /^.{1,64}$/u
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/

interface PublicOffer {
  readonly deviceId: string
  readonly label: string
  readonly signingPublicKey: string
  readonly agreementPublicKey: string
}

interface SealedInvitation {
  readonly version: 1
  readonly hostStaticAgreementPublicKey: string
  readonly nonce: string
  readonly ciphertext: string
}

interface Creation {
  readonly code: string
  readonly hostToken: string
  readonly expiresAt: number
}

interface Metadata {
  readonly pairingId: string
  readonly salt: string
  readonly codeVerifier: string
  readonly hostVerifier: string
  readonly expiresAt: number
  readonly offer: PublicOffer | null
  readonly invitation: SealedInvitation | null
}

type PairingAction =
  | 'create'
  | 'authorize-offer'
  | 'submit-offer'
  | 'get-offer'
  | 'authorize-invitation'
  | 'publish-invitation'
  | 'get-invitation'
  | 'authorize-acknowledgement'
  | 'acknowledge-invitation'

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function id(value: unknown): string | undefined { return typeof value === 'string' && ID.test(value) ? value : undefined }
function token(value: unknown): string | undefined { return typeof value === 'string' && TOKEN.test(value) ? value : undefined }
function constantTime(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}
function base64Url(bytes: Uint8Array): string {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
async function verifier(value: string, salt: string): Promise<string> { return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}.${value}`)))) }
function pathId(url: URL, suffix = ''): string | undefined {
  const prefix = '/v3/pairings/'
  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix)) return undefined
  const value = url.pathname.slice(prefix.length, url.pathname.length - suffix.length)
  if (value.includes('/')) return undefined
  try { return id(decodeURIComponent(value)) } catch { return undefined }
}
function internal(request: Request, action: PairingAction, pairingId: string, body?: string): Request {
  const headers = new Headers(request.headers)
  headers.set(ACTION, action); headers.set(PAIRING_ID, pairingId); headers.delete('content-length')
  return new Request(request.url, { method: request.method, headers, ...(body === undefined ? {} : { body }) })
}
function parseCreation(serialized: string): Creation | undefined {
  let value: unknown; try { value = JSON.parse(serialized) } catch { return undefined }
  if (!record(value) || !exact(value, ['code', 'hostToken', 'expiresAt'])) return undefined
  const code = token(value.code); const hostToken = token(value.hostToken)
  const expiresAt = typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + MAX_TTL_MS ? value.expiresAt : undefined
  return code === undefined || hostToken === undefined || code === hostToken || expiresAt === undefined
    ? undefined
    : { code, hostToken, expiresAt }
}
function parseOffer(serialized: string): PublicOffer | undefined {
  let value: unknown; try { value = JSON.parse(serialized) } catch { return undefined }
  if (!record(value) || !exact(value, ['deviceId', 'label', 'signingPublicKey', 'agreementPublicKey'])) return undefined
  const deviceId = id(value.deviceId)
  return deviceId === undefined || typeof value.label !== 'string' || !LABEL.test(value.label) || value.label !== value.label.trim() || /[\u0000-\u001f\u007f]/.test(value.label)
    || typeof value.signingPublicKey !== 'string' || !PUBLIC_KEY.test(value.signingPublicKey)
    || typeof value.agreementPublicKey !== 'string' || !PUBLIC_KEY.test(value.agreementPublicKey) || value.signingPublicKey === value.agreementPublicKey
    ? undefined : { deviceId, label: value.label, signingPublicKey: value.signingPublicKey, agreementPublicKey: value.agreementPublicKey }
}
function sealed(value: unknown, length?: number): string | undefined { return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) && value.length % 4 !== 1 && (length === undefined ? value.length >= 32 && value.length <= MAX_BODY_BYTES * 2 : value.length === length) ? value : undefined }
function parseInvitation(serialized: string): SealedInvitation | undefined {
  let value: unknown; try { value = JSON.parse(serialized) } catch { return undefined }
  if (!record(value) || !exact(value, ['version', 'hostStaticAgreementPublicKey', 'nonce', 'ciphertext']) || value.version !== 1 || typeof value.hostStaticAgreementPublicKey !== 'string' || !PUBLIC_KEY.test(value.hostStaticAgreementPublicKey)) return undefined
  const nonce = sealed(value.nonce, 16), ciphertext = sealed(value.ciphertext)
  return nonce === undefined || ciphertext === undefined
    ? undefined
    : { version: 1, hostStaticAgreementPublicKey: value.hostStaticAgreementPublicKey, nonce, ciphertext }
}
function bearer(value: string | null): string | undefined { return value?.startsWith('Bearer ') ? token(value.slice(7)) : undefined }
function pairingCode(request: Request): string | undefined { return token(request.headers.get('x-dsh-pairing-code')) }

/** Route the narrowly scoped QR/code rendezvous API. */
export async function routeV3Pairing(request: Request, env: V3PairingEnv): Promise<Response> {
  const url = new URL(request.url)
  const created = pathId(url)
  if (request.method === 'POST' && created !== undefined && url.search === '') {
    const credential = bearer(request.headers.get('authorization'))
    if (credential === undefined || !constantTime(credential, env.V3_PROVISIONING_TOKEN)) return json(401, { error: 'unauthorized' })
    const serialized = await boundedTextBody(request, MAX_BODY_BYTES)
    if (serialized === undefined || parseCreation(serialized) === undefined) return json(400, { error: 'invalid-request' })
    return env.V3_PAIRINGS.getByName(created).fetch(internal(request, 'create', created, serialized))
  }
  const offered = pathId(url, '/offer')
  if (offered !== undefined && url.search === '') {
    if (request.method === 'POST') {
      if (pairingCode(request) === undefined) return json(400, { error: 'invalid-request' })
      const pairing = env.V3_PAIRINGS.getByName(offered)
      const authorization = await pairing.fetch(internal(request, 'authorize-offer', offered))
      if (authorization.status !== 204) return authorization
      const serialized = await boundedTextBody(request, MAX_BODY_BYTES)
      if (serialized === undefined || parseOffer(serialized) === undefined) return json(400, { error: 'invalid-request' })
      return pairing.fetch(internal(request, 'submit-offer', offered, serialized))
    }
    if (request.method === 'GET' && bearer(request.headers.get('authorization')) !== undefined) return env.V3_PAIRINGS.getByName(offered).fetch(internal(request, 'get-offer', offered))
  }
  const invitation = pathId(url, '/invitation')
  if (invitation !== undefined && url.search === '') {
    if (request.method === 'POST') {
      const code = pairingCode(request)
      const authorization = request.headers.get('authorization')
      if (code !== undefined && authorization === null) {
        const pairing = env.V3_PAIRINGS.getByName(invitation)
        const authorized = await pairing.fetch(internal(request, 'authorize-acknowledgement', invitation))
        if (authorized.status !== 204) return authorized
        const serialized = await boundedTextBody(request, MAX_BODY_BYTES)
        return serialized === ''
          ? pairing.fetch(internal(request, 'acknowledge-invitation', invitation))
          : json(400, { error: 'invalid-request' })
      }
      if (code !== undefined || bearer(authorization) === undefined) return json(400, { error: 'invalid-request' })
      const pairing = env.V3_PAIRINGS.getByName(invitation)
      const authorized = await pairing.fetch(internal(request, 'authorize-invitation', invitation))
      if (authorized.status !== 204) return authorized
      const serialized = await boundedTextBody(request, MAX_BODY_BYTES)
      if (serialized === undefined || parseInvitation(serialized) === undefined) return json(400, { error: 'invalid-request' })
      return pairing.fetch(internal(request, 'publish-invitation', invitation, serialized))
    }
    if (request.method === 'GET' && pairingCode(request) !== undefined) return env.V3_PAIRINGS.getByName(invitation).fetch(internal(request, 'get-invitation', invitation))
  }
  return json(404, { error: 'not-found' })
}

/** One-time, expiry-bound QR or typed-code exchange. */
export class V3Pairing extends DurableObject<V3PairingEnv> {
  override async fetch(request: Request): Promise<Response> {
    const pairingId = id(request.headers.get(PAIRING_ID)); if (pairingId === undefined) return json(400, { error: 'invalid-request' })
    switch (request.headers.get(ACTION)) {
      case 'create': return this.create(request, pairingId)
      case 'authorize-offer': return this.authorizeCode(request, pairingId)
      case 'submit-offer': return this.submitOffer(request, pairingId)
      case 'get-offer': return this.getOffer(request, pairingId)
      case 'authorize-invitation': return this.authorizeInvitation(request, pairingId)
      case 'publish-invitation': return this.publishInvitation(request, pairingId)
      case 'get-invitation': return this.getInvitation(request, pairingId)
      case 'authorize-acknowledgement': return this.authorizeCode(request, pairingId)
      case 'acknowledge-invitation': return this.acknowledgeInvitation(request, pairingId)
      default: return json(404, { error: 'not-found' })
    }
  }
  override async alarm(): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      const current = await this.transactionMetadata(storage)
      if (current !== undefined) await storage.setAlarm(current.expiresAt)
    })
  }
  private async metadata(): Promise<Metadata | undefined> {
    return this.ctx.storage.transaction(storage => this.transactionMetadata(storage))
  }
  private async transactionMetadata(storage: DurableObjectTransaction): Promise<Metadata | undefined> {
    const value = await storage.get<Metadata>('pairing')
    if (value !== undefined && value.expiresAt <= Date.now()) {
      await storage.delete('pairing')
      await storage.deleteAlarm()
      return undefined
    }
    return value
  }
  private async create(request: Request, pairingId: string): Promise<Response> {
    const input = parseCreation(await request.text())
    if (input === undefined) return json(409, { error: 'pairing-exists' })
    const salt = base64Url(crypto.getRandomValues(new Uint8Array(32)))
    const metadata = {
      pairingId,
      salt,
      codeVerifier: await verifier(input.code, salt),
      hostVerifier: await verifier(input.hostToken, salt),
      expiresAt: input.expiresAt,
      offer: null,
      invitation: null,
    } satisfies Metadata
    const created = await this.ctx.storage.transaction(async (storage) => {
      if (await this.transactionMetadata(storage) !== undefined) return false
      await storage.put('pairing', metadata)
      await storage.setAlarm(input.expiresAt)
      return true
    })
    if (!created) return json(409, { error: 'pairing-exists' })
    return new Response(null, { status: 201, headers: { 'cache-control': 'no-store' } })
  }
  private async authorizedCode(request: Request, metadata: Metadata): Promise<boolean> {
    const value = pairingCode(request)
    return value !== undefined && constantTime(await verifier(value, metadata.salt), metadata.codeVerifier)
  }
  private async authorizedHost(request: Request, metadata: Metadata): Promise<boolean> {
    const value = bearer(request.headers.get('authorization'))
    return value !== undefined && constantTime(await verifier(value, metadata.salt), metadata.hostVerifier)
  }
  private async authorizeCode(request: Request, pairingId: string): Promise<Response> {
    const metadata = await this.metadata()
    if (metadata === undefined || metadata.pairingId !== pairingId) return json(404, { error: 'not-found' })
    return await this.authorizedCode(request, metadata)
      ? new Response(null, { status: 204 })
      : json(401, { error: 'unauthorized' })
  }
  private async submitOffer(request: Request, pairingId: string): Promise<Response> {
    const metadata = await this.metadata()
    if (metadata === undefined || metadata.pairingId !== pairingId) return json(404, { error: 'not-found' })
    if (!await this.authorizedCode(request, metadata)) return json(401, { error: 'unauthorized' })
    const serialized = await boundedTextBody(request, MAX_BODY_BYTES)
    const offer = serialized === undefined ? undefined : parseOffer(serialized)
    if (offer === undefined) return json(409, { error: 'offer-exists' })
    const result = await this.ctx.storage.transaction(async (storage) => {
      const current = await this.transactionMetadata(storage)
      if (current === undefined || current.pairingId !== pairingId) return 'not-found'
      if (!await this.authorizedCode(request, current)) return 'unauthorized'
      if (current.offer !== null) return 'conflict'
      await storage.put('pairing', { ...current, offer } satisfies Metadata)
      return 'stored'
    })
    if (result === 'not-found') return json(404, { error: 'not-found' })
    if (result === 'unauthorized') return json(401, { error: 'unauthorized' })
    if (result === 'conflict') return json(409, { error: 'offer-exists' })
    return new Response(null, { status: 204 })
  }
  private async getOffer(request: Request, pairingId: string): Promise<Response> {
    const metadata = await this.metadata()
    if (metadata === undefined || metadata.pairingId !== pairingId) return json(404, { error: 'not-found' })
    if (!await this.authorizedHost(request, metadata)) return json(401, { error: 'unauthorized' })
    return metadata.offer === null ? new Response(null, { status: 204 }) : json(200, { ...metadata.offer })
  }
  private async authorizeInvitation(request: Request, pairingId: string): Promise<Response> {
    const metadata = await this.metadata()
    if (metadata === undefined || metadata.pairingId !== pairingId) return json(404, { error: 'not-found' })
    return await this.authorizedHost(request, metadata)
      ? new Response(null, { status: 204 })
      : json(401, { error: 'unauthorized' })
  }
  private async publishInvitation(request: Request, pairingId: string): Promise<Response> {
    const metadata = await this.metadata()
    if (metadata === undefined || metadata.pairingId !== pairingId) return json(404, { error: 'not-found' })
    if (!await this.authorizedHost(request, metadata)) return json(401, { error: 'unauthorized' })
    const serialized = await boundedTextBody(request, MAX_BODY_BYTES)
    const invitation = serialized === undefined ? undefined : parseInvitation(serialized)
    if (invitation === undefined) return json(409, { error: 'invalid-invitation' })
    const result = await this.ctx.storage.transaction(async (storage) => {
      const current = await this.transactionMetadata(storage)
      if (current === undefined || current.pairingId !== pairingId) return 'not-found'
      if (!await this.authorizedHost(request, current)) return 'unauthorized'
      if (current.offer === null || current.invitation !== null) return 'conflict'
      await storage.put('pairing', { ...current, invitation } satisfies Metadata)
      return 'stored'
    })
    if (result === 'not-found') return json(404, { error: 'not-found' })
    if (result === 'unauthorized') return json(401, { error: 'unauthorized' })
    if (result === 'conflict') return json(409, { error: 'invalid-invitation' })
    return new Response(null, { status: 204 })
  }
  private async getInvitation(request: Request, pairingId: string): Promise<Response> {
    const metadata = await this.metadata()
    if (metadata === undefined || metadata.pairingId !== pairingId) return json(404, { error: 'not-found' })
    if (!await this.authorizedCode(request, metadata)) return json(401, { error: 'unauthorized' })
    if (metadata.invitation === null) return new Response(null, { status: 204 })
    return json(200, { ...metadata.invitation })
  }
  private async acknowledgeInvitation(request: Request, pairingId: string): Promise<Response> {
    const result = await this.ctx.storage.transaction(async (storage) => {
      const current = await this.transactionMetadata(storage)
      if (current === undefined || current.pairingId !== pairingId) return 'not-found'
      if (!await this.authorizedCode(request, current)) return 'unauthorized'
      if (current.invitation === null) return 'conflict'
      await storage.delete('pairing')
      await storage.deleteAlarm()
      return 'deleted'
    })
    if (result === 'not-found') return json(404, { error: 'not-found' })
    if (result === 'unauthorized') return json(401, { error: 'unauthorized' })
    if (result === 'conflict') return json(409, { error: 'invitation-unavailable' })
    return new Response(null, { status: 204 })
  }
}
