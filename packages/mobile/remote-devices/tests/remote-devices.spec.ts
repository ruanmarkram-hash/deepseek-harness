import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as StorageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import {
  REMOTE_DEVICE_DOMAIN,
  RemoteDeviceDirectory,
  RemoteDeviceDirectoryError,
  type RemoteDeviceEnrollment,
} from '@deepseek-ai/dsh-remote-devices'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as RemoteDevicesPlugin from '../src/index.ts'

const FIRST = '2026-08-20T10:00:00.000Z'
const SECOND = '2026-08-20T10:01:00.000Z'
const THIRD = '2026-08-20T10:02:00.000Z'
const ID = 'remote_device_0001'
const KEY = Buffer.from(new Uint8Array(32).fill(1)).toString('base64url')
const AGREEMENT = Buffer.from(new Uint8Array(32).fill(2)).toString('base64url')
const OTHER_AGREEMENT = Buffer.from(new Uint8Array(32).fill(3)).toString('base64url')

const enrollment = (overrides: Partial<RemoteDeviceEnrollment> = {}): RemoteDeviceEnrollment => ({
  id: ID,
  label: 'Ruan’s iPhone',
  signingPublicKey: KEY,
  agreementPublicKey: AGREEMENT,
  ...overrides,
})

async function harness(now = () => FIRST, newIncarnation = () => 'host_incarnation_0001') {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend()
  ctx.storage.backend.register('memory', backend)
  const disposeBackend = ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  const domain = await facility.open(REMOTE_DEVICE_DOMAIN)
  const directory = new RemoteDeviceDirectory(ctx, domain.table('devices'), now, newIncarnation)
  const disposeDirectory = ctx.provide('remoteDevices', directory)
  return { ctx, directory, dispose: async () => {
    disposeDirectory()
    await domain.close()
    disposeBackend()
  } }
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
})

describe('RemoteDeviceDirectory', () => {
  it('mounts through the storage-domain route and releases the Host service on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    const disposeBackend = ctx.provide(storageBackendServiceKey('memory'), backend)
    const storageFiber = await ctx.plugin(StorageDomainPlugin, { backend: 'memory' })
    const remoteFiber = await ctx.plugin(RemoteDevicesPlugin)
    try {
      await vi.waitFor(() => { expect(ctx.remoteDevices).toBeInstanceOf(RemoteDeviceDirectory) })
      await expect(ctx.remoteDevices.enroll(enrollment())).resolves.toMatchObject({ id: ID })
      await remoteFiber.dispose()
      expect(ctx.get('remoteDevices')).toBeUndefined()
    } finally {
      await storageFiber.dispose()
      disposeBackend()
    }
  })

  it('persists public device metadata, emits only after durability, and returns copies', async () => {
    const { ctx, directory, dispose } = await harness()
    disposers.push(dispose)
    const changes: unknown[] = []
    ctx.on('remote-devices/changed', (change) => { changes.push(change) })

    const device = await directory.enroll(enrollment())
    expect(device).toMatchObject({ id: ID, incarnation: 'host_incarnation_0001', label: 'Ruan’s iPhone', enrolledAt: FIRST })
    expect(changes).toEqual([{ type: 'enrolled', device }])

    const listed = directory.list()
    expect(listed).toEqual([device])
    expect(listed[0]).not.toBe(device)
    expect(directory.get(device.id)).toEqual(device)
  })

  it('preserves one native-confirmed public enrollment incarnation and rejects any conflicting replay', async () => {
    const { directory, dispose } = await harness()
    disposers.push(dispose)
    const seeded = await directory.seed(enrollment(), 'native_enrollment_01')
    await expect(directory.seed(enrollment(), 'native_enrollment_01')).resolves.toEqual(seeded)
    await expect(directory.seed(enrollment(), 'native_enrollment_02')).rejects.toMatchObject({ code: 'REMOTE_DEVICE_ALREADY_ENROLLED' })
    await expect(directory.seed(enrollment({ label: 'Different phone' }), 'native_enrollment_01')).rejects.toMatchObject({ code: 'REMOTE_DEVICE_ALREADY_ENROLLED' })
    expect(directory.get(seeded.id)).toEqual(seeded)
  })

  it('rejects malformed enrollment plus duplicate ids and public keys without replacing a trusted record', async () => {
    const { directory, dispose } = await harness()
    disposers.push(dispose)
    const first = await directory.enroll(enrollment())

    await expect(directory.enroll(enrollment({ label: ' untrusted' }))).rejects.toMatchObject({ code: 'REMOTE_DEVICE_INVALID' })
    await expect(directory.enroll(enrollment({ signingPublicKey: KEY, agreementPublicKey: KEY }))).rejects.toMatchObject({ code: 'REMOTE_DEVICE_INVALID' })
    await expect(directory.enroll(enrollment())).rejects.toMatchObject({ code: 'REMOTE_DEVICE_ALREADY_ENROLLED' })
    await expect(directory.enroll(enrollment({ id: 'remote_device_0002', signingPublicKey: KEY, agreementPublicKey: OTHER_AGREEMENT })))
      .rejects.toMatchObject({ code: 'REMOTE_DEVICE_KEY_ALREADY_ENROLLED' })
    expect(directory.get(first.id)).toEqual(first)
  })

  it('serializes concurrent enrollment so the second identical identity cannot overwrite the first', async () => {
    const { directory, dispose } = await harness()
    disposers.push(dispose)

    const settled = await Promise.allSettled([directory.enroll(enrollment()), directory.enroll(enrollment())])
    expect(settled.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(directory.list()).toHaveLength(1)
    expect(settled[1]).toMatchObject({ reason: { code: 'REMOTE_DEVICE_ALREADY_ENROLLED' } })
  })

  it('records authenticated presence monotonically and rejects unknown or backdated devices', async () => {
    const { ctx, directory, dispose } = await harness()
    disposers.push(dispose)
    const changes: unknown[] = []
    ctx.on('remote-devices/changed', (change) => { changes.push(change) })
    const device = await directory.enroll(enrollment())

    const seen = await directory.markSeen(device.id, SECOND)
    expect(seen.lastSeenAt).toBe(SECOND)
    await expect(directory.markSeen(device.id, FIRST)).rejects.toMatchObject({ code: 'REMOTE_DEVICE_TIME_INVALID' })
    await expect(directory.markSeen('remote_device_9999' as typeof device.id, SECOND)).rejects.toMatchObject({ code: 'REMOTE_DEVICE_NOT_FOUND' })
    expect(changes).toEqual([
      { type: 'enrolled', device },
      { type: 'seen', device: seen },
    ])
  })

  it('serializes concurrent presence updates so a later arrival cannot regress last seen time', async () => {
    const { directory, dispose } = await harness()
    disposers.push(dispose)
    const device = await directory.enroll(enrollment())

    const settled = await Promise.allSettled([
      directory.markSeen(device.id, THIRD),
      directory.markSeen(device.id, SECOND),
    ])
    expect(settled.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(directory.get(device.id)?.lastSeenAt).toBe(THIRD)
    expect(settled[1]).toMatchObject({ reason: { code: 'REMOTE_DEVICE_TIME_INVALID' } })
  })

  it('compares extended-year canonical instants by time rather than their lexical representation', async () => {
    const { directory, dispose } = await harness(() => '9999-12-31T23:59:59.999Z')
    disposers.push(dispose)
    const device = await directory.enroll(enrollment())

    await expect(directory.markSeen(device.id, '+010000-01-01T00:00:00.000Z')).resolves.toMatchObject({
      lastSeenAt: '+010000-01-01T00:00:00.000Z',
    })
    await expect(directory.markSeen(device.id, '9999-12-31T23:59:59.999Z')).rejects.toMatchObject({
      code: 'REMOTE_DEVICE_TIME_INVALID',
    })
  })

  it('removes authorization immediately on revoke and reports no-op revocation', async () => {
    const { ctx, directory, dispose } = await harness()
    disposers.push(dispose)
    const changes: unknown[] = []
    ctx.on('remote-devices/changed', (change) => { changes.push(change) })
    const device = await directory.enroll(enrollment())

    await expect(directory.revoke(device.id)).resolves.toBe(true)
    expect(directory.get(device.id)).toBeUndefined()
    await expect(directory.revoke(device.id)).resolves.toBe(false)
    expect(changes).toEqual([
      { type: 'enrolled', device },
      { type: 'revoked', deviceId: device.id },
    ])
  })

  it('mints a fresh Host incarnation when a revoked device id is enrolled again', async () => {
    const incarnations = ['host_incarnation_0001', 'host_incarnation_0002']
    const { directory, dispose } = await harness(() => FIRST, () => {
      const next = incarnations.shift()
      if (next === undefined) throw new Error('Expected test incarnation')
      return next
    })
    disposers.push(dispose)

    const first = await directory.enroll(enrollment())
    await directory.revoke(first.id)
    const second = await directory.enroll(enrollment())

    expect(second.id).toBe(first.id)
    expect(second.incarnation).not.toBe(first.incarnation)
    expect(second.incarnation).toBe('host_incarnation_0002')
  })

  it('fails closed when the Host-local enrollment clock is invalid', async () => {
    const { directory, dispose } = await harness(() => 'not-a-time')
    disposers.push(dispose)
    await expect(directory.enroll(enrollment())).rejects.toBeInstanceOf(RemoteDeviceDirectoryError)
    await expect(directory.enroll(enrollment())).rejects.toMatchObject({ code: 'REMOTE_DEVICE_TIME_INVALID' })
  })

  it('rejects non-canonical, wrong-length, and malformed public keys before durable persistence', async () => {
    const { directory, dispose } = await harness()
    disposers.push(dispose)

    await expect(directory.enroll(enrollment({ signingPublicKey: `${KEY}=` }))).rejects.toMatchObject({ code: 'REMOTE_DEVICE_INVALID' })
    await expect(directory.enroll(enrollment({ agreementPublicKey: Buffer.from(new Uint8Array(31)).toString('base64url') }))).rejects.toMatchObject({ code: 'REMOTE_DEVICE_INVALID' })
    await expect(directory.enroll(enrollment({ signingPublicKey: `${KEY.slice(0, -1)}B` }))).rejects.toMatchObject({ code: 'REMOTE_DEVICE_INVALID' })
    expect(directory.list()).toEqual([])
  })
})
