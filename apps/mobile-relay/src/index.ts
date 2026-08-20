/** Cloudflare Worker and Durable Object for accountless encrypted mobile pairing. */

import {
  acceptRelayFrame,
  PAIRING_PROTOCOL_VERSION,
} from '@deepseek-ai/dsh-pairing-protocol'
import type { MobilePairingCapability, RelayFrame } from '@deepseek-ai/dsh-pairing-protocol'
import { DurableObject } from 'cloudflare:workers'
import {
  MAX_CREATION_BODY_BYTES,
  MAX_MESSAGES_PER_SECOND,
  parseConnectionToken,
  parseCreationToken,
  parsePairingCreation,
  parsePairingId,
  parseRelayMessage,
} from './protocol.ts'
import type { RelayControl } from './protocol.ts'

/** Worker bindings required by the public router and pairing coordinator. */
export interface Env {
  PAIRINGS: DurableObjectNamespace<PairingRoom>
  PAIRING_ALLOCATOR: DurableObjectNamespace<PairingAllocator>
  PAIRING_CREATIONS_PER_IP: RateLimit
}

const METADATA_KEY = 'pairing'
const SEQUENCE_KEY_PREFIX = 'sequence:'
const PROTOCOL_NAME = 'dsh-pairing-v1'
const INTERNAL_ACTION = 'x-dsh-relay-action'
const INTERNAL_PAIRING_ID = 'x-dsh-relay-pairing-id'
const WEBSOCKET_UPGRADE = 'websocket'
const MAX_CONNECTIONS_PER_ROLE = 1
const ALLOCATION_WINDOW_KEY = 'allocation-window'
const ALLOCATION_WINDOW_MS = 10_000
const MAX_ALLOCATIONS_PER_WINDOW = 20

type PairingStatus = 'pending' | 'accepted'
type ConnectionPeer = 'desktop-pending' | 'mobile-pending' | 'desktop' | 'mobile'
type RevocationReason = 'desktop-disconnected' | 'desktop-revoked' | 'expired'

interface PairingMobile {
  readonly deviceId: string
  readonly capabilities: readonly MobilePairingCapability[]
}

interface PairingMetadata {
  readonly version: typeof PAIRING_PROTOCOL_VERSION
  readonly pairingId: string
  readonly desktopDeviceId: string
  readonly tokenSalt: string
  readonly desktopTokenVerifier: string
  readonly mobileTokenVerifier: string
  readonly expiresAt: number
  readonly status: PairingStatus
  readonly mobile: PairingMobile | null
}

interface ConnectionAttachment {
  readonly version: typeof PAIRING_PROTOCOL_VERSION
  readonly peer: ConnectionPeer
  readonly deviceId: string | null
  readonly rateWindowStartedAt: number
  readonly messagesInWindow: number
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === WEBSOCKET_UPGRADE
}

function pathPairingId(url: URL, suffix: string): string | undefined {
  const prefix = '/v1/pairings/'
  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix)) return undefined
  const encoded = url.pathname.slice(prefix.length, url.pathname.length - suffix.length)
  if (encoded.includes('/')) return undefined
  try {
    return parsePairingId(decodeURIComponent(encoded))
  } catch {
    return undefined
  }
}

function actionRequest(request: Request, action: 'create' | 'connect', pairingId: string, body?: string): Request {
  const headers = new Headers(request.headers)
  headers.set(INTERNAL_ACTION, action)
  headers.set(INTERNAL_PAIRING_ID, pairingId)
  headers.delete('content-length')
  const init: RequestInit = {
    method: request.method,
    headers,
  }
  if (body !== undefined) init.body = body
  return new Request(request.url, init)
}

function declaredBodyIsTooLarge(request: Request): boolean {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength === null) return false
  if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) return true
  return Number(declaredLength) > MAX_CREATION_BODY_BYTES
}

async function boundedRequestText(request: Request, maximumBytes: number): Promise<string | undefined> {
  if (declaredBodyIsTooLarge(request)) return undefined
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      received += next.value.byteLength
      if (received > maximumBytes) {
        await reader.cancel('body-too-large')
        return undefined
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return undefined
  }
}

async function creationAdmitted(request: Request, env: Env): Promise<boolean> {
  const clientIp = request.headers.get('cf-connecting-ip')
  if (clientIp === null || clientIp.length === 0 || clientIp.length > 64) return false
  const perIp = await env.PAIRING_CREATIONS_PER_IP.limit({ key: clientIp })
  return perIp.success
}

async function allocationAdmitted(env: Env): Promise<boolean> {
  const response = await env.PAIRING_ALLOCATOR.getByName('v1').fetch('https://allocator.internal/allocate', {
    headers: { [INTERNAL_ACTION]: 'allocate' },
  })
  return response.status === 204
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function equalsConstantTime(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  const width = Math.max(left.length, right.length)
  for (let index = 0; index < width; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

async function verifier(token: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}.${token}`)
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

function sameCapabilities(left: readonly MobilePairingCapability[], right: readonly MobilePairingCapability[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validAttachment(value: unknown): value is ConnectionAttachment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.version === PAIRING_PROTOCOL_VERSION
    && (candidate.peer === 'desktop-pending' || candidate.peer === 'mobile-pending' || candidate.peer === 'desktop' || candidate.peer === 'mobile')
    && (typeof candidate.deviceId === 'string' || candidate.deviceId === null)
    && typeof candidate.rateWindowStartedAt === 'number'
    && Number.isSafeInteger(candidate.rateWindowStartedAt)
    && typeof candidate.messagesInWindow === 'number'
    && Number.isSafeInteger(candidate.messagesInWindow)
}

function sequenceKey(frame: RelayFrame): string {
  return `${SEQUENCE_KEY_PREFIX}${frame.senderDeviceId}:${frame.recipientDeviceId}`
}

/**
 * Routes only the pairing creation and WebSocket paths. It rejects malformed
 * requests before they instantiate a Durable Object.
 */
const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/healthz' && url.search === '') {
      return json(200, { status: 'ok' })
    }

    const createPairingId = pathPairingId(url, '')
    if (request.method === 'POST' && createPairingId !== undefined && url.search === '') {
      const desktopToken = parseCreationToken(request.headers.get('authorization'))
      if (desktopToken === undefined) return json(401, { error: 'unauthorized' })
      if (!await creationAdmitted(request, env)) return json(429, { error: 'rate-limited' })
      const body = await boundedRequestText(request, MAX_CREATION_BODY_BYTES)
      if (body === undefined) return json(413, { error: 'payload-too-large' })
      const creation = parsePairingCreation(body)
      if (creation === undefined || equalsConstantTime(desktopToken, creation.mobileRelayToken)) return json(400, { error: 'invalid-request' })
      if (!await allocationAdmitted(env)) return json(429, { error: 'rate-limited' })
      return env.PAIRINGS.getByName(createPairingId).fetch(actionRequest(request, 'create', createPairingId, body))
    }

    const connectPairingId = pathPairingId(url, '/connect')
    if (request.method === 'GET' && connectPairingId !== undefined && url.search === '') {
      if (!isWebSocketUpgrade(request)) return json(426, { error: 'websocket-required' })
      if (parseConnectionToken(request.headers.get('sec-websocket-protocol')) === undefined) return json(401, { error: 'unauthorized' })
      return env.PAIRINGS.getByName(connectPairingId).fetch(actionRequest(request, 'connect', connectPairingId))
    }

    return json(404, { error: 'not-found' })
  },
}

export default worker

interface AllocationWindow {
  readonly startedAt: number
  readonly count: number
}

/** Globally serialized short-window allocation budget for public pairings. */
export class PairingAllocator extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_ACTION) !== 'allocate') return json(404, { error: 'not-found' })
    const now = Date.now()
    const previous = await this.ctx.storage.get<AllocationWindow>(ALLOCATION_WINDOW_KEY)
    const window = previous === undefined || now - previous.startedAt >= ALLOCATION_WINDOW_MS
      ? { startedAt: now, count: 0 }
      : previous
    if (window.count >= MAX_ALLOCATIONS_PER_WINDOW) return new Response(null, { status: 429 })
    await this.ctx.storage.put(ALLOCATION_WINDOW_KEY, { ...window, count: window.count + 1 })
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  }
}

/**
 * One hibernation-safe coordinator for a desktop-created pairing id. The
 * object stores no ciphertext and all state expires with the QR bootstrap.
 */
export class PairingRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const action = request.headers.get(INTERNAL_ACTION)
    const pairingId = parsePairingId(request.headers.get(INTERNAL_PAIRING_ID))
    if (pairingId === undefined) return json(400, { error: 'invalid-request' })
    if (action === 'create') return this.create(request, pairingId)
    if (action === 'connect') return this.openConnection(request, pairingId)
    return json(404, { error: 'not-found' })
  }

  override async alarm(): Promise<void> {
    const metadata = await this.metadata()
    if (metadata === undefined) return
    if (metadata.expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(metadata.expiresAt)
      return
    }
    this.closePeers('expired')
    await this.ctx.storage.deleteAll()
  }

  override async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const attachment = this.attachment(socket)
    if (attachment === undefined || !this.consumeMessage(socket, attachment)) return
    if (typeof message !== 'string') {
      this.reject(socket, 'malformed-message')
      return
    }
    const metadata = await this.liveMetadata()
    if (metadata === undefined) {
      this.reject(socket, 'expired')
      return
    }
    const parsed = parseRelayMessage(message)
    if (parsed === undefined) {
      this.reject(socket, 'malformed-message')
      return
    }
    if (parsed.kind === 'control') {
      await this.handleControl(socket, attachment, metadata, parsed.control)
      return
    }
    await this.forwardFrame(socket, attachment, metadata, parsed.frame)
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = this.attachment(socket)
    if (attachment?.peer !== 'desktop') return
    const metadata = await this.metadata()
    if (metadata !== undefined) await this.terminate('desktop-disconnected')
  }

  override webSocketError(socket: WebSocket): void {
    socket.close(1011, 'relay-error')
  }

  private async create(request: Request, pairingId: string): Promise<Response> {
    const token = parseCreationToken(request.headers.get('authorization'))
    const creation = parsePairingCreation(await request.text())
    if (token === undefined || creation === undefined) return json(400, { error: 'invalid-request' })
    if (equalsConstantTime(token, creation.mobileRelayToken)) return json(400, { error: 'invalid-request' })
    const existing = await this.metadata()
    if (existing !== undefined && existing.expiresAt > Date.now()) return json(409, { error: 'pairing-exists' })
    if (existing !== undefined) await this.ctx.storage.deleteAll()
    const saltBytes = crypto.getRandomValues(new Uint8Array(32))
    const tokenSalt = base64Url(saltBytes)
    const metadata: PairingMetadata = {
      version: PAIRING_PROTOCOL_VERSION,
      pairingId,
      desktopDeviceId: creation.desktopDeviceId,
      tokenSalt,
      desktopTokenVerifier: await verifier(token, tokenSalt),
      mobileTokenVerifier: await verifier(creation.mobileRelayToken, tokenSalt),
      expiresAt: creation.expiresAt,
      status: 'pending',
      mobile: null,
    }
    await this.ctx.storage.put(METADATA_KEY, metadata)
    await this.ctx.storage.setAlarm(metadata.expiresAt)
    return json(201, { expiresAt: metadata.expiresAt })
  }

  private async openConnection(request: Request, pairingId: string): Promise<Response> {
    const token = parseConnectionToken(request.headers.get('sec-websocket-protocol'))
    if (token === undefined || !isWebSocketUpgrade(request)) return json(401, { error: 'unauthorized' })
    const metadata = await this.liveMetadata()
    if (metadata === undefined || metadata.pairingId !== pairingId) return json(404, { error: 'not-found' })
    const tokenVerifier = token.peer === 'desktop' ? metadata.desktopTokenVerifier : metadata.mobileTokenVerifier
    if (!equalsConstantTime(await verifier(token.token, metadata.tokenSalt), tokenVerifier)) return json(401, { error: 'unauthorized' })
    if (this.connectionCount(token.peer) >= MAX_CONNECTIONS_PER_ROLE) return json(409, { error: 'connection-exists' })
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const attachment: ConnectionAttachment = {
      version: PAIRING_PROTOCOL_VERSION,
      peer: token.peer === 'desktop' ? 'desktop-pending' : 'mobile-pending',
      deviceId: null,
      rateWindowStartedAt: Date.now(),
      messagesInWindow: 0,
    }
    server.serializeAttachment(attachment)
    this.ctx.acceptWebSocket(server)
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'sec-websocket-protocol': PROTOCOL_NAME, 'cache-control': 'no-store' },
    })
  }

  private async handleControl(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    metadata: PairingMetadata,
    control: RelayControl,
  ): Promise<void> {
    if (control.pairingId !== metadata.pairingId) {
      this.reject(socket, 'pairing-mismatch')
      return
    }
    switch (control.type) {
      case 'desktop-hello':
        this.acceptDesktop(socket, attachment, metadata, control.desktopDeviceId)
        return
      case 'mobile-request':
        await this.requestMobile(socket, attachment, metadata, control)
        return
      case 'desktop-accept':
        await this.acceptMobile(socket, attachment, metadata, control.mobileDeviceId)
        return
      case 'desktop-revoke':
        if (attachment.peer !== 'desktop') {
          this.reject(socket, 'desktop-required')
          return
        }
        await this.terminate('desktop-revoked')
        return
    }
  }

  private acceptDesktop(socket: WebSocket, attachment: ConnectionAttachment, metadata: PairingMetadata, deviceId: string): void {
    if (attachment.peer !== 'desktop-pending' || deviceId !== metadata.desktopDeviceId || this.peerSocket('desktop', deviceId, socket) !== undefined) {
      this.reject(socket, 'desktop-denied')
      return
    }
    socket.serializeAttachment({ ...attachment, peer: 'desktop', deviceId })
    this.send(socket, { type: 'desktop-ready', version: PAIRING_PROTOCOL_VERSION, pairingId: metadata.pairingId, expiresAt: metadata.expiresAt })
  }

  private async requestMobile(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    metadata: PairingMetadata,
    control: Extract<RelayControl, { readonly type: 'mobile-request' }>,
  ): Promise<void> {
    if (attachment.peer !== 'mobile-pending' || this.peerSocket('mobile', control.mobileDeviceId, socket) !== undefined) {
      this.reject(socket, 'mobile-denied')
      return
    }
    const mobile = metadata.mobile
    if (mobile !== null && (mobile.deviceId !== control.mobileDeviceId || !sameCapabilities(mobile.capabilities, control.capabilities))) {
      this.reject(socket, 'mobile-denied')
      return
    }
    const desktop = this.peerSocket('desktop', metadata.desktopDeviceId)
    if (metadata.status === 'pending' && desktop === undefined) {
      this.reject(socket, 'desktop-offline')
      return
    }
    const next = mobile === null
      ? { ...metadata, mobile: { deviceId: control.mobileDeviceId, capabilities: control.capabilities } }
      : metadata
    if (mobile === null) await this.ctx.storage.put(METADATA_KEY, next)
    socket.serializeAttachment({ ...attachment, peer: 'mobile', deviceId: control.mobileDeviceId })
    if (next.status === 'accepted') {
      this.sendAccepted(socket, next)
      return
    }
    if (desktop === undefined) {
      this.reject(socket, 'desktop-offline')
      return
    }
    this.send(desktop, {
      type: 'mobile-request',
      version: PAIRING_PROTOCOL_VERSION,
      pairingId: next.pairingId,
      mobileDeviceId: control.mobileDeviceId,
      capabilities: control.capabilities,
    })
  }

  private async acceptMobile(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    metadata: PairingMetadata,
    mobileDeviceId: string,
  ): Promise<void> {
    if (attachment.peer !== 'desktop' || metadata.status !== 'pending' || metadata.mobile?.deviceId !== mobileDeviceId) {
      this.reject(socket, 'mobile-not-pending')
      return
    }
    const next: PairingMetadata = { ...metadata, status: 'accepted' }
    await this.ctx.storage.put(METADATA_KEY, next)
    const mobile = this.peerSocket('mobile', mobileDeviceId)
    if (mobile !== undefined) this.sendAccepted(mobile, next)
  }

  private async forwardFrame(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    metadata: PairingMetadata,
    frame: RelayFrame,
  ): Promise<void> {
    const mobile = metadata.mobile
    if (metadata.status !== 'accepted' || mobile === null || frame.pairingId !== metadata.pairingId) {
      this.reject(socket, 'pairing-not-accepted')
      return
    }
    const expectedSender = attachment.peer === 'desktop'
      ? metadata.desktopDeviceId
      : attachment.peer === 'mobile' ? mobile.deviceId : undefined
    const expectedRecipient = attachment.peer === 'desktop'
      ? mobile.deviceId
      : attachment.peer === 'mobile' ? metadata.desktopDeviceId : undefined
    if (
      expectedSender === undefined
      || attachment.deviceId !== expectedSender
      || frame.senderDeviceId !== expectedSender
      || frame.recipientDeviceId !== expectedRecipient
    ) {
      this.reject(socket, 'sender-denied')
      return
    }
    const recipient = this.peerSocket(attachment.peer === 'desktop' ? 'mobile' : 'desktop', expectedRecipient)
    if (recipient === undefined) {
      this.send(socket, { type: 'relay-error', version: PAIRING_PROTOCOL_VERSION, code: 'recipient-offline' })
      return
    }
    const previous = await this.ctx.storage.get<number>(sequenceKey(frame)) ?? 0
    let sequence: number
    try {
      sequence = acceptRelayFrame(previous, frame)
    } catch {
      this.reject(socket, 'sequence-denied')
      return
    }
    try {
      recipient.send(JSON.stringify(frame))
    } catch {
      recipient.close(1011, 'relay-error')
      this.send(socket, { type: 'relay-error', version: PAIRING_PROTOCOL_VERSION, code: 'recipient-offline' })
      return
    }
    await this.ctx.storage.put(sequenceKey(frame), sequence)
  }

  private async terminate(reason: RevocationReason): Promise<void> {
    this.closePeers(reason)
    await this.ctx.storage.deleteAll()
  }

  private closePeers(reason: RevocationReason): void {
    for (const socket of this.ctx.getWebSockets()) {
      this.send(socket, { type: 'pairing-revoked', version: PAIRING_PROTOCOL_VERSION, reason })
      socket.close(4403, reason)
    }
  }

  private sendAccepted(socket: WebSocket, metadata: PairingMetadata): void {
    this.send(socket, { type: 'pairing-accepted', version: PAIRING_PROTOCOL_VERSION, pairingId: metadata.pairingId, expiresAt: metadata.expiresAt })
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    try {
      socket.send(JSON.stringify(payload))
    } catch {
      socket.close(1011, 'relay-error')
    }
  }

  private reject(socket: WebSocket, code: string): void {
    this.send(socket, { type: 'relay-error', version: PAIRING_PROTOCOL_VERSION, code })
    socket.close(4400, 'relay-rejected')
  }

  private consumeMessage(socket: WebSocket, attachment: ConnectionAttachment): boolean {
    const now = Date.now()
    const window = now - attachment.rateWindowStartedAt >= 1_000
      ? { startedAt: now, count: 1 }
      : { startedAt: attachment.rateWindowStartedAt, count: attachment.messagesInWindow + 1 }
    if (window.count > MAX_MESSAGES_PER_SECOND) {
      socket.close(4429, 'rate-limited')
      return false
    }
    socket.serializeAttachment({ ...attachment, rateWindowStartedAt: window.startedAt, messagesInWindow: window.count })
    return true
  }

  private attachment(socket: WebSocket): ConnectionAttachment | undefined {
    const value = socket.deserializeAttachment()
    return validAttachment(value) ? value : undefined
  }

  private peerSocket(peer: 'desktop' | 'mobile', deviceId: string, except?: WebSocket): WebSocket | undefined {
    return this.ctx.getWebSockets().find((socket: WebSocket) => {
      const attachment = this.attachment(socket)
      return socket !== except && attachment?.peer === peer && attachment.deviceId === deviceId
    })
  }

  private connectionCount(peer: 'desktop' | 'mobile'): number {
    const pending = peer === 'desktop' ? 'desktop-pending' : 'mobile-pending'
    return this.ctx.getWebSockets().filter((socket: WebSocket) => {
      const attachment = this.attachment(socket)
      return attachment?.peer === pending || attachment?.peer === peer
    }).length
  }

  private async metadata(): Promise<PairingMetadata | undefined> {
    const metadata = await this.ctx.storage.get<PairingMetadata>(METADATA_KEY)
    if (metadata === undefined || metadata.version !== PAIRING_PROTOCOL_VERSION) return undefined
    return metadata
  }

  private async liveMetadata(): Promise<PairingMetadata | undefined> {
    const metadata = await this.metadata()
    if (metadata === undefined) return undefined
    if (metadata.expiresAt > Date.now()) return metadata
    this.closePeers('expired')
    await this.ctx.storage.deleteAll()
    return undefined
  }
}
