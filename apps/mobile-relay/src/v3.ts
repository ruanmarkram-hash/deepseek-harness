/** Durable blind relay for one trusted DSH Host and one enrolled remote device. */

import { parseRemoteRelayMessage } from '@deepseek-ai/dsh-remote-relay-protocol'
import type { RemoteRelayMessage } from '@deepseek-ai/dsh-remote-relay-protocol'
import { DurableObject } from 'cloudflare:workers'
import { boundedTextBody } from './bounded-body.ts'

/** Worker bindings used by the V3 route coordinator. */
export interface V3Env {
  REMOTE_ROUTES: DurableObjectNamespace<RemoteRoute>
  V3_PROVISIONING_TOKEN: string
}

export const V3_PROTOCOL_NAME = 'dsh-remote-v3'
const V3_ROUTE_KEY = 'route'
const V3_SEQUENCE_PREFIX = 'v3-sequence:'
const V3_INTERNAL_ACTION = 'x-dsh-remote-action'
const V3_INTERNAL_ROUTE_ID = 'x-dsh-remote-route-id'
const V3_MAX_BODY_BYTES = 8 * 1024
const V3_MAX_MESSAGES_PER_SECOND = 60
const V3_PENDING_HANDSHAKE_MS = 30_000
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/
const UPGRADE = 'websocket'

type V3Peer = 'host' | 'device'
type HandshakeState = 'none' | 'hello' | 'welcome' | 'ready' | 'finish' | 'ack' | 'commit' | 'confirm' | 'live'
type V3Action = 'create' | 'connect' | 'authorize-rotation' | 'rotate' | 'revoke'

interface V3RouteCreation {
  readonly hostDeviceId: string
  readonly hostEnrollmentId: string
  readonly deviceId: string
  readonly deviceEnrollmentId: string
  readonly hostToken: string
  readonly deviceToken: string
}

interface V3RouteRotation extends V3RouteCreation {
  readonly generation: number
}

interface V3RouteMetadata {
  readonly version: 3
  readonly routeId: string
  readonly hostDeviceId: string
  readonly hostEnrollmentId: string
  readonly deviceId: string
  readonly deviceEnrollmentId: string
  readonly tokenSalt: string
  readonly hostTokenVerifier: string
  readonly deviceTokenVerifier: string
  readonly generation: number
  readonly lastEpoch: number
  /** A device-confirmed epoch whose Host receipt might have been interrupted. */
  readonly pendingFinalityEpoch: number | null
  readonly activeEpoch: number | null
  readonly handshake: HandshakeState
  readonly handshakeStartedAt: number | null
}

interface V3Attachment {
  readonly version: 3
  readonly connectionId: string
  readonly supersededBy: string | null
  readonly routeId: string
  readonly routeVersion: 3
  readonly routeGeneration: number
  readonly routeSalt: string
  readonly peer: V3Peer
  readonly deviceId: string
  readonly enrollmentId: string
  readonly epoch: number | null
  readonly connectedAt: number
  readonly rateWindowStartedAt: number
  readonly messagesInWindow: number
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function publicId(value: unknown): string | undefined {
  return typeof value === 'string' && ID.test(value) ? value : undefined
}

function token(value: unknown): string | undefined {
  return typeof value === 'string' && TOKEN.test(value) ? value : undefined
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function constantTime(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

async function verifier(value: string, salt: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}.${value}`))))
}

function connectionToken(value: string | null): { readonly peer: V3Peer; readonly token: string } | undefined {
  if (value === null || value.length > 512) return undefined
  const protocols = value.split(',').map(part => part.trim())
  if (protocols.length !== 2 || protocols[0] !== V3_PROTOCOL_NAME) return undefined
  for (const [peer, prefix] of [['host', 'dsh-host.'], ['device', 'dsh-device.']] as const) {
    if (!protocols[1]?.startsWith(prefix)) continue
    const candidate = token(protocols[1].slice(prefix.length))
    return candidate === undefined ? undefined : { peer, token: candidate }
  }
  return undefined
}

function bearer(value: string | null): string | undefined {
  return value !== null && value.startsWith('Bearer ') ? token(value.slice(7)) : undefined
}

function routeId(url: URL, suffix = ''): string | undefined {
  const prefix = '/v3/routes/'
  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix)) return undefined
  const encoded = url.pathname.slice(prefix.length, url.pathname.length - suffix.length)
  if (encoded.includes('/')) return undefined
  try {
    return publicId(decodeURIComponent(encoded))
  } catch {
    return undefined
  }
}

function actionRequest(request: Request, action: V3Action, id: string, body?: string): Request {
  const headers = new Headers(request.headers)
  headers.set(V3_INTERNAL_ACTION, action)
  headers.set(V3_INTERNAL_ROUTE_ID, id)
  headers.delete('content-length')
  return new Request(request.url, { method: request.method, headers, ...(body === undefined ? {} : { body }) })
}

async function textBody(request: Request): Promise<string | undefined> {
  return boundedTextBody(request, V3_MAX_BODY_BYTES)
}

function parseCreation(serialized: string): V3RouteCreation | undefined {
  let value: unknown
  try { value = JSON.parse(serialized) } catch { return undefined }
  if (!record(value)
    || !keys(value, ['version', 'hostDeviceId', 'hostEnrollmentId', 'deviceId', 'deviceEnrollmentId', 'hostToken', 'deviceToken'])
    || value.version !== 3) return undefined
  const hostDeviceId = publicId(value.hostDeviceId)
  const hostEnrollmentId = publicId(value.hostEnrollmentId)
  const deviceId = publicId(value.deviceId)
  const deviceEnrollmentId = publicId(value.deviceEnrollmentId)
  const hostToken = token(value.hostToken)
  const deviceToken = token(value.deviceToken)
  return hostDeviceId === undefined || hostEnrollmentId === undefined
    || deviceId === undefined || deviceEnrollmentId === undefined || hostToken === undefined
    || deviceToken === undefined || hostToken === deviceToken
    ? undefined
    : { hostDeviceId, hostEnrollmentId, deviceId, deviceEnrollmentId, hostToken, deviceToken }
}

function parseRotation(serialized: string): V3RouteRotation | undefined {
  let value: unknown
  try { value = JSON.parse(serialized) } catch { return undefined }
  if (!record(value) || !keys(value, ['version', 'hostDeviceId', 'hostEnrollmentId', 'deviceId', 'deviceEnrollmentId', 'hostToken', 'deviceToken', 'generation']) || value.version !== 3) return undefined
  const { generation: _generation, ...creation } = value
  const base = parseCreation(JSON.stringify(creation))
  const generation = typeof value.generation === 'number' && Number.isSafeInteger(value.generation) && value.generation >= 2 && value.generation <= 2_147_483_647
    ? value.generation
    : undefined
  return base === undefined || generation === undefined ? undefined : { ...base, generation }
}

function validAttachment(value: unknown): value is V3Attachment {
  if (!record(value)) return false
  return value.version === 3
    && typeof value.connectionId === 'string'
    && (value.supersededBy === null || typeof value.supersededBy === 'string')
    && typeof value.routeId === 'string'
    && value.routeVersion === 3
    && typeof value.routeGeneration === 'number'
    && Number.isSafeInteger(value.routeGeneration)
    && typeof value.routeSalt === 'string'
    && (value.peer === 'host' || value.peer === 'device')
    && typeof value.deviceId === 'string'
    && typeof value.enrollmentId === 'string'
    && (value.epoch === null || (typeof value.epoch === 'number' && Number.isSafeInteger(value.epoch)))
    && typeof value.connectedAt === 'number'
    && Number.isSafeInteger(value.connectedAt)
    && typeof value.rateWindowStartedAt === 'number'
    && typeof value.messagesInWindow === 'number'
}

function sequenceKey(message: Extract<RemoteRelayMessage, { type: 'ciphertext' }>): string {
  return `${V3_SEQUENCE_PREFIX}${message.generation}:${message.connectionEpoch}:${message.senderDeviceId}:${message.senderEnrollmentId}:${message.recipientDeviceId}:${message.recipientEnrollmentId}`
}

function sequencePrefix(metadata: V3RouteMetadata, epoch?: number): string {
  const base = `${V3_SEQUENCE_PREFIX}${metadata.generation}:`
  return epoch === undefined ? base : `${base}${epoch}:`
}

function sameRoute(left: V3RouteMetadata, right: V3RouteMetadata): boolean {
  return left.routeId === right.routeId
    && left.version === right.version
    && left.generation === right.generation
    && left.tokenSalt === right.tokenSalt
}

function attachmentMatches(metadata: V3RouteMetadata, attachment: V3Attachment): boolean {
  return attachment.routeId === metadata.routeId
    && attachment.routeVersion === metadata.version
    && attachment.routeGeneration === metadata.generation
    && attachment.routeSalt === metadata.tokenSalt
}

/** Public router for the durable v3 blind relay. V2 routes remain isolated under `/v1`. */
export const v3Router: ExportedHandler<V3Env> = {
  async fetch(request, env): Promise<Response> {
    return routeV3(request, env)
  },
}

/** Route V3 HTTP and WebSocket requests without exposing the V2 pairing namespace. */
export async function routeV3(request: Request, env: V3Env): Promise<Response> {
  const url = new URL(request.url)
  const created = routeId(url)
  if (request.method === 'POST' && created !== undefined && url.search === '') {
    const provisioning = token(env.V3_PROVISIONING_TOKEN)
    const credential = bearer(request.headers.get('authorization'))
    if (provisioning === undefined || credential === undefined || !constantTime(credential, provisioning)) return json(401, { error: 'unauthorized' })
    const body = await textBody(request)
    if (body === undefined || parseCreation(body) === undefined) return json(400, { error: 'invalid-request' })
    return env.REMOTE_ROUTES.getByName(created).fetch(actionRequest(request, 'create', created, body))
  }
  const connected = routeId(url, '/connect')
  if (request.method === 'GET' && connected !== undefined && url.search === '') {
    if (request.headers.get('Upgrade')?.toLowerCase() !== UPGRADE || connectionToken(request.headers.get('sec-websocket-protocol')) === undefined) return json(401, { error: 'unauthorized' })
    return env.REMOTE_ROUTES.getByName(connected).fetch(actionRequest(request, 'connect', connected))
  }
  const rotating = routeId(url, '/rotate')
  if (request.method === 'POST' && rotating !== undefined && url.search === '') {
    if (bearer(request.headers.get('authorization')) === undefined) return json(401, { error: 'unauthorized' })
    const route = env.REMOTE_ROUTES.getByName(rotating)
    const authorized = await route.fetch(actionRequest(request, 'authorize-rotation', rotating))
    if (authorized.status !== 204) return authorized
    const body = await textBody(request)
    if (body === undefined || parseRotation(body) === undefined) return json(400, { error: 'invalid-request' })
    return route.fetch(actionRequest(request, 'rotate', rotating, body))
  }
  const revoked = routeId(url)
  if (request.method === 'DELETE' && revoked !== undefined && url.search === '') {
    if (bearer(request.headers.get('authorization')) === undefined) return json(401, { error: 'unauthorized' })
    return env.REMOTE_ROUTES.getByName(revoked).fetch(actionRequest(request, 'revoke', revoked))
  }
  return json(404, { error: 'not-found' })
}

/** One hibernation-safe coordinator that retains verifiers and ordering metadata, never application ciphertext. */
export class RemoteRoute extends DurableObject<V3Env> {
  override async fetch(request: Request): Promise<Response> {
    const id = publicId(request.headers.get(V3_INTERNAL_ROUTE_ID))
    if (id === undefined) return json(400, { error: 'invalid-request' })
    switch (request.headers.get(V3_INTERNAL_ACTION)) {
      case 'create': return this.create(request, id)
      case 'connect': return this.openConnection(request, id)
      case 'authorize-rotation': return this.authorizeRotation(request, id)
      case 'rotate': return this.rotate(request, id)
      case 'revoke': return this.revoke(request, id)
      default: return json(404, { error: 'not-found' })
    }
  }

  override async webSocketMessage(socket: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    const attachment = this.attachment(socket)
    if (attachment === undefined || !this.admitRate(socket, attachment) || typeof raw !== 'string') {
      this.reject(socket, 'malformed-message')
      return
    }
    let message: RemoteRelayMessage
    try {
      message = parseRemoteRelayMessage(raw)
    } catch {
      this.reject(socket, 'malformed-message')
      return
    }
    const metadata = await this.metadata()
    if (metadata === undefined) {
      this.reject(socket, 'route-revoked')
      return
    }
    if (!this.matchesRoute(message, metadata, attachment)) {
      this.reject(socket, 'sender-denied')
      return
    }
    await this.forward(socket, attachment, metadata, message)
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = this.attachment(socket)
    const metadata = await this.metadata()
    if (attachment === undefined || metadata === undefined || !attachmentMatches(metadata, attachment)) return
    if (attachment.supersededBy !== null) return
    const owner = this.socket(attachment.peer, metadata)
    const ownerAttachment = owner === undefined ? undefined : this.attachment(owner)
    if (ownerAttachment !== undefined && ownerAttachment.connectionId !== attachment.connectionId) return
    if (metadata.activeEpoch !== null) {
      await this.resetActiveConnection(metadata, 'peer-disconnected')
      return
    }
    await this.scheduleAlarm(metadata, socket)
  }

  override webSocketError(socket: WebSocket): void { socket.close(1011, 'relay-error') }

  override async alarm(): Promise<void> {
    const now = Date.now()
    const metadata = await this.metadata()
    if (metadata !== undefined && metadata.handshake !== 'live' && metadata.handshakeStartedAt !== null) {
      const deadline = metadata.handshakeStartedAt + V3_PENDING_HANDSHAKE_MS
      if (now >= deadline) {
        await this.resetActiveConnection(metadata, 'handshake-timeout')
        return
      }
    }
    const pending = this.ctx.getWebSockets().some((socket) => {
      const attachment = this.attachment(socket)
      return socket.readyState === WebSocket.OPEN && attachment !== undefined && metadata !== undefined
        && attachmentMatches(metadata, attachment) && attachment.supersededBy === null
        && attachment.epoch === null && now - attachment.connectedAt >= V3_PENDING_HANDSHAKE_MS
    })
    if (pending && metadata !== undefined && metadata.handshake !== 'live') {
      await this.resetActiveConnection(metadata, 'handshake-timeout')
      return
    }
    if (metadata !== undefined) await this.scheduleAlarm(metadata)
  }

  private async create(request: Request, id: string): Promise<Response> {
    const input = parseCreation(await request.text())
    if (input === undefined) return json(400, { error: 'invalid-request' })
    const salt = base64Url(crypto.getRandomValues(new Uint8Array(32)))
    const metadata: V3RouteMetadata = {
      version: 3,
      routeId: id,
      hostDeviceId: input.hostDeviceId,
      hostEnrollmentId: input.hostEnrollmentId,
      deviceId: input.deviceId,
      deviceEnrollmentId: input.deviceEnrollmentId,
      tokenSalt: salt,
      hostTokenVerifier: await verifier(input.hostToken, salt), deviceTokenVerifier: await verifier(input.deviceToken, salt),
      generation: 1, lastEpoch: 0, pendingFinalityEpoch: null, activeEpoch: null, handshake: 'none', handshakeStartedAt: null,
    }
    const created = await this.ctx.storage.transaction(async (storage) => {
      if (await storage.get(V3_ROUTE_KEY) !== undefined) return false
      await storage.put(V3_ROUTE_KEY, metadata)
      return true
    })
    if (!created) return json(409, { error: 'route-exists' })
    return json(201, { generation: metadata.generation })
  }

  private async openConnection(request: Request, id: string): Promise<Response> {
    const credential = connectionToken(request.headers.get('sec-websocket-protocol'))
    const metadata = await this.metadata()
    if (credential === undefined || metadata === undefined || metadata.routeId !== id) return json(401, { error: 'unauthorized' })
    const presentedVerifier = await verifier(credential.token, metadata.tokenSalt)
    const expected = credential.peer === 'host' ? metadata.hostTokenVerifier : metadata.deviceTokenVerifier
    if (!constantTime(presentedVerifier, expected)) return json(401, { error: 'unauthorized' })
    const current = await this.metadata()
    if (current === undefined || !sameRoute(current, metadata)) return json(401, { error: 'unauthorized' })
    const currentExpected = credential.peer === 'host' ? current.hostTokenVerifier : current.deviceTokenVerifier
    if (!constantTime(presentedVerifier, currentExpected)) return json(401, { error: 'unauthorized' })
    const connectedAt = Date.now()
    const connectionId = base64Url(crypto.getRandomValues(new Uint8Array(16)))
    this.evictExpiredPending(current, connectedAt, connectionId)
    if (this.socket(credential.peer, current) !== undefined) return json(409, { error: 'connection-exists' })
    const pair = new WebSocketPair()
    const server = pair[1]
    server.serializeAttachment({
      version: 3,
      connectionId,
      supersededBy: null,
      routeId: current.routeId,
      routeVersion: current.version,
      routeGeneration: current.generation,
      routeSalt: current.tokenSalt,
      peer: credential.peer,
      deviceId: credential.peer === 'host' ? current.hostDeviceId : current.deviceId,
      enrollmentId: credential.peer === 'host' ? current.hostEnrollmentId : current.deviceEnrollmentId,
      epoch: null,
      connectedAt,
      rateWindowStartedAt: connectedAt,
      messagesInWindow: 0,
    } satisfies V3Attachment)
    this.ctx.acceptWebSocket(server)
    await this.scheduleAlarm(current)
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'sec-websocket-protocol': V3_PROTOCOL_NAME, 'cache-control': 'no-store' } })
  }

  private async rotate(request: Request, id: string): Promise<Response> {
    const existing = await this.metadata()
    const old = bearer(request.headers.get('authorization'))
    if (existing === undefined || old === undefined || existing.routeId !== id) {
      return json(401, { error: 'unauthorized' })
    }
    const presentedVerifier = await verifier(old, existing.tokenSalt)
    if (!constantTime(presentedVerifier, existing.hostTokenVerifier)) {
      return json(401, { error: 'unauthorized' })
    }
    const serialized = await textBody(request)
    const input = serialized === undefined ? undefined : parseRotation(serialized)
    if (input === undefined) return json(401, { error: 'unauthorized' })
    if (input.hostDeviceId !== existing.hostDeviceId || input.hostEnrollmentId !== existing.hostEnrollmentId
      || input.deviceId !== existing.deviceId || input.deviceEnrollmentId !== existing.deviceEnrollmentId
      || input.generation !== existing.generation + 1) return json(400, { error: 'invalid-request' })
    const salt = base64Url(crypto.getRandomValues(new Uint8Array(32)))
    const next: V3RouteMetadata = {
      ...existing,
      tokenSalt: salt,
      hostTokenVerifier: await verifier(input.hostToken, salt),
      deviceTokenVerifier: await verifier(input.deviceToken, salt),
      generation: input.generation, lastEpoch: 0, pendingFinalityEpoch: null, activeEpoch: null, handshake: 'none', handshakeStartedAt: null,
    }
    const committed = await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<V3RouteMetadata>(V3_ROUTE_KEY)
      if (current === undefined || current.routeId !== id
        || current.version !== existing.version || current.generation !== existing.generation
        || current.tokenSalt !== existing.tokenSalt
        || !constantTime(presentedVerifier, current.hostTokenVerifier)) return false
      const entries = await storage.list({ prefix: sequencePrefix(current) })
      const keys = [...entries.keys()]
      if (keys.length > 0) await storage.delete(keys)
      await storage.put(V3_ROUTE_KEY, next)
      await storage.deleteAlarm()
      return true
    })
    if (!committed) return json(401, { error: 'unauthorized' })
    this.closePeers('route-rotated')
    return json(200, { generation: next.generation })
  }

  private async authorizeRotation(request: Request, id: string): Promise<Response> {
    const existing = await this.metadata()
    const credential = bearer(request.headers.get('authorization'))
    if (existing === undefined || credential === undefined || existing.routeId !== id
      || !constantTime(await verifier(credential, existing.tokenSalt), existing.hostTokenVerifier)) {
      return json(401, { error: 'unauthorized' })
    }
    return new Response(null, { status: 204 })
  }

  private async revoke(request: Request, id: string): Promise<Response> {
    const metadata = await this.metadata()
    const credential = bearer(request.headers.get('authorization'))
    if (metadata === undefined) return json(404, { error: 'not-found' })
    if (credential === undefined || metadata.routeId !== id
      || !constantTime(await verifier(credential, metadata.tokenSalt), metadata.hostTokenVerifier)) {
      return json(401, { error: 'unauthorized' })
    }
    const result = await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<V3RouteMetadata>(V3_ROUTE_KEY)
      if (current === undefined) return 'not-found'
      if (current.routeId !== id
        || !constantTime(await verifier(credential, current.tokenSalt), current.hostTokenVerifier)) return 'unauthorized'
      const entries = await storage.list()
      const keys = [...entries.keys()]
      if (keys.length > 0) await storage.delete(keys)
      await storage.deleteAlarm()
      return 'deleted'
    })
    if (result === 'not-found') return json(404, { error: 'not-found' })
    if (result === 'unauthorized') return json(401, { error: 'unauthorized' })
    this.closePeers('route-revoked')
    return new Response(null, { status: 204 })
  }

  private async forward(
    socket: WebSocket,
    attachment: V3Attachment,
    metadata: V3RouteMetadata,
    message: RemoteRelayMessage,
  ): Promise<void> {
    const recipient = this.socket(attachment.peer === 'host' ? 'device' : 'host', metadata)
    if (recipient === undefined) {
      this.send(socket, { type: 'relay-error', version: 3, code: 'recipient-offline' })
      return
    }
    const next = this.handshake(socket, metadata, attachment, message)
    if (next === undefined) {
      await this.resetActiveConnection(metadata, 'handshake-denied')
      return
    }
    if (message.type === 'ciphertext') {
      const admitted = await this.ctx.storage.transaction(async (storage) => {
        const current = await storage.get<V3RouteMetadata>(V3_ROUTE_KEY)
        if (current === undefined || !sameRoute(current, metadata)
          || current.activeEpoch !== metadata.activeEpoch || current.handshake !== metadata.handshake) return false
        const previous = await storage.get<number>(sequenceKey(message)) ?? 0
        if (message.sequence !== previous + 1) return false
        await storage.put(sequenceKey(message), message.sequence)
        return true
      })
      if (!admitted) {
        const current = await this.metadata()
        if (current !== undefined && sameRoute(current, metadata)) {
          await this.resetActiveConnection(metadata, 'sequence-denied')
        } else {
          this.reject(socket, 'route-revoked')
        }
        return
      }
    }
    const current = await this.metadata()
    if (current === undefined || !sameRoute(current, metadata)) {
      this.reject(socket, 'route-revoked')
      return
    }
    const persistedBeforeForward = message.type === 'confirm' && next !== metadata
    if (persistedBeforeForward && !await this.commitTransition(metadata, next)) {
      this.reject(socket, 'route-revoked')
      return
    }
    try {
      recipient.send(JSON.stringify(message))
    } catch {
      await this.resetActiveConnection(next, 'recipient-unavailable')
      return
    }
    if (!persistedBeforeForward && next !== metadata && !await this.commitTransition(metadata, next)) {
      this.reject(socket, 'route-revoked')
    }
  }

  private handshake(
    socket: WebSocket,
    metadata: V3RouteMetadata,
    attachment: V3Attachment,
    message: RemoteRelayMessage,
  ): V3RouteMetadata | undefined {
    if (message.type === 'hello') {
      const retryPendingFinality = message.connectionEpoch === metadata.pendingFinalityEpoch
      const advanceAfterPendingFinality = metadata.pendingFinalityEpoch !== null
        && message.connectionEpoch === metadata.pendingFinalityEpoch + 1
      if (attachment.peer !== 'device' || attachment.epoch !== null
        || (!retryPendingFinality && !advanceAfterPendingFinality && message.connectionEpoch !== metadata.lastEpoch + 1)) return undefined
      socket.serializeAttachment({ ...attachment, epoch: message.connectionEpoch })
      return {
        ...metadata,
        activeEpoch: message.connectionEpoch,
        handshake: 'hello',
        handshakeStartedAt: Date.now(),
      }
    }
    if (message.type === 'welcome') {
      if (attachment.peer !== 'host' || attachment.epoch !== null || metadata.handshake !== 'hello' || message.connectionEpoch !== metadata.activeEpoch) return undefined
      socket.serializeAttachment({ ...attachment, epoch: message.connectionEpoch })
      return { ...metadata, handshake: 'welcome' }
    }
    if (message.type === 'ready') {
      if (attachment.peer !== 'device' || attachment.epoch !== metadata.activeEpoch || metadata.handshake !== 'welcome' || message.connectionEpoch !== metadata.activeEpoch) return undefined
      return { ...metadata, handshake: 'ready' }
    }
    if (message.type === 'finish') {
      if (attachment.peer !== 'host' || attachment.epoch !== metadata.activeEpoch || metadata.handshake !== 'ready' || message.connectionEpoch !== metadata.activeEpoch) return undefined
      return { ...metadata, handshake: 'finish' }
    }
    if (message.type === 'ack') {
      if (attachment.peer !== 'device' || attachment.epoch !== metadata.activeEpoch || metadata.handshake !== 'finish' || message.connectionEpoch !== metadata.activeEpoch) return undefined
      return { ...metadata, handshake: 'ack' }
    }
    if (message.type === 'commit') {
      if (attachment.peer !== 'host' || attachment.epoch !== metadata.activeEpoch || metadata.handshake !== 'ack' || message.connectionEpoch !== metadata.activeEpoch) return undefined
      return { ...metadata, handshake: 'commit' }
    }
    if (message.type === 'confirm') {
      if (attachment.peer !== 'device' || attachment.epoch !== metadata.activeEpoch || metadata.handshake !== 'commit' || message.connectionEpoch !== metadata.activeEpoch) return undefined
      return { ...metadata, pendingFinalityEpoch: message.connectionEpoch, handshake: 'confirm' }
    }
    if (message.type === 'receipt') {
      if (attachment.peer !== 'host' || attachment.epoch !== metadata.activeEpoch || metadata.handshake !== 'confirm' || message.connectionEpoch !== metadata.activeEpoch) return undefined
      return { ...metadata, lastEpoch: message.connectionEpoch, pendingFinalityEpoch: null, handshake: 'live', handshakeStartedAt: null }
    }
    return metadata.handshake === 'live' && attachment.epoch === metadata.activeEpoch && message.connectionEpoch === metadata.activeEpoch ? metadata : undefined
  }

  private matchesRoute(message: RemoteRelayMessage, metadata: V3RouteMetadata, attachment: V3Attachment): boolean {
    return attachment.supersededBy === null && attachmentMatches(metadata, attachment)
      && message.routeId === metadata.routeId && message.generation === metadata.generation
      && message.senderDeviceId === attachment.deviceId
      && message.senderEnrollmentId === attachment.enrollmentId
      && message.recipientDeviceId === (attachment.peer === 'host' ? metadata.deviceId : metadata.hostDeviceId)
      && message.recipientEnrollmentId === (attachment.peer === 'host' ? metadata.deviceEnrollmentId : metadata.hostEnrollmentId)
  }

  private admitRate(socket: WebSocket, attachment: V3Attachment): boolean {
    const now = Date.now()
    const window = now - attachment.rateWindowStartedAt >= 1_000
      ? { startedAt: now, count: 1 }
      : { startedAt: attachment.rateWindowStartedAt, count: attachment.messagesInWindow + 1 }
    if (window.count > V3_MAX_MESSAGES_PER_SECOND) { socket.close(4429, 'rate-limited'); return false }
    socket.serializeAttachment({ ...attachment, rateWindowStartedAt: window.startedAt, messagesInWindow: window.count })
    return true
  }

  private attachment(socket: WebSocket): V3Attachment | undefined {
    const attachment: unknown = socket.deserializeAttachment()
    return validAttachment(attachment) ? attachment : undefined
  }

  private socket(peer: V3Peer, metadata: V3RouteMetadata): WebSocket | undefined {
    return this.ctx.getWebSockets().find((socket) => {
      const attachment = this.attachment(socket)
      return socket.readyState === WebSocket.OPEN && attachment?.peer === peer && attachment.supersededBy === null
        && attachmentMatches(metadata, attachment)
    })
  }

  private evictExpiredPending(metadata: V3RouteMetadata, now: number, replacementId: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(socket)
      if (socket.readyState === WebSocket.OPEN && attachment !== undefined
        && attachment.supersededBy === null && attachmentMatches(metadata, attachment) && attachment.epoch === null
        && attachment.connectedAt + V3_PENDING_HANDSHAKE_MS <= now) {
        socket.serializeAttachment({ ...attachment, supersededBy: replacementId })
        socket.close(4403, 'handshake-timeout')
      }
    }
  }

  private async metadata(): Promise<V3RouteMetadata | undefined> {
    const metadata = await this.ctx.storage.get<V3RouteMetadata>(V3_ROUTE_KEY)
    if (metadata?.version !== 3) return undefined
    const pendingFinalityEpoch = metadata.pendingFinalityEpoch
    return {
      ...metadata,
      pendingFinalityEpoch: pendingFinalityEpoch === null || (typeof pendingFinalityEpoch === 'number' && Number.isSafeInteger(pendingFinalityEpoch) && pendingFinalityEpoch >= 1 && pendingFinalityEpoch <= 2_147_483_647)
        ? pendingFinalityEpoch
        : null,
    }
  }

  private async scheduleAlarm(expected: V3RouteMetadata, closing?: WebSocket): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<V3RouteMetadata>(V3_ROUTE_KEY)
      if (current === undefined || !sameRoute(current, expected)) return
      const deadlines = this.ctx.getWebSockets()
        .filter(socket => socket !== closing && socket.readyState === WebSocket.OPEN)
        .map(socket => this.attachment(socket))
        .filter((attachment): attachment is V3Attachment => attachment !== undefined
          && attachment.supersededBy === null && attachmentMatches(current, attachment) && attachment.epoch === null)
        .map(attachment => attachment.connectedAt + V3_PENDING_HANDSHAKE_MS)
      if (current.handshake !== 'live' && current.handshakeStartedAt !== null) {
        deadlines.push(current.handshakeStartedAt + V3_PENDING_HANDSHAKE_MS)
      }
      const deadline = deadlines.sort((left, right) => left - right)[0]
      const scheduled = await storage.getAlarm()
      if (deadline === undefined) {
        if (scheduled !== null) await storage.deleteAlarm()
      } else if (scheduled !== deadline) {
        await storage.setAlarm(deadline)
      }
    })
  }

  private async resetActiveConnection(metadata: V3RouteMetadata, reason: string): Promise<void> {
    const reset = await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<V3RouteMetadata>(V3_ROUTE_KEY)
      if (current === undefined || !sameRoute(current, metadata)) return false
      const entries = await storage.list({ prefix: sequencePrefix(current, current.activeEpoch ?? undefined) })
      const keys = [...entries.keys()]
      if (keys.length > 0) await storage.delete(keys)
      await storage.put(V3_ROUTE_KEY, {
        ...current,
        activeEpoch: null,
        handshake: 'none',
        handshakeStartedAt: null,
      } satisfies V3RouteMetadata)
      await storage.deleteAlarm()
      return true
    })
    if (reset) this.closePeers(reason)
  }

  private async commitTransition(expected: V3RouteMetadata, next: V3RouteMetadata): Promise<boolean> {
    return this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<V3RouteMetadata>(V3_ROUTE_KEY)
      if (current === undefined || !sameRoute(current, expected)
        || current.activeEpoch !== expected.activeEpoch || current.handshake !== expected.handshake
        || current.pendingFinalityEpoch !== expected.pendingFinalityEpoch || current.lastEpoch !== expected.lastEpoch) return false
      await storage.put(V3_ROUTE_KEY, next)
      return true
    })
  }

  private send(socket: WebSocket, payload: object): void {
    try { socket.send(JSON.stringify(payload)) } catch { socket.close(1011, 'relay-error') }
  }

  private reject(socket: WebSocket, code: string): void {
    this.send(socket, { type: 'relay-error', version: 3, code })
    socket.close(4400, 'relay-rejected')
  }

  private closePeers(reason: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      this.send(socket, { type: 'route-revoked', version: 3, reason })
      socket.close(4403, reason)
    }
  }
}
