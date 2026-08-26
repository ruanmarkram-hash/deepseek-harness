/** Fixed inherited-descriptor Remote Wire adapter for the signed Host app. @module @deepseek-ai/dsh-remote-host-v3/remote-wire */

import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RemoteDeviceDirectory, RemoteDeviceId, RemoteDeviceIncarnation, RemoteDeviceRecord } from '@deepseek-ai/dsh-remote-devices'
import { parseRemoteWireJson, serializeRemoteWireEnvelope } from '@deepseek-ai/dsh-remote-wire'
import type { RemoteWireEnvelope } from '@deepseek-ai/dsh-remote-wire'
import type { RemoteGatewayCloseReason, TrustedRemoteConnection, TrustedRemoteSendFence } from '@deepseek-ai/dsh-remote-gateway'
import { RemoteHostV3Error } from './error.ts'
import type { RemoteHostV3EnrollmentReceipt, RemoteHostV3Route, RemoteHostV3RuntimePipe } from './types.ts'

/** The durable route operations consumed by the private-wire provider. */
interface RemoteHostV3RouteAllocator {
  hostEnrollmentId(): Promise<string>
  seedHostEnrollmentId(hostEnrollmentId: string): Promise<string>
  get(deviceId: RemoteDeviceId): RemoteHostV3Route | undefined
  create(input: Omit<RemoteHostV3Route, 'generation' | 'lastConnectionEpoch' | 'pendingConnectionEpoch' | 'createdAt'> & { readonly generation: number }): Promise<RemoteHostV3Route>
  beginConnection(deviceId: RemoteDeviceId): Promise<RemoteHostV3Route>
  commitConnection(deviceId: RemoteDeviceId, epoch: number): Promise<RemoteHostV3Route>
  remove(deviceId: RemoteDeviceId): Promise<RemoteHostV3Route | undefined>
}

/** Descriptor duplicated by the signed DSH Host.app into its verified runtime child. */
export const REMOTE_HOST_V3_PRIVATE_FD = 198
/** Swift `RemoteHostWire.maximumRecordBytes`: record body bytes, excluding its u32 prefix. */
export const REMOTE_HOST_V3_WIRE_MAX_RECORD_BYTES = 8 * 1024 * 1024
/** Swift `RemoteHostWire.maximumMetadataBytes`. */
export const REMOTE_HOST_V3_WIRE_MAX_METADATA_BYTES = 16 * 1024
/** Maximum pending decoded frames for one gateway connection. */
export const REMOTE_HOST_V3_WIRE_MAX_CONNECTION_QUEUE_ITEMS = 32
/** Maximum pending decoded-frame bytes for one gateway connection. */
export const REMOTE_HOST_V3_WIRE_MAX_CONNECTION_QUEUE_BYTES = 8 * 1024 * 1024
/** Maximum raw descriptor chunks retained before the serialized dispatcher consumes them. */
export const REMOTE_HOST_V3_WIRE_MAX_INGRESS_ITEMS = 32
/** Maximum raw descriptor bytes retained before the serialized dispatcher consumes them. */
export const REMOTE_HOST_V3_WIRE_MAX_INGRESS_BYTES = REMOTE_HOST_V3_WIRE_MAX_RECORD_BYTES + 4
/** Maximum complete records dispatched from one raw descriptor chunk. */
export const REMOTE_HOST_V3_WIRE_MAX_RECORDS_PER_INGRESS_CHUNK = 1_024
/** Maximum active or awaiting-close private-wire connections. */
export const REMOTE_HOST_V3_WIRE_MAX_CONNECTIONS = 64
/** Maximum close acknowledgements retained after a local close or overflow. */
export const REMOTE_HOST_V3_WIRE_MAX_CLOSING_TOMBSTONES = 64
/** Maximum records waiting for a slow inherited descriptor write. */
export const REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_ITEMS = 64
/** Maximum encoded bytes waiting for a slow inherited descriptor write. */
export const REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_BYTES = REMOTE_HOST_V3_WIRE_MAX_RECORD_BYTES + 4
const MAX_PENDING_ACCEPTED_CONNECTIONS = 64

const TEXT = new TextEncoder()
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const KEY = /^[A-Za-z0-9_-]{43}$/
const MAX_SEQUENCE = 2_147_483_647
type Bytes = Uint8Array<ArrayBufferLike>
type TrustedSendResult = Awaited<ReturnType<TrustedRemoteConnection['send']>>

type RemoteHostV3WireKind =
  | 'runtime.ready'
  | 'route.upsert'
  | 'route.revoked'
  | 'epoch.begin'
  | 'epoch.begun'
  | 'epoch.commit'
  | 'epoch.committed'
  | 'connection.open'
  | 'connection.frame'
  | 'connection.closed'
  | 'connection.send'
  | 'connection.close'
  | 'host.stopping'
  | 'device.enroll'
  | 'device.enrolled'
  | 'enrollment.seed'

const KINDS: readonly RemoteHostV3WireKind[] = [
  'runtime.ready', 'route.upsert', 'route.revoked', 'epoch.begin', 'epoch.begun', 'epoch.commit', 'epoch.committed',
  'connection.open', 'connection.frame', 'connection.closed', 'connection.send', 'connection.close', 'host.stopping',
  'device.enroll', 'device.enrolled', 'enrollment.seed',
]
const KIND_BY_BYTE = new Map(KINDS.map((kind, index) => [index + 1, kind] as const))
const BYTE_BY_KIND = new Map(KINDS.map((kind, index) => [kind, index + 1] as const))

interface RemoteHostV3WireRecord {
  readonly kind: RemoteHostV3WireKind
  readonly metadata: Bytes
  readonly payload: Bytes
}

interface RouteUpsert {
  readonly routeId: string
  readonly deviceId: RemoteDeviceId
  readonly deviceEnrollmentId: RemoteDeviceIncarnation
  readonly hostDeviceId: string
  readonly hostEnrollmentId: string
  readonly generation: number
}

interface DeviceEnrollment {
  readonly deviceId: RemoteDeviceId
  readonly label: string
  readonly signingPublicKey: string
  readonly agreementPublicKey: string
}

/** Public identity receipt the native Host preserves through a hosted-child respawn. */
interface EnrollmentSeed extends DeviceEnrollment {
  readonly deviceEnrollmentId: RemoteDeviceIncarnation
  readonly hostEnrollmentId: string
}

interface ConnectionOpen {
  readonly connectionId: string
  readonly peer: TrustedRemoteConnection['peer']
  readonly route: TrustedRemoteConnection['route']
}

interface PendingWrite {
  readonly bytes: Bytes
  readonly resolve: () => void
  readonly reject: (error: RemoteHostV3Error) => void
  readonly canCommit?: () => boolean
  settled: boolean
}

/** A pessimistic one-record reservation made before an envelope is serialized. */
interface OutboundReservation {
  readonly bytes: number
  active: boolean
}

interface ClosingTombstone {
  readonly state: 'closed' | 'overflowed'
  readonly lifetime: ConnectionLifetime
  peerClosed: boolean
  localCloseCommitted: boolean
}

/** Immutable connection identity for queued writes, never reactivated when an id is reused. */
interface ConnectionLifetime {
  active: boolean
  pendingSends: number
}

/** A one-way, bounded async queue. Every close is terminal and can carry one non-sensitive error. */
class AsyncQueue<T> {
  private readonly values: Array<{ readonly value: T; readonly bytes: number }> = []
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<T>) => void
    readonly reject: (error: RemoteHostV3Error) => void
  }> = []
  private ended: RemoteHostV3Error | undefined
  private pendingBytes = 0

  /**
   * @param maxItems - Maximum values retained while no consumer is waiting.
   * @param maxBytes - Maximum retained bytes while no consumer is waiting.
   */
  constructor(private readonly maxItems: number, private readonly maxBytes: number) {}

  /** @returns whether this value was accepted without exceeding either bounded queue budget. */
  push(value: T, bytes = 0): boolean {
    if (this.ended !== undefined || !Number.isSafeInteger(bytes) || bytes < 0) return false
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false })
      return true
    }
    if (this.values.length >= this.maxItems || bytes > this.maxBytes - this.pendingBytes) return false
    this.values.push({ value, bytes })
    this.pendingBytes += bytes
    return true
  }

  close(error?: RemoteHostV3Error): void {
    if (this.ended !== undefined) return
    this.ended = error ?? new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Private Remote Wire closed')
    this.values.splice(0)
    this.pendingBytes = 0
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.ended)
  }

  async next(signal?: AbortSignal): Promise<IteratorResult<T>> {
    if (signal?.aborted) return { value: undefined as never, done: true }
    const entry = this.values.shift()
    if (entry !== undefined) {
      this.pendingBytes -= entry.bytes
      return { value: entry.value, done: false }
    }
    if (this.ended !== undefined) throw this.ended
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      const abort = () => {
        const index = this.waiters.findIndex(waiter => waiter.resolve === resolve)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve({ value: undefined as never, done: true })
      }
      const waiter = {
        resolve: (result: IteratorResult<T>) => {
          signal?.removeEventListener('abort', abort)
          resolve(result)
        },
        reject: (error: RemoteHostV3Error) => {
          signal?.removeEventListener('abort', abort)
          reject(error)
        },
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

/** @param value - Candidate strict JSON metadata. @param keys - Exact accepted key names. */
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed('Remote Wire metadata must be an object')
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw malformed('Remote Wire metadata keys are invalid')
  return value as Record<string, unknown>
}

/** @param value - Candidate opaque id. @returns validated id text. */
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw malformed('Remote Wire id is invalid')
  return value
}

/** @param value - Candidate public key. @returns validated canonical base64url key. */
function publicKey(value: unknown): string {
  if (typeof value !== 'string' || !KEY.test(value) || Buffer.from(value, 'base64url').byteLength !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value) {
    throw malformed('Remote Wire public key is invalid')
  }
  return value
}

/** @param value - Candidate local device label. @returns validated visible label. */
function deviceLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw malformed('Remote Wire device label is invalid')
  }
  return value
}

/** @param value - Candidate positive bounded sequence. @returns validated sequence. */
function positiveSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_SEQUENCE) throw malformed('Remote Wire sequence is invalid')
  return value
}

/** @param value - Candidate payload. @returns decoded strict UTF-8 JSON text. */
function payloadText(value: Bytes): string {
  if (value.byteLength > REMOTE_HOST_V3_WIRE_MAX_RECORD_BYTES - 3) throw malformed('Remote Wire payload is oversized')
  try {
    return UTF8.decode(value)
  } catch {
    throw malformed('Remote Wire payload is not UTF-8')
  }
}

/** @param value - Candidate metadata bytes. @returns strict decoded JSON object. */
function metadata(value: Bytes): Record<string, unknown> {
  if (value.byteLength > REMOTE_HOST_V3_WIRE_MAX_METADATA_BYTES) throw malformed('Remote Wire metadata is oversized')
  try {
    return parseFlatMetadata(UTF8.decode(value))
  } catch (error) {
    if (error instanceof RemoteHostV3Error) throw error
    throw malformed('Remote Wire metadata is not strict UTF-8 JSON')
  }
}

/** Parse one JSON string while retaining exact cursor control for duplicate-key rejection. */
function jsonString(source: string, start: number): { readonly value: string; readonly next: number } {
  if (source[start] !== '"') throw malformed('Remote Wire metadata string is invalid')
  let cursor = start + 1
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor)
    if (code < 0x20) throw malformed('Remote Wire metadata string contains a control character')
    if (source[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (source[cursor] === '"') {
      try {
        return { value: JSON.parse(source.slice(start, cursor + 1)) as string, next: cursor + 1 }
      } catch {
        throw malformed('Remote Wire metadata string escape is invalid')
      }
    }
    cursor += 1
  }
  throw malformed('Remote Wire metadata string is unterminated')
}

/** Parse the intentionally flat metadata grammar and reject duplicates, nested values, and non-finite numbers. */
function parseFlatMetadata(source: string): Record<string, unknown> {
  let cursor = 0
  const skip = () => { while (/[ \t\n\r]/.test(source[cursor] ?? '')) cursor += 1 }
  skip()
  if (source[cursor] !== '{') throw malformed('Remote Wire metadata must be an object')
  cursor += 1
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  skip()
  if (source[cursor] === '}') {
    cursor += 1
    skip()
    if (cursor !== source.length) throw malformed('Remote Wire metadata has trailing text')
    return result
  }
  while (true) {
    skip()
    const key = jsonString(source, cursor)
    cursor = key.next
    if (Object.hasOwn(result, key.value)) throw malformed('Remote Wire metadata repeats a key')
    skip()
    if (source[cursor] !== ':') throw malformed('Remote Wire metadata is missing a value separator')
    cursor += 1
    skip()
    let value: string | number
    if (source[cursor] === '"') {
      const parsed = jsonString(source, cursor)
      value = parsed.value
      cursor = parsed.next
    } else {
      const matched = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(cursor))?.[0]
      if (matched === undefined) throw malformed('Remote Wire metadata value is invalid')
      value = Number(matched)
      if (!Number.isFinite(value)) throw malformed('Remote Wire metadata number is invalid')
      cursor += matched.length
    }
    result[key.value] = value
    skip()
    if (source[cursor] === '}') {
      cursor += 1
      skip()
      if (cursor !== source.length) throw malformed('Remote Wire metadata has trailing text')
      return result
    }
    if (source[cursor] !== ',') throw malformed('Remote Wire metadata is missing a field separator')
    cursor += 1
  }
}

/** @param message - Non-sensitive reason. @returns a stable malformed-wire error. */
function malformed(message: string): RemoteHostV3Error {
  return new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_MALFORMED', message)
}

/** @param message - Non-sensitive reason. @returns a stable ordering error. */
function outOfOrder(message: string): RemoteHostV3Error {
  return new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_OUT_OF_ORDER', message)
}

/** Consume one complete fixed record by view, so a dense chunk is never repeatedly copied. */
function consumeOne(buffer: Bytes, offset: number): { readonly record?: RemoteHostV3WireRecord; readonly next: number } {
  const remaining = buffer.byteLength - offset
  if (remaining < 4) return { next: offset }
  const bodyLength = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0)
  if (bodyLength < 3 || bodyLength > REMOTE_HOST_V3_WIRE_MAX_RECORD_BYTES) throw malformed('Remote Wire record length is invalid')
  const total = 4 + bodyLength
  if (remaining < total) return { next: offset }
  const start = offset + 4
  const kind = KIND_BY_BYTE.get(buffer[start] ?? -1)
  if (kind === undefined) throw malformed('Remote Wire kind is invalid')
  const metadataLength = new DataView(buffer.buffer, buffer.byteOffset + start + 1, 2).getUint16(0)
  if (metadataLength > REMOTE_HOST_V3_WIRE_MAX_METADATA_BYTES || metadataLength > bodyLength - 3) throw malformed('Remote Wire metadata length is invalid')
  const metadataStart = start + 3
  const payloadStart = metadataStart + metadataLength
  return {
    record: { kind, metadata: buffer.subarray(metadataStart, payloadStart), payload: buffer.subarray(payloadStart, offset + total) },
    next: offset + total,
  }
}

/**
 * @param kind - Fixed record kind.
 * @param value - JSON metadata.
 * @param payload - Opaque bounded payload.
 * @returns Swift-compatible encoded record.
 */
function encode(
  kind: RemoteHostV3WireKind,
  value: Record<string, unknown> | undefined = undefined,
  payload: Bytes = new Uint8Array(),
): Bytes {
  const metadataBytes = value === undefined ? new Uint8Array() : TEXT.encode(JSON.stringify(value))
  const kindByte = BYTE_BY_KIND.get(kind)
  if (
    kindByte === undefined
    || metadataBytes.byteLength > REMOTE_HOST_V3_WIRE_MAX_METADATA_BYTES
    || payload.byteLength > REMOTE_HOST_V3_WIRE_MAX_RECORD_BYTES - 3 - metadataBytes.byteLength
  ) {
    throw malformed('Remote Wire outbound record is invalid')
  }
  const result = new Uint8Array(7 + metadataBytes.byteLength + payload.byteLength)
  new DataView(result.buffer).setUint32(0, 3 + metadataBytes.byteLength + payload.byteLength)
  result[4] = kindByte
  new DataView(result.buffer).setUint16(5, metadataBytes.byteLength)
  result.set(metadataBytes, 7)
  result.set(payload, 7 + metadataBytes.byteLength)
  return result
}

/** A private pipe connection. It offers only the gateway provider contract, never a raw channel or Host operation surface. */
class InheritedWireConnection implements TrustedRemoteConnection {
  private readonly received = new AsyncQueue<RemoteWireEnvelope>(
    REMOTE_HOST_V3_WIRE_MAX_CONNECTION_QUEUE_ITEMS,
    REMOTE_HOST_V3_WIRE_MAX_CONNECTION_QUEUE_BYTES,
  )
  private state: 'open' | 'overflowed' | 'closed' = 'open'
  readonly lifetime: ConnectionLifetime = { active: true, pendingSends: 0 }

  constructor(
    readonly id: string,
    readonly peer: TrustedRemoteConnection['peer'],
    readonly route: TrustedRemoteConnection['route'],
    private readonly owner: RemoteHostV3InheritedWireProvider,
  ) {}

  async *receive(signal: AbortSignal): AsyncIterable<RemoteWireEnvelope> {
    while (true) {
      const item = await this.received.next(signal)
      if (item.done) return
      yield item.value
    }
  }

  async send(envelope: RemoteWireEnvelope, fence: TrustedRemoteSendFence): Promise<TrustedSendResult> {
    if (this.state !== 'open' || !fence.active || fence.abortSignal.aborted) return { status: 'not-committed' }
    let reservation: OutboundReservation | undefined
    try {
      reservation = this.owner.reserveConnectionSend()
      const payload = TEXT.encode(serializeRemoteWireEnvelope(envelope))
      await this.owner.writeConnectionSend(this.id, payload, fence, reservation, this.lifetime)
      return this.state === 'open' && fence.active && !fence.abortSignal.aborted ? { status: 'committed-before-fence' } : { status: 'not-committed' }
    } catch {
      return { status: 'not-committed' }
    } finally {
      if (reservation !== undefined) this.owner.releaseOutboundReservation(reservation)
    }
  }

  async close(reason: RemoteGatewayCloseReason): Promise<void> {
    if (this.state !== 'open') return
    this.state = 'closed'
    this.lifetime.active = false
    this.owner.retireConnection(this.id, 'closed', this.lifetime)
    try {
      await this.owner.writeConnectionClose(this.id, reason)
      this.owner.markLocalCloseCommitted(this.id)
    } finally {
      this.received.close()
    }
  }

  frame(envelope: RemoteWireEnvelope, bytes: number): 'accepted' | 'overflow' | 'closed' {
    if (this.state !== 'open') return 'closed'
    return this.received.push(envelope, bytes) ? 'accepted' : 'overflow'
  }

  /** Abort this one remote connection when its bounded inbound queue overflows. */
  async overflow(): Promise<void> {
    if (this.state !== 'open') return
    this.state = 'overflowed'
    this.lifetime.active = false
    this.received.close(new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_OVERFLOW', 'Remote Wire connection receive queue overflowed'))
    this.owner.retireConnection(this.id, 'overflowed', this.lifetime)
    try {
      await this.owner.writeConnectionClose(this.id, 'protocol-rejected')
      this.owner.markLocalCloseCommitted(this.id)
    } catch {
      // A private-pipe write failure already closes every connection.
    }
  }

  ended(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.lifetime.active = false
    this.received.close()
  }

}

/**
 * Strict adapter over the one descriptor inherited from the signed Host app.
 * It has no `connect`, listener, request, key, token, or generic message API.
 */
export class RemoteHostV3InheritedWireProvider implements RemoteHostV3RuntimePipe {
  readonly kind = 'inherited-private-pipe' as const
  private readonly accepted = new AsyncQueue<TrustedRemoteConnection>(MAX_PENDING_ACCEPTED_CONNECTIONS, 0)
  private readonly connections = new Map<string, InheritedWireConnection>()
  private readonly closingTombstones = new Map<string, ClosingTombstone>()
  private buffer: Bytes = new Uint8Array()
  private readonly ingress: Bytes[] = []
  private ingressBytes = 0
  private ingressItems = 0
  private drainingIngress = false
  private ingressTerminal: RemoteHostV3Error | undefined
  private started = false
  private closed = false
  private terminal: RemoteHostV3Error | undefined
  private readonly outbound: PendingWrite[] = []
  private readonly outboundReservations = new Set<OutboundReservation>()
  private reservedOutboundBytes = 0
  private outboundBytes = 0
  private outboundItems = 0
  private drainingOutbound = false
  private currentOutbound: PendingWrite | undefined
  private seeded = false

  /**
   * @param channel - Already-inherited connected descriptor, supplied only by the verified runtime bootstrap.
   * @param allocator - Durable public route and epoch owner.
   */
  constructor(
    private readonly channel: Duplex,
    private readonly allocator: RemoteHostV3RouteAllocator,
    private readonly devices: RemoteDeviceDirectory | undefined = undefined,
    private readonly requireEnrollmentSeed = false,
  ) {}

  async *accept(signal: AbortSignal): AsyncIterable<TrustedRemoteConnection> {
    await this.start()
    const abort = () => this.shutdown(new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Gateway stopped the private Remote Wire'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        const item = await this.accepted.next(signal)
        if (item.done) return
        yield item.value
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  /**
   * Queues one bounded send while its fence and connection lifetime remain active.
   * @internal
   * @param connectionId - Private-wire connection identifier.
   * @param payload - Serialized remote-wire envelope bytes.
   * @param fence - Gateway-owned local send fence.
   * @param reservation - Reserved outbound capacity consumed by this write.
   * @param lifetime - Current connection lifetime used to prevent ID reuse.
   */
  async writeConnectionSend(
    connectionId: string,
    payload: Bytes,
    fence: TrustedRemoteSendFence,
    reservation: OutboundReservation,
    lifetime: ConnectionLifetime,
  ): Promise<void> {
    if (!fence.active || fence.abortSignal.aborted) throw new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Connection send fence is inactive')
    lifetime.pendingSends += 1
    try {
      await this.write('connection.send', { connectionId }, payload, reservation, () => lifetime.active && fence.active && !fence.abortSignal.aborted)
      if (!lifetime.active || !fence.active || fence.abortSignal.aborted) throw new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Connection send fence changed before private-pipe commit')
    } finally {
      lifetime.pendingSends -= 1
      this.reapTombstone(connectionId, lifetime)
    }
  }

  /**
   * Emits a bounded close record with no arbitrary payload.
   * @internal
   * @param connectionId - Private-wire connection identifier.
   * @param reason - Stable gateway close reason.
   */
  async writeConnectionClose(connectionId: string, reason: RemoteGatewayCloseReason): Promise<void> {
    await this.write('connection.close', { connectionId, reason })
  }

  /**
   * Reserves one worst-case record before user-controlled envelope serialization.
   * @internal
   * @returns the active reservation that a send must consume or release.
   */
  reserveConnectionSend(): OutboundReservation {
    if (this.closed) throw this.terminal ?? new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Private Remote Wire is closed')
    const bytes = REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_BYTES - this.outboundBytes - this.reservedOutboundBytes
    if (this.outboundItems + this.outboundReservations.size >= REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_ITEMS || bytes <= 0) {
      const failure = new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_OVERFLOW', 'Private Remote Wire outbound queue overflowed')
      this.shutdown(failure)
      throw failure
    }
    const reservation: OutboundReservation = { bytes, active: true }
    this.outboundReservations.add(reservation)
    this.reservedOutboundBytes += bytes
    return reservation
  }

  /**
   * Releases a reservation that serialization or enqueueing did not consume.
   * @internal
   * @param reservation - Active outbound capacity reservation.
   */
  releaseOutboundReservation(reservation: OutboundReservation): void {
    if (!reservation.active) return
    reservation.active = false
    if (this.outboundReservations.delete(reservation)) this.reservedOutboundBytes -= reservation.bytes
  }

  private async start(): Promise<void> {
    if (this.closed) throw this.terminal ?? new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Private Remote Wire is closed')
    if (this.started) return
    this.started = true
    this.channel.on('data', this.onData)
    this.channel.once('end', this.onEnd)
    this.channel.once('error', this.onError)
    this.channel.once('close', this.onClose)
    try {
      await this.write('runtime.ready')
    } catch (error) {
      const failure = error instanceof RemoteHostV3Error ? error : new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_WRITE_FAILED', 'Could not initialize private Remote Wire')
      this.shutdown(failure)
      throw failure
    }
  }

  private readonly onData = (chunk: Uint8Array): void => {
    if (this.closed) return
    const chunkBytes = chunk.byteLength
    const bufferedItems = this.buffer.byteLength === 0 ? 0 : 1
    if (this.ingressTerminal !== undefined || this.ingressItems + bufferedItems >= REMOTE_HOST_V3_WIRE_MAX_INGRESS_ITEMS
      || chunkBytes > REMOTE_HOST_V3_WIRE_MAX_INGRESS_BYTES - this.buffer.byteLength - this.ingressBytes) {
      this.shutdown(new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_OVERFLOW', 'Private Remote Wire ingress queue overflowed'))
      return
    }
    const bytes = new Uint8Array(chunkBytes)
    bytes.set(chunk)
    this.ingress.push(bytes)
    this.ingressBytes += bytes.byteLength
    this.ingressItems += 1
    if (!this.drainingIngress) void this.drainIngress()
  }

  private readonly onEnd = (): void => this.endIngress(new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Private Remote Wire reached EOF'))
  private readonly onError = (): void => this.endIngress(new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Private Remote Wire failed'))
  private readonly onClose = (): void => this.endIngress(new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Private Remote Wire closed'))

  /** Drain at most one bounded raw chunk at a time, never retaining one closure per descriptor event. */
  private async drainIngress(): Promise<void> {
    if (this.drainingIngress || this.closed) return
    this.drainingIngress = true
    try {
      while (!this.closed) {
        const bytes = this.ingress.shift()
        if (bytes === undefined) break
        try {
          const joined = this.buffer.byteLength === 0 ? bytes : (() => {
            const value = new Uint8Array(this.buffer.byteLength + bytes.byteLength)
            value.set(this.buffer)
            value.set(bytes, this.buffer.byteLength)
            return value
          })()
          let offset = 0
          let records = 0
          while (true) {
            const decoded = consumeOne(joined, offset)
            if (decoded.record === undefined) break
            if (records >= REMOTE_HOST_V3_WIRE_MAX_RECORDS_PER_INGRESS_CHUNK) {
              throw new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_OVERFLOW', 'Private Remote Wire raw chunk contains too many records')
            }
            offset = decoded.next
            records += 1
            await this.handle(decoded.record)
            if (this.closed) return
          }
          this.buffer = offset === joined.byteLength ? new Uint8Array() : joined.slice(offset)
        } finally {
          this.ingressBytes -= bytes.byteLength
          this.ingressItems -= 1
        }
      }
      if (this.ingressTerminal !== undefined) {
        if (this.buffer.byteLength !== 0) throw malformed('Private Remote Wire ended with a partial record')
        this.shutdown(this.ingressTerminal)
      }
    } catch (error) {
      this.shutdown(error instanceof RemoteHostV3Error ? error : malformed('Private Remote Wire handler failed'))
    } finally {
      this.drainingIngress = false
      if (!this.closed && this.ingress.length > 0) void this.drainIngress()
    }
  }

  /** Remember terminal descriptor state until every already-received bounded raw chunk is consumed. */
  private endIngress(error: RemoteHostV3Error): void {
    if (this.closed || this.ingressTerminal !== undefined) return
    this.ingressTerminal = error
    if (!this.drainingIngress) void this.drainIngress()
  }

  private async handle(record: RemoteHostV3WireRecord): Promise<void> {
    switch (record.kind) {
      case 'route.upsert': return this.routeUpsert(record)
      case 'route.revoked': return this.routeRevoked(record)
      case 'epoch.begin': return this.epochBegin(record)
      case 'epoch.commit': return this.epochCommit(record)
      case 'connection.open': return this.connectionOpen(record)
      case 'connection.frame': return this.connectionFrame(record)
      case 'connection.closed': return this.connectionClosed(record)
      case 'host.stopping': return this.hostStopping(record)
      case 'enrollment.seed': return this.enrollmentSeed(record)
      case 'device.enroll': return this.deviceEnroll(record)
      case 'runtime.ready':
      case 'epoch.begun':
      case 'epoch.committed':
      case 'connection.send':
      case 'connection.close':
      case 'device.enrolled':
        throw outOfOrder(`Remote Wire kind ${record.kind} has the wrong direction`)
      default:
        record.kind satisfies never
        throw malformed('Remote Wire kind is invalid')
    }
  }

  private async routeUpsert(record: RemoteHostV3WireRecord): Promise<void> {
    this.requireSeed(record)
    this.emptyPayload(record)
    const value = exactObject(metadata(record.metadata), ['routeId', 'deviceId', 'deviceEnrollmentId', 'hostDeviceId', 'hostEnrollmentId', 'generation'])
    const route: RouteUpsert = {
      routeId: identifier(value.routeId),
      deviceId: identifier(value.deviceId) as RemoteDeviceId,
      deviceEnrollmentId: identifier(value.deviceEnrollmentId) as RemoteDeviceIncarnation,
      hostDeviceId: identifier(value.hostDeviceId),
      hostEnrollmentId: identifier(value.hostEnrollmentId),
      generation: positiveSequence(value.generation),
    }
    const existing = this.allocator.get(route.deviceId)
    if (existing !== undefined) {
      if (
        existing.routeId !== route.routeId
        || existing.deviceEnrollmentId !== route.deviceEnrollmentId
        || existing.hostDeviceId !== route.hostDeviceId
        || existing.hostEnrollmentId !== route.hostEnrollmentId
        || existing.generation !== route.generation
      ) {
        throw outOfOrder('Remote Wire route upsert conflicts with durable route')
      }
      return
    }
    await this.allocator.create(route)
  }

  /** Persist an explicitly locally-confirmed public device tuple and return only public enrollment facts. */
  private async deviceEnroll(record: RemoteHostV3WireRecord): Promise<void> {
    this.requireSeed(record)
    this.emptyPayload(record)
    const value = exactObject(metadata(record.metadata), ['deviceId', 'label', 'signingPublicKey', 'agreementPublicKey'])
    const input: DeviceEnrollment = {
      deviceId: identifier(value.deviceId) as RemoteDeviceId,
      label: deviceLabel(value.label),
      signingPublicKey: publicKey(value.signingPublicKey),
      agreementPublicKey: publicKey(value.agreementPublicKey),
    }
    const devices = this.devices
    if (devices === undefined) throw new RemoteHostV3Error('REMOTE_HOST_V3_HELPER_UNAVAILABLE', 'Private Remote Wire has no trusted device directory')
    const existing = devices.get(input.deviceId)
    const device = existing === undefined
      ? await devices.enroll({
        id: input.deviceId,
        label: input.label,
        signingPublicKey: input.signingPublicKey,
        agreementPublicKey: input.agreementPublicKey,
      })
      : this.exactEnrolledDevice(existing, input)
    const hostEnrollmentId = await this.allocator.hostEnrollmentId()
    const receipt: RemoteHostV3EnrollmentReceipt = {
      deviceId: device.id,
      label: device.label,
      signingPublicKey: device.signingPublicKey,
      agreementPublicKey: device.agreementPublicKey,
      deviceEnrollmentId: device.incarnation,
      hostEnrollmentId,
    }
    await this.write('device.enrolled', { ...receipt })
  }

  /** Preserve the native Host's already-confirmed public enrollment tuple before any route traffic. */
  private async enrollmentSeed(record: RemoteHostV3WireRecord): Promise<void> {
    this.emptyPayload(record)
    if (this.seeded) throw outOfOrder('Remote Wire enrollment seed was replayed')
    const value = exactObject(metadata(record.metadata), [
      'deviceId', 'label', 'signingPublicKey', 'agreementPublicKey', 'deviceEnrollmentId', 'hostEnrollmentId',
    ])
    const seed: EnrollmentSeed = {
      deviceId: identifier(value.deviceId) as RemoteDeviceId,
      label: deviceLabel(value.label),
      signingPublicKey: publicKey(value.signingPublicKey),
      agreementPublicKey: publicKey(value.agreementPublicKey),
      deviceEnrollmentId: identifier(value.deviceEnrollmentId) as RemoteDeviceIncarnation,
      hostEnrollmentId: identifier(value.hostEnrollmentId),
    }
    const devices = this.devices
    if (devices === undefined) throw new RemoteHostV3Error('REMOTE_HOST_V3_HELPER_UNAVAILABLE', 'Private Remote Wire has no trusted device directory')
    await devices.seed({
      id: seed.deviceId,
      label: seed.label,
      signingPublicKey: seed.signingPublicKey,
      agreementPublicKey: seed.agreementPublicKey,
    }, seed.deviceEnrollmentId)
    await this.allocator.seedHostEnrollmentId(seed.hostEnrollmentId)
    this.seeded = true
  }

  /** Hosted FD199 children require a confirmed identity seed before accepting device or route writes. */
  private requireSeed(record: RemoteHostV3WireRecord): void {
    if (this.requireEnrollmentSeed && !this.seeded) {
      throw outOfOrder(`Remote Wire ${record.kind} arrived before the confirmed enrollment seed`)
    }
  }

  /** Reject a retry that changes any part of an already enrolled public tuple. */
  private exactEnrolledDevice(existing: RemoteDeviceRecord, input: DeviceEnrollment): RemoteDeviceRecord {
    if (
      existing.label !== input.label
      || existing.signingPublicKey !== input.signingPublicKey
      || existing.agreementPublicKey !== input.agreementPublicKey
    ) {
      throw outOfOrder('Remote Wire device enrollment conflicts with a durable device')
    }
    return existing
  }

  private async routeRevoked(record: RemoteHostV3WireRecord): Promise<void> {
    this.emptyPayload(record)
    const value = exactObject(metadata(record.metadata), ['deviceId'])
    const deviceId = identifier(value.deviceId) as RemoteDeviceId
    // Invalidate every matching lifetime before awaiting durable work, so queued sends cannot overtake revocation.
    const closes = [...this.connections.values()]
      .filter(connection => connection.peer.deviceId === deviceId)
      .map(connection => connection.close('transport-failed'))
    await this.allocator.remove(deviceId)
    await Promise.all(closes)
  }

  private async epochBegin(record: RemoteHostV3WireRecord): Promise<void> {
    this.emptyPayload(record)
    const value = exactObject(metadata(record.metadata), ['deviceId'])
    const route = await this.allocator.beginConnection(identifier(value.deviceId) as RemoteDeviceId)
    if (route.pendingConnectionEpoch === undefined) throw outOfOrder('Remote Wire epoch begin did not reserve an epoch')
    await this.write('epoch.begun', this.epochMetadata(route, route.pendingConnectionEpoch))
  }

  private async epochCommit(record: RemoteHostV3WireRecord): Promise<void> {
    this.emptyPayload(record)
    const value = exactObject(metadata(record.metadata), ['deviceId', 'connectionEpoch'])
    const route = await this.allocator.commitConnection(
      identifier(value.deviceId) as RemoteDeviceId,
      positiveSequence(value.connectionEpoch),
    )
    await this.write('epoch.committed', this.epochMetadata(route, route.lastConnectionEpoch))
  }

  private async connectionOpen(record: RemoteHostV3WireRecord): Promise<void> {
    this.emptyPayload(record)
    const value = exactObject(metadata(record.metadata), [
      'connectionId', 'deviceId', 'enrollmentId', 'signingPublicKey',
      'agreementPublicKey', 'routeId', 'generation', 'connectionEpoch',
    ])
    const opened: ConnectionOpen = {
      connectionId: identifier(value.connectionId),
      peer: {
        deviceId: identifier(value.deviceId) as RemoteDeviceId,
        enrollmentId: identifier(value.enrollmentId) as RemoteDeviceIncarnation,
        signingPublicKey: publicKey(value.signingPublicKey),
        agreementPublicKey: publicKey(value.agreementPublicKey),
      },
      route: {
        routeId: identifier(value.routeId),
        generation: positiveSequence(value.generation),
        connectionEpoch: positiveSequence(value.connectionEpoch),
      },
    }
    if (this.connections.has(opened.connectionId) || this.closingTombstones.has(opened.connectionId)) {
      throw outOfOrder('Remote Wire connection id is already open')
    }
    if (this.connections.size >= REMOTE_HOST_V3_WIRE_MAX_CONNECTIONS) {
      throw new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_OVERFLOW', 'Private Remote Wire has too many open connections')
    }
    const durable = this.allocator.get(opened.peer.deviceId)
    if (
      durable === undefined
      || durable.routeId !== opened.route.routeId
      || durable.deviceEnrollmentId !== opened.peer.enrollmentId
      || durable.generation !== opened.route.generation
      || durable.pendingConnectionEpoch !== undefined
      || durable.lastConnectionEpoch !== opened.route.connectionEpoch
    ) {
      throw outOfOrder('Remote Wire connection open does not match a committed durable epoch')
    }
    const connection = new InheritedWireConnection(opened.connectionId, opened.peer, opened.route, this)
    this.connections.set(opened.connectionId, connection)
    if (!this.accepted.push(connection)) await connection.overflow()
  }

  private async connectionFrame(record: RemoteHostV3WireRecord): Promise<void> {
    const value = exactObject(metadata(record.metadata), ['connectionId'])
    const id = identifier(value.connectionId)
    const connection = this.connections.get(id)
    if (connection === undefined) {
      if (this.closingTombstones.has(id)) return
      throw outOfOrder('Remote Wire frame has no open connection')
    }
    const envelope = parseRemoteWireJson(payloadText(record.payload))
    if (envelope.connectionEpoch !== connection.route.connectionEpoch) throw outOfOrder('Remote Wire frame epoch does not match its open connection')
    const accepted = connection.frame(envelope, record.payload.byteLength)
    if (accepted === 'closed') throw outOfOrder('Remote Wire frame arrived after connection close')
    if (accepted === 'overflow') await connection.overflow()
  }

  private connectionClosed(record: RemoteHostV3WireRecord): void {
    this.emptyPayload(record)
    const value = exactObject(metadata(record.metadata), ['connectionId'])
    const id = identifier(value.connectionId)
    const connection = this.connections.get(id)
    if (connection === undefined) {
      if (this.acknowledgeConnectionClose(id)) return
      throw outOfOrder('Remote Wire close has no open connection')
    }
    connection.ended()
    this.retirePeerClosed(id, connection.lifetime)
  }

  /**
   * Retains a bounded acknowledgement marker after local connection termination.
   * @internal
   * @param id - Terminated private-wire connection identifier.
   * @param state - Local terminal state retained for acknowledgement.
   * @param lifetime - Terminated lifetime whose queued sends must settle before reuse.
   */
  retireConnection(id: string, state: 'closed' | 'overflowed', lifetime: ConnectionLifetime): void {
    this.connections.delete(id)
    if (this.closed) return
    const existing = this.closingTombstones.get(id)
    if (existing !== undefined) return
    if (this.closingTombstones.size >= REMOTE_HOST_V3_WIRE_MAX_CLOSING_TOMBSTONES) {
      this.shutdown(new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_OVERFLOW', 'Private Remote Wire has too many unacknowledged connection closes'))
      return
    }
    this.closingTombstones.set(id, { state, lifetime, peerClosed: false, localCloseCommitted: false })
  }

  /**
   * Marks a local close write committed without permitting premature ID reuse.
   * @internal
   * @param id - Closing private-wire connection identifier.
   */
  markLocalCloseCommitted(id: string): void {
    const tombstone = this.closingTombstones.get(id)
    if (tombstone === undefined) return
    tombstone.localCloseCommitted = true
    this.reapTombstone(id, tombstone.lifetime)
  }

  private acknowledgeConnectionClose(id: string): boolean {
    const tombstone = this.closingTombstones.get(id)
    if (tombstone === undefined) return false
    tombstone.peerClosed = true
    this.reapTombstone(id, tombstone.lifetime)
    return true
  }

  /** Hold a peer-closed id until all old-lifetime queued sends have settled. */
  private retirePeerClosed(id: string, lifetime: ConnectionLifetime): void {
    this.connections.delete(id)
    const tombstone = this.closingTombstones.get(id)
    if (tombstone !== undefined) {
      tombstone.peerClosed = true
      this.reapTombstone(id, tombstone.lifetime)
      return
    }
    if (lifetime.pendingSends === 0 || this.closed) return
    if (this.closingTombstones.size >= REMOTE_HOST_V3_WIRE_MAX_CLOSING_TOMBSTONES) {
      this.shutdown(new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_OVERFLOW', 'Private Remote Wire has too many stale connection sends'))
      return
    }
    this.closingTombstones.set(id, { state: 'closed', lifetime, peerClosed: true, localCloseCommitted: true })
  }

  private reapTombstone(id: string, lifetime: ConnectionLifetime): void {
    const tombstone = this.closingTombstones.get(id)
    if (
      tombstone !== undefined
      && tombstone.lifetime === lifetime
      && tombstone.peerClosed
      && tombstone.localCloseCommitted
      && lifetime.pendingSends === 0
    ) {
      this.closingTombstones.delete(id)
    }
  }

  private hostStopping(record: RemoteHostV3WireRecord): void {
    this.emptyPayload(record)
    if (record.metadata.byteLength !== 0) throw malformed('Remote Wire host stopping metadata must be empty')
    this.shutdown(new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Signed Host app is stopping'))
  }

  private emptyPayload(record: RemoteHostV3WireRecord): void {
    if (record.payload.byteLength !== 0) throw malformed(`Remote Wire ${record.kind} payload must be empty`)
  }

  private epochMetadata(route: RemoteHostV3Route, connectionEpoch: number): Record<string, unknown> {
    return { deviceId: route.deviceId, routeId: route.routeId, generation: route.generation, connectionEpoch }
  }

  private async write(
    kind: RemoteHostV3WireKind,
    value?: Record<string, unknown>,
    payload?: Bytes,
    reservation?: OutboundReservation,
    canCommit?: () => boolean,
  ): Promise<void> {
    if (this.closed) throw this.terminal ?? new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Private Remote Wire is closed')
    const encoded = encode(kind, value, payload)
    const reservedItems = this.outboundReservations.size - (reservation?.active ? 1 : 0)
    const reservedBytes = this.reservedOutboundBytes - (reservation?.active ? reservation.bytes : 0)
    if (reservation !== undefined && (!reservation.active || !this.outboundReservations.has(reservation))) {
      throw new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Private Remote Wire outbound reservation is unavailable')
    }
    if (this.outboundItems + reservedItems >= REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_ITEMS
      || encoded.byteLength > REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_BYTES - this.outboundBytes - reservedBytes) {
      const failure = new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_OVERFLOW', 'Private Remote Wire outbound queue overflowed')
      this.shutdown(failure)
      throw failure
    }
    if (reservation !== undefined) this.releaseOutboundReservation(reservation)
    return new Promise<void>((resolve, reject) => {
      this.outbound.push({ bytes: encoded, resolve, reject, ...(canCommit === undefined ? {} : { canCommit }), settled: false })
      this.outboundItems += 1
      this.outboundBytes += encoded.byteLength
      if (!this.drainingOutbound) void this.drainOutbound()
    })
  }

  /** Serialize bounded writes without a promise chain that retains arbitrary records. */
  private async drainOutbound(): Promise<void> {
    if (this.drainingOutbound || this.closed) return
    this.drainingOutbound = true
    try {
      while (!this.closed) {
        const pending = this.outbound.shift()
        if (pending === undefined) break
        this.currentOutbound = pending
        if (pending.canCommit !== undefined && !pending.canCommit()) {
          this.currentOutbound = undefined
          this.outboundItems -= 1
          this.outboundBytes -= pending.bytes.byteLength
          pending.settled = true
          pending.reject(new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_CLOSED', 'Connection send lifetime ended before private-pipe commit'))
          continue
        }
        try {
          await new Promise<void>((resolve, reject) => {
            this.channel.write(pending.bytes, error => error == null ? resolve() : reject(error))
          })
        } catch {
          const failure = new RemoteHostV3Error('REMOTE_HOST_V3_WIRE_WRITE_FAILED', 'Could not write the private Remote Wire')
          this.shutdown(failure)
          return
        }
        if (this.currentOutbound === pending) {
          this.currentOutbound = undefined
          this.outboundItems -= 1
          this.outboundBytes -= pending.bytes.byteLength
          pending.settled = true
          pending.resolve()
        }
      }
    } finally {
      this.drainingOutbound = false
      if (!this.closed && this.outbound.length > 0) void this.drainOutbound()
    }
  }

  private rejectOutbound(error: RemoteHostV3Error): void {
    const pending = [this.currentOutbound, ...this.outbound.splice(0)].filter((value): value is PendingWrite => value !== undefined)
    this.currentOutbound = undefined
    this.outboundItems = 0
    this.outboundBytes = 0
    for (const item of pending) {
      if (!item.settled) {
        item.settled = true
        item.reject(error)
      }
    }
  }

  private shutdown(error: RemoteHostV3Error): void {
    if (this.closed) return
    this.closed = true
    this.terminal = error
    this.channel.off('data', this.onData)
    this.channel.off('end', this.onEnd)
    this.channel.off('error', this.onError)
    this.channel.off('close', this.onClose)
    this.buffer = new Uint8Array()
    this.ingress.splice(0)
    this.ingressBytes = 0
    this.ingressItems = 0
    for (const reservation of this.outboundReservations) reservation.active = false
    this.outboundReservations.clear()
    this.reservedOutboundBytes = 0
    this.rejectOutbound(error)
    for (const connection of this.connections.values()) connection.ended()
    this.connections.clear()
    this.closingTombstones.clear()
    this.accepted.close(error)
    this.channel.destroy()
  }
}

/**
 * Create the only production pipe source: the fixed descriptor inherited from the signed Host.app bootstrap.
 * @param allocator - Durable public route and connection-epoch allocator.
 * @param devices - Durable trusted-device directory used to validate native connection facts.
 * @param requireEnrollmentSeed - Whether readiness requires the native Host enrollment seed first.
 * @returns the authenticated connection pipe backed by the inherited descriptor.
 */
export function createRemoteHostV3InheritedWireProvider(
  allocator: RemoteHostV3RouteAllocator,
  devices: RemoteDeviceDirectory,
  requireEnrollmentSeed = false,
): RemoteHostV3RuntimePipe {
  const channel = new Socket({ fd: REMOTE_HOST_V3_PRIVATE_FD, readable: true, writable: true })
  channel.unref()
  return new RemoteHostV3InheritedWireProvider(channel, allocator, devices, requireEnrollmentSeed)
}
