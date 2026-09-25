import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { RemoteDeviceId, RemoteDeviceIncarnation } from '@deepseek-ai/dsh-remote-devices'
import { directoryFixture, memoryTable } from '../../remote-devices/tests/fixture.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as HostV3 from '../src/index.ts'
import type { RemoteHostV3RuntimePipe } from '../src/types.ts'

const sockets = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), Socket: sockets.create }))

const DEVICE = 'remote_device_0001' as RemoteDeviceId
const HOST_ENROLLMENT = 'host_enrollment001'
const NOW = '2026-08-21T00:00:00.000Z'
const input = {
  routeId: 'remote_route_000001', deviceId: DEVICE,
  deviceEnrollmentId: 'device_enrollment1' as RemoteDeviceIncarnation,
  hostDeviceId: 'host_device_000001', hostEnrollmentId: HOST_ENROLLMENT, generation: 1,
}
const pipe: RemoteHostV3RuntimePipe = { kind: 'inherited-private-pipe', async *accept() {} }
const native = { hostAppPath: '/Applications/DSH Host', runtimePipe: pipe }
const disposers: Array<() => Promise<void>> = []
type StoredRoute = Parameters<ConstructorParameters<typeof HostV3.RemoteHostV3RouteAllocator>[0]['put']>[1]

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
  vi.restoreAllMocks()
})

function allocatorFixture(now: () => string = () => NOW, newId: () => string = () => HOST_ENROLLMENT) {
  const routes = memoryTable<RemoteDeviceId, StoredRoute>()
  const host = memoryTable<string, { hostEnrollmentId: string }>()
  return { routes, host, allocator: new HostV3.RemoteHostV3RouteAllocator(routes, host, now, newId) }
}

describe('Host V3 durable route rejection and recovery', () => {
  it('recognizes only its own error instances', () => {
    expect(HostV3.isRemoteHostV3Error(new HostV3.RemoteHostV3Error('REMOTE_HOST_V3_DISABLED', 'disabled'))).toBe(true)
    for (const value of [null, undefined, {}, new Error('other')]) expect(HostV3.isRemoteHostV3Error(value)).toBe(false)
  })

  it('creates valid identity and timestamps with production defaults', async () => {
    const routes = memoryTable<RemoteDeviceId, StoredRoute>()
    const host = memoryTable<string, { hostEnrollmentId: string }>()
    const allocator = new HostV3.RemoteHostV3RouteAllocator(routes, host)
    const hostEnrollmentId = await allocator.hostEnrollmentId()
    expect(hostEnrollmentId).toMatch(/^[a-f\d-]{36}$/)
    const created = await allocator.create({ ...input, hostEnrollmentId })
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt)
  })

  it('rejects invalid identity generation and conflicting seeds without replacing durable identity', async () => {
    const { allocator, host } = allocatorFixture(() => NOW, () => 'invalid')
    await expect(allocator.hostEnrollmentId()).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_ROUTE_INVALID' })
    expect(host.size).toBe(0)
    await expect(allocator.seedHostEnrollmentId('bad')).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_ROUTE_INVALID' })
    await expect(allocator.seedHostEnrollmentId(HOST_ENROLLMENT)).resolves.toBe(HOST_ENROLLMENT)
    await expect(allocator.seedHostEnrollmentId(HOST_ENROLLMENT)).resolves.toBe(HOST_ENROLLMENT)
    await expect(allocator.seedHostEnrollmentId('other_enrollment1')).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_ROUTE_INVALID' })
    expect(host.get('identity')).toEqual({ hostEnrollmentId: HOST_ENROLLMENT })
  })

  it.each(['not-a-date', '2026-08-21T00:00:00Z'])('rejects noncanonical clock value %s', async (now) => {
    const { allocator } = allocatorFixture(() => now)
    await expect(allocator.create(input)).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_ROUTE_INVALID' })
    expect(allocator.list()).toEqual([])
  })

  it('sorts detached public routes, rejects absent mutations, and refuses exhausted epochs', async () => {
    const { allocator, routes } = allocatorFixture()
    await expect(allocator.beginConnection(DEVICE)).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_ROUTE_UNAVAILABLE' })
    await expect(allocator.commitConnection(DEVICE, 1)).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_EPOCH_INVALID' })
    await expect(allocator.remove(DEVICE)).resolves.toBeUndefined()
    const first = await allocator.create(input)
    const second = await allocator.create({ ...input, deviceId: 'remote_device_0002' as RemoteDeviceId, routeId: 'remote_route_000002' })
    expect(allocator.list()).toEqual([first, second])
    expect(allocator.get(DEVICE)).not.toBe(routes.get(DEVICE))
    await routes.put(DEVICE, { ...first, lastConnectionEpoch: 2_147_483_647 })
    await expect(allocator.beginConnection(DEVICE)).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_EPOCH_INVALID' })
  })

  it('rejects out-of-range and foreign-host native finalization without committing', async () => {
    const { allocator, host } = allocatorFixture()
    const route = await allocator.create(input)
    for (const connectionEpoch of [1.5, -1, 2_147_483_648]) {
      await expect(allocator.synchronizeFinalizedEpoch({ ...input, connectionEpoch }))
        .rejects.toMatchObject({ code: 'REMOTE_HOST_V3_EPOCH_INVALID' })
    }
    await host.delete('identity')
    await expect(allocator.synchronizeFinalizedEpoch({ ...input, connectionEpoch: 1 }))
      .rejects.toMatchObject({ code: 'REMOTE_HOST_V3_EPOCH_INVALID' })
    expect(allocator.get(DEVICE)).toEqual(route)
  })
})

describe('Host V3 activation', () => {
  it('refuses a handoff when live configuration disables it during activation', () => {
    const { allocator } = allocatorFixture()
    const ctx = new Context()
    const serve = vi.fn()
    ctx.provide('remoteGateway', { serve })
    let reads = 0
    const config: HostV3.Config = {
      get enabled() { return reads++ === 0 },
      hostAppPath: native.hostAppPath,
    }
    const controller = new HostV3.RemoteHostV3Controller(ctx, allocator, directoryFixture({}), native, config)
    expect(() => { controller.start() }).toThrow('Remote Host V3 is disabled')
    expect(reads).toBe(2)
    expect(serve).not.toHaveBeenCalled()
    controller.dispose()
  })
  it('keeps disabled and deferred controllers inert and disposal idempotent', () => {
    const { allocator } = allocatorFixture()
    const devices = directoryFixture({})
    const disabled = new HostV3.RemoteHostV3Controller(new Context(), allocator, devices, undefined, { enabled: false, hostAppPath: '' })
    disabled.start()
    expect(disabled.listRoutes()).toEqual([])
    expect(() => disabled.createInheritedNativeProvider(198, '/Host')).toThrow('disabled')
    disabled.dispose()
    disabled.dispose()
    const deferred = new HostV3.RemoteHostV3Controller(new Context(), allocator, devices, undefined, { enabled: true, hostAppPath: '' })
    deferred.start()
    deferred.dispose()
  })

  it('adopts only descriptor 198 through the native socket seam', async () => {
    class InheritedSocket extends Duplex {
      readonly unref = vi.fn()
      override _read(): void {}
      override _write(_data: Buffer, _encoding: BufferEncoding, done: () => void): void { done() }
    }
    const socket = new InheritedSocket()
    sockets.create.mockImplementation(function SocketFixture() { return socket })
    const { allocator } = allocatorFixture()
    const devices = directoryFixture({})
    const controller = new HostV3.RemoteHostV3Controller(new Context(), allocator, devices, undefined, { enabled: true, hostAppPath: '' })
    const provider = controller.createInheritedNativeProvider(198, '/Host')
    expect(provider.runtimePipe.kind).toBe('inherited-private-pipe')
    expect(sockets.create).toHaveBeenCalledWith({ fd: 198, readable: true, writable: true })
    expect(socket.unref).toHaveBeenCalledOnce()
    HostV3.createRemoteHostV3InheritedWireProvider(allocator, devices)
    const signal = AbortSignal.abort()
    const iterator = provider.runtimePipe.accept(signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    socket.destroy()
  })

  it.each([
    { enabled: false, argv: undefined, mounted: false },
    { enabled: true, argv: ['--other', '198', '--private-authority-fd', '199'], mounted: false },
    { enabled: true, argv: ['--private-relay-fd', '198', '--private-authority-fd', '199'], mounted: false },
    { enabled: true, argv: [], mounted: true },
  ])('mounts and disposes the real Cordis plugin for $enabled/$mounted/$argv', async ({ enabled, argv, mounted }) => {
    const ctx = new Context()
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)
    ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'memory' }))
    ctx.provide('remoteDevices', directoryFixture({}))
    const serve = vi.fn(async (_pipe: RemoteHostV3RuntimePipe, _signal: AbortSignal) => {})
    ctx.provide('remoteGateway', { serve })
    if (argv !== undefined) ctx.provide('cmdlineArgs', { get: () => argv })
    if (mounted) ctx.provide('remoteHostV3Native', native)
    const fiber = ctx.plugin(HostV3, { enabled, hostAppPath: mounted ? native.hostAppPath : '' })
    await fiber
    expect(ctx.remoteHostV3.listRoutes()).toEqual([])
    expect(serve).toHaveBeenCalledTimes(mounted ? 1 : 0)
    if (mounted) expect(() => { ctx.remoteHostV3.start() }).toThrow('already serves')
    await fiber.dispose()
    expect(ctx.get('remoteHostV3')).toBeUndefined()
    if (mounted) expect(serve.mock.calls[0]?.[1].aborted).toBe(true)
  })
})
