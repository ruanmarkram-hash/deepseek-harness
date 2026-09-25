/**
 * Dependency-closed FD198 bridge for the owner-facing DSH session surface.
 * It requires a native-attested local carrier and has no endpoint, credential,
 * or process-discovery configuration.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, writeSync } from 'node:fs'
import type { Readable } from 'node:stream'

const MAX_RECORD = 8 * 1024 * 1024
const MAX_METADATA = 16 * 1024
const MAX_CONNECTIONS = 64
const MAX_IDEMPOTENCY = 64
const MAX_DEPTH = 32
const MAX_ITEMS = 1024
const MAX_STRING = 1024 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const METHODS = new Set(['session.list', 'session.create', 'session.history', 'session.prompt'])
const EVENTS = new Set([
  'session/event', 'session/subscribed', 'session/queue', 'session/jobs', 'session/projection',
  'approval/requested', 'approval/resolved', 'question/requested', 'question/resolved',
  'host/session-added', 'host/session-removed', 'host/session-status', 'host/agent-error', 'stream/error',
])

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }
type Result = { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: Json } }
type RequestEnvelope = { readonly version: 3; readonly type: 'request'; readonly connectionEpoch: number; readonly requestId: string; readonly idempotencyKey: string; readonly method: string; readonly payload: Json }
type ApprovalEnvelope = { readonly version: 3; readonly type: 'approval'; readonly connectionEpoch: number; readonly requestId: string; readonly idempotencyKey: string; readonly sessionId: string; readonly approvalId: string; readonly outcome: 'allowed-once' | 'rejected' }
type ClientResponseEnvelope = { readonly version: 3; readonly type: 'client-response'; readonly connectionEpoch: number; readonly requestId: string; readonly idempotencyKey: string; readonly result: Result }
type StreamAckEnvelope = { readonly version: 3; readonly type: 'stream-ack'; readonly connectionEpoch: number; readonly cursor: number }
type Incoming = RequestEnvelope | ApprovalEnvelope | ClientResponseEnvelope | StreamAckEnvelope
type Outgoing = { readonly version: 3; readonly type: 'response'; readonly connectionEpoch: number; readonly requestId: string; readonly result: Result } | { readonly version: 3; readonly type: 'event'; readonly connectionEpoch: number; readonly cursor: number; readonly eventId: string; readonly requestId: string; readonly event: string; readonly payload: Json }

interface NativeRecord { readonly kind: number; readonly metadata: Uint8Array; readonly payload: Uint8Array }
interface NativePort { write(record: NativeRecord): void }
interface Open {
  readonly connectionId: string
  readonly deviceId: string
  readonly enrollmentId: string
  readonly signingPublicKey: string
  readonly agreementPublicKey: string
  readonly routeId: string
  readonly generation: number
  readonly connectionEpoch: number
}
/** A local Host carrier attested by the signed native owner, never by reachability. */
interface AuthenticatedCarrier {
  readonly kind: 'native-attested-private-carrier'
  post(path: '/api/session.list' | '/api/session.create' | '/api/session.history' | '/api/session.prompt' | '/api/respond', body: Json): Promise<Json>
  subscribe(path: '/api/events.mux' | '/api/events.host', onMessage: (body: Json) => void, onEnd: () => void): () => void
}
interface Connection {
  readonly open: Open
  readonly idempotency: Map<string, Promise<Idempotent> | Idempotent>
  unsubscribe: readonly (() => void)[]
  cursor: number
  closed: boolean
}
interface Idempotent { readonly fingerprint: string; readonly result: Result }

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Starts the concrete production composition. It opens no public listener. */
export function startFixedSessionGateway(fd: number): void {
  const port = new DescriptorPort(fd)
  new FixedSessionGateway(port, new UnavailableAuthenticatedCarrier()).start(port.readable)
}

/** Dispatches only the documented FD198 connection records. */
export class FixedSessionGateway {
  private readonly connections = new Map<string, Connection>()
  private pending = Promise.resolve()
  private stopping = false

  /** @param port - Strict FD198 writer. @param carrier - Native-attested local Host carrier. */
  constructor(private readonly port: NativePort, private readonly carrier: AuthenticatedCarrier) {}

  /** Writes runtime.ready and owns the descriptor stream. */
  start(readable: Readable): void {
    this.port.write(emptyRecord(1))
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    readable.on('data', (chunk: Buffer) => {
      if (this.stopping) return
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.byteLength > MAX_RECORD + 4) return this.stop('protocol-rejected')
      try {
        const decoded = decodeRecords(buffer)
        buffer = decoded.rest
        for (const record of decoded.records) this.serial(() => this.receive(record))
      } catch { this.stop('protocol-rejected') }
    })
    readable.once('end', () => this.stop('connection-closed'))
    readable.once('error', () => this.stop('connection-closed'))
  }

  /** Processes one exact FD198 record. Public only for focused sealed-runtime tests. */
  async receive(record: NativeRecord): Promise<void> {
    if (this.stopping) return
    try {
      validateRecord(record)
      switch (record.kind) {
        case 8: this.connectionOpen(record); return
        case 9: await this.connectionFrame(record); return
        case 10: await this.connectionClosed(record); return
        case 13:
          if (record.metadata.byteLength !== 0 || record.payload.byteLength !== 0) throw new Error('host stopping record invalid')
          this.stop('host-stopping')
          return
        default: this.stop('protocol-rejected'); return
      }
    } catch { this.stop('protocol-rejected') }
  }

  private serial(work: () => Promise<void>): void {
    this.pending = this.pending.then(work, work).catch(() => this.stop('protocol-rejected'))
  }

  private connectionOpen(record: NativeRecord): void {
    if (record.payload.byteLength !== 0) return this.stop('protocol-rejected')
    const open = parseOpen(metadata(record.metadata))
    if (this.connections.has(open.connectionId) || this.connections.size >= MAX_CONNECTIONS) return this.stop('protocol-rejected')
    const connection: Connection = { open, idempotency: new Map(), unsubscribe: [], cursor: 0, closed: false }
    const event = (body: Json): void => this.serial(() => this.forwardEvent(connection, body))
    const ended = (): void => { if (!connection.closed) void this.close(connection, 'loopback-failed') }
    connection.unsubscribe = [
      this.carrier.subscribe('/api/events.mux', event, ended),
      this.carrier.subscribe('/api/events.host', event, ended),
    ]
    this.connections.set(open.connectionId, connection)
  }

  private async connectionFrame(record: NativeRecord): Promise<void> {
    const connectionId = exactId(metadata(record.metadata), ['connectionId'], 'connectionId')
    const connection = this.connections.get(connectionId)
    if (connection === undefined || connection.closed) return this.stop('protocol-rejected')
    const envelope = incoming(payload(record.payload))
    if (envelope.connectionEpoch !== connection.open.connectionEpoch) return this.close(connection, 'protocol-rejected')
    if (envelope.type === 'stream-ack') return
    const result = await this.idempotent(connection, envelope.idempotencyKey, JSON.stringify(envelope), async () => {
      switch (envelope.type) {
        case 'request': return this.request(envelope)
        case 'approval': return this.approval(envelope)
        case 'client-response': return this.clientResponse(envelope)
        default: throw new Error('unreachable envelope')
      }
    })
    this.send(connection, { version: 3, type: 'response', connectionEpoch: connection.open.connectionEpoch, requestId: envelope.requestId, result })
  }

  private async connectionClosed(record: NativeRecord): Promise<void> {
    if (record.payload.byteLength !== 0) return this.stop('protocol-rejected')
    const connection = this.connections.get(exactId(metadata(record.metadata), ['connectionId'], 'connectionId'))
    if (connection === undefined) return this.stop('protocol-rejected')
    await this.close(connection, 'connection-closed')
  }

  private async request(value: RequestEnvelope): Promise<Result> {
    try {
      const reply = await this.carrier.post(`/api/${value.method}` as '/api/session.list' | '/api/session.create' | '/api/session.history' | '/api/session.prompt', { type: 'client-request', rpcId: value.requestId, method: value.method, payload: value.payload })
      return serverResponse(reply, value.requestId)
    } catch { return unavailable() }
  }

  private approval(value: ApprovalEnvelope): Promise<Result> {
    return this.respond(value.requestId, { ok: true, value: { sessionId: value.sessionId, approvalId: value.approvalId, outcome: value.outcome } })
  }

  private clientResponse(value: ClientResponseEnvelope): Promise<Result> { return this.respond(value.requestId, value.result) }

  private async respond(requestId: string, result: Result): Promise<Result> {
    try {
      const receipt = await this.carrier.post('/api/respond', { type: 'client-response', rpcId: requestId, result })
      if (!isObject(receipt) || typeof receipt.accepted !== 'boolean' || (Object.keys(receipt).length !== 1 && Object.keys(receipt).length !== 2)) return unavailable()
      return receipt.accepted ? { ok: true, value: { accepted: true } } : { ok: false, error: { code: 'remote-response-refused', message: 'The Host did not accept the pending response', details: {} } }
    } catch { return unavailable() }
  }

  private async forwardEvent(connection: Connection, body: Json): Promise<void> {
    if (connection.closed || !isObject(body) || !exactKeys(body, ['type', 'rpcId', 'method', 'payload']) || body.type !== 'server-request' || typeof body.rpcId !== 'string' || !validId(body.rpcId) || !isObject(body.payload) || typeof body.method !== 'string' || body.method !== body.payload.type || typeof body.payload.type !== 'string' || !EVENTS.has(body.payload.type)) return
    const forwarded = json(body.payload)
    this.send(connection, { version: 3, type: 'event', connectionEpoch: connection.open.connectionEpoch, cursor: ++connection.cursor, eventId: randomUUID(), requestId: body.rpcId, event: body.payload.type, payload: forwarded })
  }

  private async idempotent(connection: Connection, key: string, fingerprint: string, run: () => Promise<Result>): Promise<Result> {
    const prior = connection.idempotency.get(key)
    if (prior !== undefined) {
      const settled = await prior
      return settled.fingerprint === fingerprint ? settled.result : conflict()
    }
    const pending = Promise.resolve().then(run).then(result => ({ fingerprint, result }), () => ({ fingerprint, result: unavailable() }))
    connection.idempotency.set(key, pending)
    const settled = await pending
    connection.idempotency.set(key, settled)
    while (connection.idempotency.size > MAX_IDEMPOTENCY) connection.idempotency.delete(connection.idempotency.keys().next().value as string)
    return settled.result
  }

  private send(connection: Connection, envelope: Outgoing): void {
    if (this.stopping || connection.closed) return
    try {
      const metadata = encoder.encode(JSON.stringify({ connectionId: connection.open.connectionId }))
      const payload = encoder.encode(JSON.stringify(outgoing(envelope)))
      const record = { kind: 11, metadata, payload }
      validateRecord(record)
      this.port.write(record)
    } catch {
      void this.close(connection, 'protocol-rejected')
    }
  }

  private async close(connection: Connection, reason: 'protocol-rejected' | 'connection-closed' | 'host-stopping' | 'loopback-failed'): Promise<void> {
    if (connection.closed) return
    connection.closed = true
    this.connections.delete(connection.open.connectionId)
    for (const unsubscribe of connection.unsubscribe) unsubscribe()
    this.port.write({ kind: 12, metadata: encoder.encode(JSON.stringify({ connectionId: connection.open.connectionId, reason })), payload: new Uint8Array() })
  }

  private stop(reason: 'protocol-rejected' | 'connection-closed' | 'host-stopping'): void {
    if (this.stopping) return
    this.stopping = true
    void Promise.all([...this.connections.values()].map(connection => this.close(connection, reason)))
  }
}

/**
 * Deliberately inert until the signed native owner supplies an authenticated,
 * pinned local carrier. Loopback reachability alone is not authentication.
 */
class UnavailableAuthenticatedCarrier implements AuthenticatedCarrier {
  readonly kind = 'native-attested-private-carrier' as const
  post(_path: '/api/session.list' | '/api/session.create' | '/api/session.history' | '/api/session.prompt' | '/api/respond', _body: Json): Promise<Json> {
    return Promise.reject(new Error('authenticated local Host carrier is unavailable'))
  }

  subscribe(_path: '/api/events.mux' | '/api/events.host', _onMessage: (body: Json) => void, onEnd: () => void): () => void {
    queueMicrotask(onEnd)
    return () => {}
  }
}

/** Native FD198 ownership, with no path lookup. */
class DescriptorPort implements NativePort {
  readonly readable: Readable
  constructor(private readonly fd: number) { this.readable = createReadStream('', { fd, autoClose: false }) }
  write(record: NativeRecord): void { writeSync(this.fd, encodeRecord(record)) }
}

function decodeRecords(buffer: Buffer<ArrayBufferLike>): { readonly records: NativeRecord[]; readonly rest: Buffer<ArrayBufferLike> } {
  const records: NativeRecord[] = []
  let cursor = 0
  while (buffer.byteLength - cursor >= 4) {
    const length = buffer.readUInt32BE(cursor)
    if (length < 3 || length > MAX_RECORD) throw new Error('record length invalid')
    if (buffer.byteLength - cursor < length + 4) break
    const metadataLength = buffer.readUInt16BE(cursor + 5)
    if (metadataLength > MAX_METADATA || metadataLength > length - 3) throw new Error('record metadata invalid')
    const start = cursor + 7
    records.push({ kind: buffer[cursor + 4] as number, metadata: buffer.subarray(start, start + metadataLength), payload: buffer.subarray(start + metadataLength, cursor + length + 4) })
    cursor += length + 4
  }
  return { records, rest: buffer.subarray(cursor) }
}

function encodeRecord(record: NativeRecord): Buffer {
  const output = Buffer.alloc(record.metadata.byteLength + record.payload.byteLength + 7)
  output.writeUInt32BE(output.byteLength - 4, 0)
  output[4] = record.kind
  output.writeUInt16BE(record.metadata.byteLength, 5)
  Buffer.from(record.metadata).copy(output, 7)
  Buffer.from(record.payload).copy(output, 7 + record.metadata.byteLength)
  return output
}

function emptyRecord(kind: number): NativeRecord { return { kind, metadata: new Uint8Array(), payload: new Uint8Array() } }
function validateRecord(record: NativeRecord): void {
  if (!Number.isSafeInteger(record.kind) || record.kind < 1 || record.kind > 15 || record.metadata.byteLength > MAX_METADATA || record.metadata.byteLength + record.payload.byteLength + 3 > MAX_RECORD) throw new Error('native record invalid')
  decoder.decode(record.metadata)
}
function metadata(bytes: Uint8Array): Record<string, unknown> { const value: unknown = JSON.parse(decoder.decode(bytes)); if (!isObject(value)) throw new Error('metadata invalid'); return value }
function payload(bytes: Uint8Array): Json { if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECORD) throw new Error('payload invalid'); return json(JSON.parse(decoder.decode(bytes))) }
function parseOpen(value: Record<string, unknown>): Open {
  if (!exactKeys(value, ['connectionId', 'deviceId', 'enrollmentId', 'signingPublicKey', 'agreementPublicKey', 'routeId', 'generation', 'connectionEpoch'])) throw new Error('open metadata invalid')
  return { connectionId: requiredId(value.connectionId), deviceId: requiredId(value.deviceId), enrollmentId: requiredId(value.enrollmentId), signingPublicKey: key(value.signingPublicKey), agreementPublicKey: key(value.agreementPublicKey), routeId: requiredId(value.routeId), generation: sequence(value.generation), connectionEpoch: sequence(value.connectionEpoch) }
}
function incoming(value: Json): Incoming {
  if (!isObject(value) || value.version !== 3 || typeof value.type !== 'string') throw new Error('envelope invalid')
  if (value.type === 'request') {
    if (!exactKeys(value, ['version', 'type', 'connectionEpoch', 'requestId', 'idempotencyKey', 'method', 'payload']) || typeof value.method !== 'string' || !METHODS.has(value.method)) throw new Error('request invalid')
    return { version: 3, type: 'request', connectionEpoch: sequence(value.connectionEpoch), requestId: requiredId(value.requestId), idempotencyKey: requiredId(value.idempotencyKey), method: value.method, payload: json(value.payload) }
  }
  if (value.type === 'approval') {
    if (!exactKeys(value, ['version', 'type', 'connectionEpoch', 'requestId', 'idempotencyKey', 'sessionId', 'approvalId', 'outcome']) || (value.outcome !== 'allowed-once' && value.outcome !== 'rejected')) throw new Error('approval invalid')
    return { version: 3, type: 'approval', connectionEpoch: sequence(value.connectionEpoch), requestId: requiredId(value.requestId), idempotencyKey: requiredId(value.idempotencyKey), sessionId: requiredId(value.sessionId), approvalId: requiredId(value.approvalId), outcome: value.outcome }
  }
  if (value.type === 'client-response') {
    if (!exactKeys(value, ['version', 'type', 'connectionEpoch', 'requestId', 'idempotencyKey', 'result'])) throw new Error('client response invalid')
    return { version: 3, type: 'client-response', connectionEpoch: sequence(value.connectionEpoch), requestId: requiredId(value.requestId), idempotencyKey: requiredId(value.idempotencyKey), result: result(value.result) }
  }
  if (value.type === 'stream-ack') {
    if (!exactKeys(value, ['version', 'type', 'connectionEpoch', 'cursor'])) throw new Error('acknowledgement invalid')
    return { version: 3, type: 'stream-ack', connectionEpoch: sequence(value.connectionEpoch), cursor: sequence(value.cursor) }
  }
  throw new Error('wrong envelope direction')
}
function outgoing(value: Outgoing): Outgoing {
  if (value.type === 'response') return { version: 3, type: 'response', connectionEpoch: sequence(value.connectionEpoch), requestId: requiredId(value.requestId), result: result(value.result) }
  if (!EVENTS.has(value.event)) throw new Error('event invalid')
  return { version: 3, type: 'event', connectionEpoch: sequence(value.connectionEpoch), cursor: sequence(value.cursor), eventId: requiredId(value.eventId), requestId: requiredId(value.requestId), event: value.event, payload: json(value.payload) }
}
function serverResponse(value: Json, requestId: string): Result { if (!isObject(value) || !exactKeys(value, ['type', 'rpcId', 'result']) || value.type !== 'server-response' || value.rpcId !== requestId) return unavailable(); return result(value.result) }
function result(value: unknown): Result {
  if (!isObject(value) || typeof value.ok !== 'boolean') throw new Error('result invalid')
  if (value.ok) { if (!exactKeys(value, ['ok', 'value'])) throw new Error('result invalid'); return { ok: true, value: json(value.value) } }
  if (!exactKeys(value, ['ok', 'error']) || !isObject(value.error) || !exactKeys(value.error, ['code', 'message', 'details']) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') throw new Error('result invalid')
  return { ok: false, error: { code: string(value.error.code), message: string(value.error.message), details: json(value.error.details) } }
}
function json(value: unknown, depth = 0): Json {
  if (depth > MAX_DEPTH) throw new Error('json depth invalid')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('json number invalid'); return value }
  if (typeof value === 'string') return string(value)
  if (Array.isArray(value)) { if (value.length > MAX_ITEMS) throw new Error('json array invalid'); return value.map(item => json(item, depth + 1)) }
  if (!isObject(value)) throw new Error('json invalid')
  const entries = Object.entries(value)
  if (entries.length > MAX_ITEMS) throw new Error('json object invalid')
  const copy: Record<string, Json> = Object.create(null) as Record<string, Json>
  for (const [name, item] of entries) { if (name === '__proto__' || name === 'constructor' || name === 'prototype') throw new Error('json key invalid'); copy[string(name)] = json(item, depth + 1) }
  if (encoder.encode(JSON.stringify(copy)).byteLength > MAX_RECORD) throw new Error('json oversized')
  return copy
}
function exactId(value: Record<string, unknown>, keys: readonly string[], field: string): string { if (!exactKeys(value, keys)) throw new Error('metadata fields invalid'); return requiredId(value[field]) }
function requiredId(value: unknown): string { if (typeof value !== 'string' || !validId(value)) throw new Error('id invalid'); return value }
function validId(value: string): boolean { return ID.test(value) && encoder.encode(value).byteLength <= MAX_STRING }
function key(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').byteLength !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error('key invalid'); return value }
function sequence(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new Error('sequence invalid'); return value }
function string(value: string): string { if (encoder.encode(value).byteLength > MAX_STRING) throw new Error('string invalid'); return value }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]) }
function unavailable(): Result { return { ok: false, error: { code: 'remote-host-unavailable', message: 'The DSH Host session service is unavailable', details: {} } } }
function conflict(): Result { return { ok: false, error: { code: 'remote-idempotency-conflict', message: 'This retry key belongs to a different remote operation', details: {} } } }
function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
