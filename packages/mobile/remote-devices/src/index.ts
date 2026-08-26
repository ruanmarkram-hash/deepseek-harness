/**
 * Host-owned durable directory of devices trusted to act as remote DSH owners.
 * Device enrollment is a local Host action; this package exposes no network
 * listener, relay token, private key, or remote enrollment endpoint.
 * @module @deepseek-ai/dsh-remote-devices
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { RemoteDeviceDirectoryError } from './error.ts'
import type {
  RemoteDeviceChange,
  RemoteDeviceDirectoryErrorCode,
  RemoteDeviceEnrollment,
  RemoteDeviceIncarnation,
  RemoteDeviceId,
  RemoteDeviceRecord,
} from './types.ts'

export { RemoteDeviceDirectoryError, isRemoteDeviceDirectoryError } from './error.ts'
export type {
  RemoteDeviceChange,
  RemoteDeviceDirectoryErrorCode,
  RemoteDeviceEnrollment,
  RemoteDeviceIncarnation,
  RemoteDeviceId,
  RemoteDeviceRecord,
} from './types.ts'

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** @param value - Candidate base64url public key. @returns whether it is one canonical 32-byte public key. */
function canonicalPublicKey(value: string): boolean {
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength === 32 && decoded.toString('base64url') === value
}

const storedRecordSchema = z.object({
  id: z.string().regex(DEVICE_ID),
  incarnation: z.string().regex(DEVICE_ID),
  label: z.string().min(1).max(64).refine(value => value === value.trim() && !CONTROL.test(value)),
  signingPublicKey: z.string().regex(PUBLIC_KEY).refine(canonicalPublicKey),
  agreementPublicKey: z.string().regex(PUBLIC_KEY).refine(canonicalPublicKey),
  enrolledAt: z.string(),
  lastSeenAt: z.string().optional(),
}).strict().superRefine((value, context) => {
  const enrolledAt = canonicalInstantMilliseconds(value.enrolledAt)
  if (enrolledAt === undefined) {
    context.addIssue({ code: 'custom', message: 'enrolledAt must be a canonical ISO-8601 instant', path: ['enrolledAt'] })
  }
  const lastSeenAt = value.lastSeenAt === undefined ? undefined : canonicalInstantMilliseconds(value.lastSeenAt)
  if (value.lastSeenAt !== undefined && lastSeenAt === undefined) {
    context.addIssue({ code: 'custom', message: 'lastSeenAt must be a canonical ISO-8601 instant', path: ['lastSeenAt'] })
  }
  if (lastSeenAt !== undefined && enrolledAt !== undefined && lastSeenAt < enrolledAt) {
    context.addIssue({ code: 'custom', message: 'lastSeenAt must not predate enrolledAt', path: ['lastSeenAt'] })
  }
  if (value.signingPublicKey === value.agreementPublicKey) {
    context.addIssue({ code: 'custom', message: 'signing and agreement keys must differ', path: ['agreementPublicKey'] })
  }
})

type StoredRemoteDeviceRecord = z.infer<typeof storedRecordSchema>

/** Durable public-metadata layout for Host-trusted remote devices. */
export const REMOTE_DEVICE_DOMAIN = defineDomain({
  name: 'remote_devices',
  version: 1,
  tables: {
    devices: domainTable<RemoteDeviceId, StoredRemoteDeviceRecord>(storedRecordSchema),
  },
})

/** Name of the durable Host storage unit containing device public metadata. */
export const REMOTE_DEVICE_DOMAIN_NAME = REMOTE_DEVICE_DOMAIN.name

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned directory of locally trusted remote device identities. */
    remoteDevices: RemoteDeviceDirectory
  }

  interface Events {
    /**
     * A trusted device was durably enrolled, seen, or revoked. The event
     * contains public metadata only and fires after the durable mutation.
     * @param change - Post-durability device-directory change.
     */
    'remote-devices/changed'(change: RemoteDeviceChange): void
  }
}

/** Cordis plugin name. */
export const name = 'remote-devices'
/** The durable Host storage domain is required before device records can open. */
export const inject = ['storageDomain']

/** Brand a record key at the durable-storage boundary after schema validation. */
function remoteDeviceId(value: string): RemoteDeviceId {
  return value as RemoteDeviceId
}

/** Brand the Host-minted enrollment generation after durable schema validation. */
function remoteDeviceIncarnation(value: string): RemoteDeviceIncarnation {
  return value as RemoteDeviceIncarnation
}

function canonicalInstantMilliseconds(value: string): number | undefined {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date.getTime() : undefined
}

function isCanonicalInstant(value: string): boolean {
  return canonicalInstantMilliseconds(value) !== undefined
}

function error(code: RemoteDeviceDirectoryErrorCode): never {
  switch (code) {
    case 'REMOTE_DEVICE_INVALID':
      throw new RemoteDeviceDirectoryError(code, 'remote device enrollment is invalid')
    case 'REMOTE_DEVICE_ALREADY_ENROLLED':
      throw new RemoteDeviceDirectoryError(code, 'remote device id is already enrolled')
    case 'REMOTE_DEVICE_KEY_ALREADY_ENROLLED':
      throw new RemoteDeviceDirectoryError(code, 'remote device public key is already enrolled')
    case 'REMOTE_DEVICE_NOT_FOUND':
      throw new RemoteDeviceDirectoryError(code, 'remote device is not enrolled')
    case 'REMOTE_DEVICE_TIME_INVALID':
      throw new RemoteDeviceDirectoryError(code, 'remote device timestamp is invalid')
    default:
      code satisfies never
      throw new Error('unreachable remote device directory error code')
  }
}

/** Convert durable storage data into an immutable caller-owned public record. */
function copy(record: StoredRemoteDeviceRecord): RemoteDeviceRecord {
  return {
    id: remoteDeviceId(record.id),
    incarnation: remoteDeviceIncarnation(record.incarnation),
    label: record.label,
    signingPublicKey: record.signingPublicKey,
    agreementPublicKey: record.agreementPublicKey,
    enrolledAt: record.enrolledAt,
    ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
  }
}

/** Validate local enrollment material without echoing untrusted text in failures. */
function enrollment(input: RemoteDeviceEnrollment, enrolledAt: string, incarnation: string): StoredRemoteDeviceRecord {
  const parsed = storedRecordSchema.safeParse({ ...input, enrolledAt, incarnation })
  return parsed.success ? parsed.data : error('REMOTE_DEVICE_INVALID')
}

/**
 * Durable trusted-device directory. All mutation methods are Host-local
 * policy seams: a future local pairing UI invokes `enroll`, authenticated
 * transport invokes `markSeen`, and a Host device manager invokes `revoke`.
 * None accepts a relay token or makes remote enrollment possible by itself.
 */
export class RemoteDeviceDirectory {
  /** Settled tail of every directory mutation, preventing duplicate enrollment races. */
  private writes: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Host context used only for post-durability device events.
   * @param devices - Durable table of validated public records.
   * @param now - Clock for Host-local enrollment, injectable by tests.
   * @param newIncarnation - Host-only opaque generation factory, injectable by tests.
   */
  constructor(
    private readonly ctx: Context,
    private readonly devices: KvTable<RemoteDeviceId, StoredRemoteDeviceRecord>,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newIncarnation: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  /**
   * List enrolled devices in stable enrollment order.
   * @returns copies of every current trusted-device record.
   */
  list(): readonly RemoteDeviceRecord[] {
    return [...this.devices.entries()]
      .map(([, record]) => copy(record))
      .sort((left, right) => left.enrolledAt.localeCompare(right.enrolledAt) || left.id.localeCompare(right.id))
  }

  /**
   * Look up one trusted device by opaque id.
   * @param id - Opaque remote device id.
   * @returns a public metadata copy, or `undefined` when revoked or unknown.
   */
  get(id: RemoteDeviceId): RemoteDeviceRecord | undefined {
    const record = this.devices.get(id)
    return record === undefined ? undefined : copy(record)
  }

  /**
   * Enroll a new remote device after local Host confirmation. Ids and either
   * public key are globally unique within this Host profile, preventing one
   * remote identity from being silently assigned to two device labels.
   * @param input - Locally-confirmed public device enrollment material.
   * @returns the durably enrolled public record.
   */
  async enroll(input: RemoteDeviceEnrollment): Promise<RemoteDeviceRecord> {
    return this.enqueue(async () => {
      const createdAt = this.now()
      if (!isCanonicalInstant(createdAt)) return error('REMOTE_DEVICE_TIME_INVALID')
      const record = enrollment(input, createdAt, this.newIncarnation())
      const id = remoteDeviceId(record.id)
      if (this.devices.get(id) !== undefined) return error('REMOTE_DEVICE_ALREADY_ENROLLED')
      for (const [, existing] of this.devices.entries()) {
        if (existing.signingPublicKey === record.signingPublicKey || existing.agreementPublicKey === record.agreementPublicKey) {
          return error('REMOTE_DEVICE_KEY_ALREADY_ENROLLED')
        }
      }
      await this.devices.put(id, record)
      const device = copy(record)
      this.emit({ type: 'enrolled', device })
      return device
    })
  }

  /**
   * Records the exact public device enrollment already confirmed by the signed
   * Host. This is the one imported ownership path: callers supply no secret
   * and a retry must match every durable public field.
   * @param input - Locally-confirmed public device enrollment material.
   * @param incarnation - Host-confirmed opaque device enrollment incarnation.
   * @returns the durable public record using that exact incarnation.
   */
  async seed(input: RemoteDeviceEnrollment, incarnation: string): Promise<RemoteDeviceRecord> {
    return this.enqueue(async () => {
      const existing = this.devices.get(remoteDeviceId(input.id))
      if (existing !== undefined) return this.exactSeededDevice(existing, input, incarnation)
      const createdAt = this.now()
      if (!isCanonicalInstant(createdAt)) return error('REMOTE_DEVICE_TIME_INVALID')
      const record = enrollment(input, createdAt, incarnation)
      const id = remoteDeviceId(record.id)
      for (const [, candidate] of this.devices.entries()) {
        if (candidate.signingPublicKey === record.signingPublicKey || candidate.agreementPublicKey === record.agreementPublicKey) {
          return error('REMOTE_DEVICE_KEY_ALREADY_ENROLLED')
        }
      }
      await this.devices.put(id, record)
      const device = copy(record)
      this.emit({ type: 'enrolled', device })
      return device
    })
  }

  /**
   * Mark an already authenticated trusted device present. The time is supplied
   * by the connection runtime so reconnect and test clocks stay explicit.
   * @param id - Authenticated remote device id.
   * @param seenAt - Canonical current instant from the Host connection runtime.
   * @returns the updated public metadata.
   */
  async markSeen(id: RemoteDeviceId, seenAt: string): Promise<RemoteDeviceRecord> {
    return this.enqueue(async () => {
      const seenMilliseconds = canonicalInstantMilliseconds(seenAt)
      if (seenMilliseconds === undefined) return error('REMOTE_DEVICE_TIME_INVALID')
      const existing = this.devices.get(id)
      if (existing === undefined) return error('REMOTE_DEVICE_NOT_FOUND')
      const enrolledMilliseconds = canonicalInstantMilliseconds(existing.enrolledAt)
      const lastSeenMilliseconds = existing.lastSeenAt === undefined
        ? undefined
        : canonicalInstantMilliseconds(existing.lastSeenAt)
      if (enrolledMilliseconds === undefined || (existing.lastSeenAt !== undefined && lastSeenMilliseconds === undefined)
        || seenMilliseconds < enrolledMilliseconds || (lastSeenMilliseconds !== undefined && seenMilliseconds < lastSeenMilliseconds)) {
        return error('REMOTE_DEVICE_TIME_INVALID')
      }
      const updated = await this.devices.update(id, current => ({ ...current, lastSeenAt: seenAt }))
      const device = copy(updated)
      this.emit({ type: 'seen', device })
      return device
    })
  }

  /**
   * Revoke a trusted device immediately. Deletion is intentional: subsequent
   * mutual-authentication handshakes have no authorization record to match.
   * @param id - Device id to revoke.
   * @returns whether an enrolled device was removed.
   */
  async revoke(id: RemoteDeviceId): Promise<boolean> {
    return this.enqueue(async () => {
      const removed = await this.devices.delete(id)
      if (removed) this.emit({ type: 'revoked', deviceId: id })
      return removed
    })
  }

  /** Reject a Host-seeded retry that changes a persisted public enrollment fact. */
  private exactSeededDevice(existing: StoredRemoteDeviceRecord, input: RemoteDeviceEnrollment, incarnation: string): RemoteDeviceRecord {
    if (existing.incarnation !== incarnation || existing.label !== input.label
      || existing.signingPublicKey !== input.signingPublicKey || existing.agreementPublicKey !== input.agreementPublicKey) {
      return error('REMOTE_DEVICE_ALREADY_ENROLLED')
    }
    return copy(existing)
  }

  /** Run one mutation after every earlier mutation has settled, preserving future writes after a rejection. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.writes.then(job)
    this.writes = result.then(() => {}, () => {})
    return result
  }

  /** Emit a post-durability notification without turning an observer failure into a false write failure. */
  private emit(change: RemoteDeviceChange): void {
    try {
      this.ctx.emit('remote-devices/changed', change)
    } catch (error) {
      this.ctx.logger.warn(`remote device directory observer failed: ${String(error)}`)
    }
  }
}

/**
 * Mount the Host-owned remote-device directory over the configured durable
 * storage backend. It intentionally offers no configuration: choosing where
 * device records live belongs to `storage-domain`'s deployment route map.
 * @param ctx - Host plugin context.
 * @returns resolution once the durable directory is available.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(REMOTE_DEVICE_DOMAIN)
  const directory = new RemoteDeviceDirectory(ctx, domain.table('devices'))
  ctx.effect(() => () => domain.close())
  ctx.provide('remoteDevices', directory)
}
