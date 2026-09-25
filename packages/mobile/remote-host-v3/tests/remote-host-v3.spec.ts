import { afterEach, describe, expect, it, vi } from 'vitest'
import { Duplex } from 'node:stream'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { RemoteDeviceDirectory, RemoteDeviceId, RemoteDeviceIncarnation, RemoteDeviceRecord } from '@deepseek-ai/dsh-remote-devices'
import type { RemoteWireId } from '@deepseek-ai/dsh-remote-wire'
import { RemoteGateway } from '@deepseek-ai/dsh-remote-gateway'
import { createMobileApi, type ApiProxy } from '@deepseek-ai/dsh-remote-api'
import {
  REMOTE_HOST_V3_DOMAIN,
  RemoteHostV3Controller,
  RemoteHostV3InheritedWireProvider,
  RemoteHostV3RouteAllocator,
  REMOTE_HOST_V3_PRIVATE_FD,
  REMOTE_HOST_V3_WIRE_MAX_INGRESS_BYTES,
  REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_ITEMS,
  REMOTE_HOST_V3_WIRE_MAX_RECORDS_PER_INGRESS_CHUNK,
} from '../src/index.ts'
import type { RemoteHostV3NativeProvider, RemoteHostV3RuntimePipe } from '../src/types.ts'
import { directoryFixture } from '../../remote-devices/tests/fixture.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const DEVICE = 'remote_device_0001' as RemoteDeviceId
const ROUTE = 'remote_route_000001'
const DEVICE_TWO = 'remote_device_0002' as RemoteDeviceId
const ROUTE_TWO = 'remote_route_000002'
const HOST = 'host_device_000001'
const HOST_ENROLLMENT = 'host_enrollment001'
const DEVICE_ENROLLMENT = 'device_enrollment1'
const DEVICE_TWO_ENROLLMENT = 'device_enrollment2'
const NOW = '2026-08-21T00:00:00.000Z'
const CONNECTION = 'remote_connection0001'
const CONNECTION_TWO = 'remote_connection0002'
const REQUEST = 'remote_request_0001' as RemoteWireId
const SIGNING = Buffer.from(new Uint8Array(32).fill(1)).toString('base64url')
const AGREEMENT = Buffer.from(new Uint8Array(32).fill(2)).toString('base64url')

function gatewayContext(serve: RemoteGateway['serve']): Context {
  const ctx = new Context()
  const gateway = new RemoteGateway({
    api: createMobileApi(ctx), devices: directoryFixture({}),
    now: () => NOW, newId: () => REQUEST, audit: () => {},
  }, { maxIdempotencyEntriesPerDevice: 2, maxEventEntriesPerDevice: 2 })
  ctx.provide('remoteGateway', Object.assign(gateway, { serve }))
  return ctx
}

const KIND = {
  'runtime.ready': 1,
  'route.upsert': 2,
  'route.revoked': 3,
  'epoch.begin': 4,
  'epoch.begun': 5,
  'epoch.commit': 6,
  'epoch.committed': 7,
  'connection.open': 8,
  'connection.frame': 9,
  'connection.closed': 10,
  'connection.send': 11,
  'connection.close': 12,
  'host.stopping': 13,
  'device.enroll': 14,
  'device.enrolled': 15,
  'enrollment.seed': 16,
  'epoch.synchronize': 17,
  'epoch.synchronized': 18,
} as const

type WireKind = keyof typeof KIND

class TestWire extends Duplex {
  readonly sent: Buffer[] = []

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sent.push(Buffer.from(chunk))
    callback()
  }

  receive(value: Uint8Array): void { this.push(Buffer.from(value)) }
  eof(): void { this.push(null) }
}

class SlowTestWire extends TestWire {
  private stalled = false
  private readonly callbacks: Array<(error?: Error | null) => void> = []

  stall(): void { this.stalled = true }
  release(): void {
    this.stalled = false
    for (const callback of this.callbacks.splice(0)) callback()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sent.push(Buffer.from(chunk))
    if (this.stalled) this.callbacks.push(callback)
    else callback()
  }
}

class CompletionWire extends TestWire {
  afterWrite: (() => void) | undefined

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sent.push(Buffer.from(chunk))
    queueMicrotask(() => {
      callback()
      this.afterWrite?.()
    })
  }
}

class ObservedBytes extends Uint8Array {
  constructor(value: Uint8Array, onSize: () => void) {
    super(value)
    const length = this.byteLength
    Object.defineProperty(this, 'byteLength', { get: () => { onSize(); return length } })
  }
}

function record(kind: WireKind, metadata?: Record<string, unknown>, payload = new Uint8Array()): Uint8Array {
  const meta = metadata === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(metadata))
  const output = new Uint8Array(7 + meta.byteLength + payload.byteLength)
  new DataView(output.buffer).setUint32(0, 3 + meta.byteLength + payload.byteLength)
  output[4] = KIND[kind]
  new DataView(output.buffer).setUint16(5, meta.byteLength)
  output.set(meta, 7)
  output.set(payload, 7 + meta.byteLength)
  return output
}

function recordWithRawMetadata(kind: WireKind, metadata: string): Uint8Array {
  const meta = new TextEncoder().encode(metadata)
  const output = new Uint8Array(7 + meta.byteLength)
  new DataView(output.buffer).setUint32(0, 3 + meta.byteLength)
  output[4] = KIND[kind]
  new DataView(output.buffer).setUint16(5, meta.byteLength)
  output.set(meta, 7)
  return output
}

function sent(channel: TestWire, index: number): {
  readonly kind: WireKind
  readonly metadata: Record<string, unknown>
  readonly payload: Uint8Array
} {
  const value = channel.sent[index]
  if (value === undefined) throw new Error('missing test wire write')
  const kind = Object.entries(KIND).find(([, byte]) => byte === value[4])?.[0] as WireKind | undefined
  if (kind === undefined) throw new Error('unknown test wire kind')
  const metadataLength = value.readUInt16BE(5)
  return {
    kind,
    metadata: metadataLength === 0 ? {} : JSON.parse(value.subarray(7, 7 + metadataLength).toString('utf8')) as Record<string, unknown>,
    payload: new Uint8Array(value.subarray(7 + metadataLength)),
  }
}

function routeUpsert(): Uint8Array {
  return record('route.upsert', {
    routeId: ROUTE,
    deviceId: DEVICE,
    deviceEnrollmentId: DEVICE_ENROLLMENT,
    hostDeviceId: HOST,
    hostEnrollmentId: HOST_ENROLLMENT,
    generation: 1,
  })
}

function routeUpsertTwo(): Uint8Array {
  return record('route.upsert', {
    routeId: ROUTE_TWO,
    deviceId: DEVICE_TWO,
    deviceEnrollmentId: DEVICE_TWO_ENROLLMENT,
    hostDeviceId: HOST,
    hostEnrollmentId: HOST_ENROLLMENT,
    generation: 1,
  })
}

function deviceEnroll(metadata: Record<string, unknown> = {}): Uint8Array {
  return record('device.enroll', {
    deviceId: DEVICE,
    label: 'Ruan’s iPhone',
    signingPublicKey: SIGNING,
    agreementPublicKey: AGREEMENT,
    ...metadata,
  })
}

function enrollmentSeed(metadata: Record<string, unknown> = {}): Uint8Array {
  return record('enrollment.seed', {
    deviceId: DEVICE,
    label: 'Ruan’s iPhone',
    signingPublicKey: SIGNING,
    agreementPublicKey: AGREEMENT,
    deviceEnrollmentId: DEVICE_ENROLLMENT,
    hostEnrollmentId: HOST_ENROLLMENT,
    ...metadata,
  })
}

function enrolledDevice(): RemoteDeviceRecord {
  return {
    id: DEVICE,
    incarnation: DEVICE_ENROLLMENT as RemoteDeviceIncarnation,
    label: 'Ruan’s iPhone',
    signingPublicKey: SIGNING,
    agreementPublicKey: AGREEMENT,
    enrolledAt: NOW,
  }
}

function joinRecords(records: readonly Uint8Array[]): Uint8Array {
  const length = records.reduce((total, value) => total + value.byteLength, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const value of records) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}

async function flushWireDispatcher(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend()
  ctx.storage.backend.register('memory', backend)
  const disposeBackend = ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  const domain = await facility.open(REMOTE_HOST_V3_DOMAIN)
  const ids = [HOST_ENROLLMENT]
  const allocator = new RemoteHostV3RouteAllocator(
    domain.table('routes'), domain.table('host'), () => NOW, () => ids.shift() ?? 'unused_host_id_001',
  )
  return {
    allocator,
    dispose: async () => { await domain.close(); disposeBackend() },
  }
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
})

async function create(allocator: RemoteHostV3RouteAllocator) {
  return allocator.create({
    routeId: ROUTE,
    deviceId: DEVICE,
    deviceEnrollmentId: DEVICE_ENROLLMENT as RemoteDeviceIncarnation,
    hostDeviceId: HOST,
    hostEnrollmentId: HOST_ENROLLMENT,
    generation: 1,
  })
}

function finalizedEpoch(epoch: number, changes: Record<string, unknown> = {}) {
  return { routeId: ROUTE, deviceId: DEVICE, deviceEnrollmentId: DEVICE_ENROLLMENT,
    hostDeviceId: HOST, hostEnrollmentId: HOST_ENROLLMENT, generation: 1, connectionEpoch: epoch, ...changes }
}

async function nativeEpochHarness(requireSeed = true) {
  const { allocator, dispose } = await harness()
  disposers.push(dispose)
  let device: RemoteDeviceRecord | undefined = enrolledDevice()
  const devices = directoryFixture({ get: () => device, seed: async () => {
    if (device === undefined) throw new Error('cannot seed revoked fixture')
    return device
  } })
  const channel = new TestWire()
  const provider = new RemoteHostV3InheritedWireProvider(channel, allocator, devices, requireSeed)
  const abort = new AbortController()
  const iterator = provider.accept(abort.signal)[Symbol.asyncIterator]()
  const accepted = iterator.next()
  void accepted.catch(() => {})
  disposers.push(async () => { abort.abort(); await accepted.catch(() => {}) })
  await expect.poll(() => channel.sent.length).toBe(1)
  channel.receive(enrollmentSeed())
  channel.receive(routeUpsert())
  await expect.poll(() => allocator.get(DEVICE)?.routeId).toBe(ROUTE)
  return { allocator, channel, accepted, iterator, revoke: () => { device = undefined } }
}

describe('native finalized epoch synchronization', () => {
  it('acknowledges durable finalization before admitting the first connection', async () => {
    const { channel, allocator, accepted } = await nativeEpochHarness()
    channel.receive(record('epoch.synchronize', finalizedEpoch(1)))
    await expect.poll(() => channel.sent.length).toBe(2)
    expect(sent(channel, 1)).toMatchObject({ kind: 'epoch.synchronized', metadata: finalizedEpoch(1) })
    expect(allocator.get(DEVICE)).toMatchObject({ lastConnectionEpoch: 1 })
    channel.receive(record('connection.open', { connectionId: CONNECTION, deviceId: DEVICE, enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING, agreementPublicKey: AGREEMENT, routeId: ROUTE, generation: 1, connectionEpoch: 1 }))
    const result = await accepted
    expect(result.done).toBe(false)
    if (result.done) throw new Error('expected open connection')
    expect(result.value.route.connectionEpoch).toBe(1)
    const frames = result.value.receive(new AbortController().signal)[Symbol.asyncIterator]()
    channel.receive(record('connection.frame', { connectionId: CONNECTION }, new TextEncoder().encode(JSON.stringify({
      version: 3, type: 'request', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: 'remote_idempotency1', method: 'host.describe', payload: {},
    }))))
    await expect(frames.next()).resolves.toMatchObject({ done: false, value: { type: 'request', connectionEpoch: 1, method: 'host.describe' } })
    await expect(result.value.send({ version: 3, type: 'response', connectionEpoch: 1, requestId: REQUEST,
      result: { ok: true, value: {} } }, { active: true, generation: 1, abortSignal: new AbortController().signal })).resolves.toEqual({ status: 'committed-before-fence' })
    expect(sent(channel, 2)).toMatchObject({ kind: 'connection.send', metadata: { connectionId: CONNECTION } })
  })

  it('replays lost acknowledgments and projects later native progress without synthetic intermediate connections', async () => {
    const { channel, allocator } = await nativeEpochHarness()
    for (const epoch of [1, 1, 4, 4]) channel.receive(record('epoch.synchronize', finalizedEpoch(epoch)))
    await expect.poll(() => channel.sent.length).toBe(5)
    expect(allocator.get(DEVICE)).toMatchObject({ lastConnectionEpoch: 4 })
    expect(allocator.get(DEVICE)?.pendingConnectionEpoch).toBeUndefined()
  })

  it('finishes an exact pending child epoch only after native finalization', async () => {
    const { channel, allocator } = await nativeEpochHarness()
    await allocator.beginConnection(DEVICE)
    channel.receive(record('epoch.synchronize', finalizedEpoch(1)))
    await expect.poll(() => channel.sent.length).toBe(2)
    expect(allocator.get(DEVICE)?.pendingConnectionEpoch).toBeUndefined()
    expect(allocator.get(DEVICE)?.lastConnectionEpoch).toBe(1)
  })

  it.each([
    ['route', { routeId: ROUTE_TWO }], ['device', { deviceId: DEVICE_TWO }],
    ['device incarnation', { deviceEnrollmentId: DEVICE_TWO_ENROLLMENT }],
    ['host', { hostDeviceId: 'other_host_000001' }], ['host incarnation', { hostEnrollmentId: 'other_host_enroll1' }],
    ['generation', { generation: 2 }], ['zero epoch', { connectionEpoch: 0 }],
    ['unsafe epoch', { connectionEpoch: Number.MAX_SAFE_INTEGER + 1 }], ['extra key', { extra: true }],
  ])('rejects changed %s without modifying the route', async (_label, changes) => {
    const { channel, allocator, accepted } = await nativeEpochHarness()
    const before = allocator.get(DEVICE)
    channel.receive(record('epoch.synchronize', finalizedEpoch(1, changes)))
    await expect(accepted).rejects.toBeInstanceOf(Error)
    expect(allocator.get(DEVICE)).toEqual(before)
    expect(channel.sent).toHaveLength(1)
  })

  it.each(['rollback', 'pending', 'revoked', 'absent route', 'non-native'] as const)('rejects %s admission', async (reason) => {
    const { channel, allocator, accepted, revoke } = await nativeEpochHarness(reason !== 'non-native')
    if (reason === 'rollback' || reason === 'pending') {
      await allocator.beginConnection(DEVICE)
      await allocator.commitConnection(DEVICE, 1)
      await allocator.beginConnection(DEVICE)
      if (reason === 'rollback') await allocator.commitConnection(DEVICE, 2)
    }
    if (reason === 'revoked') revoke()
    if (reason === 'absent route') await allocator.remove(DEVICE)
    const before = allocator.get(DEVICE)
    channel.receive(record('epoch.synchronize', finalizedEpoch(1)))
    await expect(accepted).rejects.toBeInstanceOf(Error)
    expect(allocator.get(DEVICE)).toEqual(before)
  })

  it('cannot rewrite an already-open connection epoch', async () => {
    const { channel, allocator, accepted, iterator } = await nativeEpochHarness()
    channel.receive(record('epoch.synchronize', finalizedEpoch(1)))
    await expect.poll(() => channel.sent.length).toBe(2)
    channel.receive(record('connection.open', { connectionId: CONNECTION, deviceId: DEVICE, enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING, agreementPublicKey: AGREEMENT, routeId: ROUTE, generation: 1, connectionEpoch: 1 }))
    await accepted
    const next = iterator.next()
    channel.receive(record('epoch.synchronize', finalizedEpoch(2)))
    await expect(next).rejects.toBeInstanceOf(Error)
    expect(allocator.get(DEVICE)?.lastConnectionEpoch).toBe(1)
  })
})

describe('RemoteHostV3RouteAllocator', () => {
  it('persists only public route facts and one stable Host incarnation', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)

    await expect(allocator.hostEnrollmentId()).resolves.toBe(HOST_ENROLLMENT)
    await expect(allocator.hostEnrollmentId()).resolves.toBe(HOST_ENROLLMENT)
    const route = await create(allocator)

    expect(route).toEqual({
      routeId: ROUTE,
      deviceId: DEVICE,
      deviceEnrollmentId: DEVICE_ENROLLMENT,
      hostDeviceId: HOST,
      hostEnrollmentId: HOST_ENROLLMENT,
      generation: 1,
      lastConnectionEpoch: 0,
      createdAt: NOW,
    })
    expect(JSON.stringify(allocator.list())).not.toContain('token')
  })

  it('serializes the exact pending epoch, commits only that epoch, and then advances once', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    await create(allocator)

    const [first, same] = await Promise.all([allocator.beginConnection(DEVICE), allocator.beginConnection(DEVICE)])
    expect(first.pendingConnectionEpoch).toBe(1)
    expect(same.pendingConnectionEpoch).toBe(1)
    await expect(allocator.commitConnection(DEVICE, 2)).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_EPOCH_INVALID' })
    const committed = await allocator.commitConnection(DEVICE, 1)
    expect(committed.lastConnectionEpoch).toBe(1)
    expect('pendingConnectionEpoch' in committed).toBe(false)
    await expect(allocator.beginConnection(DEVICE)).resolves.toMatchObject({ pendingConnectionEpoch: 2 })
  })

  it('rejects duplicate routes and removes an existing route atomically', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    await create(allocator)

    await expect(create(allocator)).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_ROUTE_EXISTS' })
    await expect(allocator.remove(DEVICE)).resolves.toMatchObject({ routeId: ROUTE })
    expect(allocator.get(DEVICE)).toBeUndefined()
  })

  it('accepts routes only under its single durable Host enrollment incarnation', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)

    await expect(allocator.create({
      routeId: ROUTE,
      deviceId: DEVICE,
      deviceEnrollmentId: DEVICE_ENROLLMENT as RemoteDeviceIncarnation,
      hostDeviceId: HOST,
      hostEnrollmentId: 'other_host_enrollment_01',
      generation: 1,
    })).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_ROUTE_INVALID' })
    expect(allocator.list()).toEqual([])
  })
})

describe('RemoteHostV3Controller', () => {
  const pipe: RemoteHostV3RuntimePipe = {
    kind: 'inherited-private-pipe',
    async *accept() {},
  }
  const devices = directoryFixture({ get: () => undefined })

  it('hands only a signed Host-app inherited transport to the generic gateway', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const serve = vi.fn(async () => {})
    const native = {
      hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
      runtimePipe: pipe,
    } satisfies RemoteHostV3NativeProvider
    const controller = new RemoteHostV3Controller(gatewayContext(serve), allocator, devices, native, {
      enabled: true,
      hostAppPath: native.hostAppPath,
    })

    controller.start()
    expect(serve).toHaveBeenCalledWith(pipe, expect.any(AbortSignal))
    controller.dispose()
  })

  it('rejects a missing Host-app handoff before starting the gateway', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const serve = vi.fn(async () => {})
    const controller = new RemoteHostV3Controller(gatewayContext(serve), allocator, devices, undefined, {
      enabled: true,
      hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
    })

    expect(() => { controller.start() }).toThrow()
    expect(serve).not.toHaveBeenCalled()
  })

  it('rejects a mismatched Host-app handoff before starting the gateway', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const serve = vi.fn(async () => {})
    const native = {
      hostAppPath: '/Applications/Other.app/Contents/MacOS/Other',
      runtimePipe: pipe,
    } satisfies RemoteHostV3NativeProvider
    const controller = new RemoteHostV3Controller(gatewayContext(serve), allocator, devices, native, {
      enabled: true,
      hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
    })

    expect(() => { controller.start() }).toThrow()
    expect(serve).not.toHaveBeenCalled()
  })

  it('serves a deferred activated handoff exactly once and rejects repeat or stopped attaches', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const serve = vi.fn(async () => {})
    const controller = new RemoteHostV3Controller(gatewayContext(serve), allocator, devices, undefined, {
      enabled: true,
      hostAppPath: '',
    })
    const activated = (hostAppPath: string) => ({
      hostAppPath,
      runtimePipe: pipe,
    }) satisfies RemoteHostV3NativeProvider

    controller.startWithNative(activated('/Applications/DSH Host.app/Contents/MacOS/DSH Host'))
    expect(serve).toHaveBeenCalledTimes(1)
    expect(() => { controller.startWithNative(activated('/Applications/DSH Host.app/Contents/MacOS/DSH Host')) })
      .toThrow()
    controller.dispose()
    expect(() => { controller.startWithNative(activated('/Applications/DSH Host.app/Contents/MacOS/DSH Host')) })
      .toThrow()
  })

  it('rejects a deferred handoff with an invalid path or pipe kind', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const serve = vi.fn(async () => {})
    const controller = new RemoteHostV3Controller(gatewayContext(serve), allocator, devices, undefined, {
      enabled: true,
      hostAppPath: '',
    })

    expect(() => { controller.startWithNative({ hostAppPath: 'relative/Host', runtimePipe: pipe }) })
      .toThrow()
    expect(() => { controller.startWithNative({
      hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
      runtimePipe: { ...pipe, kind: 'loopback-proxy' as never },
    }) }).toThrow()
    expect(serve).not.toHaveBeenCalled()
  })

  it('rejects a deferred handoff on a disabled composition', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const controller = new RemoteHostV3Controller(new Context(), allocator, devices, undefined, {
      enabled: false,
      hostAppPath: '',
    })

    expect(() => { controller.startWithNative({ hostAppPath: '/Host', runtimePipe: pipe }) })
      .toThrow()
  })

  it('builds the inherited native provider from fixed descriptor facts and an injected test pipe', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const controller = new RemoteHostV3Controller(new Context(), allocator, devices, undefined, {
      enabled: true,
      hostAppPath: '',
    })

    expect(() => controller.createInheritedNativeProvider(REMOTE_HOST_V3_PRIVATE_FD + 1, '/Applications/DSH Host')).toThrow()
    expect(() => controller.createInheritedNativeProvider(REMOTE_HOST_V3_PRIVATE_FD, 'relative')).toThrow()
    const native = controller.createInheritedNativeProvider(REMOTE_HOST_V3_PRIVATE_FD, '/Applications/DSH Host', pipe)
    expect(native.hostAppPath).toBe('/Applications/DSH Host')
    expect(native.runtimePipe).toBe(pipe)
  })
})

describe('RemoteHostV3InheritedWireProvider', () => {
  it('hands a committed FD198 connection to the Host gateway and returns its response only over the private pipe', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const device = enrolledDevice()
    const directory = directoryFixture({
      get: vi.fn<RemoteDeviceDirectory['get']>(() => device),
      markSeen: vi.fn<RemoteDeviceDirectory['markSeen']>(async () => device),
    })
    const list = vi.fn<ApiProxy['sessions']['list']>(async request => ({
      rpcId: request.rpcId,
      result: { ok: true as const, value: { items: [] } },
    }))
    const api = createMobileApi(new Context())
    api.sessions.list = list
    api.events = { mux: async function* () {}, host: async function* () {} }
    const gateway = new RemoteGateway({
      api,
      devices: directory,
      now: () => NOW,
      newId: () => REQUEST,
      audit: () => {},
    }, { maxIdempotencyEntriesPerDevice: 2, maxEventEntriesPerDevice: 2 })
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator, directory)
    const abort = new AbortController()
    const serving = gateway.serve(provider, abort.signal).catch((error: unknown) => error)
    await expect.poll(() => channel.sent.length).toBe(1)

    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    const exchangeDirectory = process.env.DSH_FRAME_PUMP_EXCHANGE_DIRECTORY
    if (exchangeDirectory !== undefined) {
      // The native regression supplies bytes emitted by the production Swift pump and bridge.
      channel.receive(readFileSync(join(exchangeDirectory, 'input.bin')))
    } else {
      channel.receive(record('connection.open', {
        connectionId: CONNECTION,
        deviceId: DEVICE,
        enrollmentId: DEVICE_ENROLLMENT,
        signingPublicKey: SIGNING,
        agreementPublicKey: AGREEMENT,
        routeId: ROUTE,
        generation: 1,
        connectionEpoch: 1,
      }))
      channel.receive(record('connection.frame', { connectionId: CONNECTION }, new TextEncoder().encode(JSON.stringify({
        version: 3,
        type: 'request',
        connectionEpoch: 1,
        requestId: REQUEST,
        idempotencyKey: 'remote_idempotency1',
        method: 'session.list',
        payload: {},
      }))))
    }

    await expect.poll(() => channel.sent.length).toBe(4)
    expect(directory.markSeen).toHaveBeenCalledWith(DEVICE, NOW)
    expect(list).toHaveBeenCalledOnce()
    expect(sent(channel, 1)).toMatchObject({ kind: 'epoch.begun', metadata: { deviceId: DEVICE, routeId: ROUTE, generation: 1, connectionEpoch: 1 } })
    expect(sent(channel, 2)).toMatchObject({ kind: 'epoch.committed', metadata: { deviceId: DEVICE, routeId: ROUTE, generation: 1, connectionEpoch: 1 } })
    expect(sent(channel, 3)).toMatchObject({ kind: 'connection.send', metadata: { connectionId: CONNECTION } })
    expect(JSON.parse(new TextDecoder().decode(sent(channel, 3).payload))).toMatchObject({ type: 'response', connectionEpoch: 1, requestId: REQUEST, result: { ok: true, value: { items: [] } } })
    expect(JSON.stringify(channel.sent)).not.toMatch(/token|private|secret/i)
    expect(channel.destroyed).toBe(false)
    if (exchangeDirectory !== undefined) writeFileSync(join(exchangeDirectory, 'output.bin'), channel.sent[3]!, { mode: 0o600 })

    abort.abort()
    await expect(serving).resolves.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
    await gateway.dispose()
  })

  it('persists a locally-confirmed public device tuple and returns only public enrollment facts', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const device = enrolledDevice()
    const devices = directoryFixture({
      get: vi.fn<RemoteDeviceDirectory['get']>(() => undefined),
      enroll: vi.fn<RemoteDeviceDirectory['enroll']>(async (input) => {
        expect(input).toEqual({ id: DEVICE, label: 'Ruan’s iPhone', signingPublicKey: SIGNING, agreementPublicKey: AGREEMENT })
        return device
      }),
    })
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator, devices)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    void iterator.next().catch(() => {})
    await expect.poll(() => channel.sent.length).toBe(1)

    channel.receive(deviceEnroll())

    await expect.poll(() => channel.sent.length).toBe(2)
    expect(sent(channel, 1)).toEqual({
      kind: 'device.enrolled',
      metadata: {
        deviceId: DEVICE,
        label: 'Ruan’s iPhone',
        signingPublicKey: SIGNING,
        agreementPublicKey: AGREEMENT,
        deviceEnrollmentId: DEVICE_ENROLLMENT,
        hostEnrollmentId: HOST_ENROLLMENT,
      },
      payload: new Uint8Array(),
    })
    expect(JSON.stringify(sent(channel, 1))).not.toMatch(/token|private|secret/i)
    expect(devices.enroll).toHaveBeenCalledTimes(1)
  })

  it('rejects enrollment records with extra, duplicated, or private metadata before device persistence', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const devices = directoryFixture({ get: vi.fn(), enroll: vi.fn() })
    const extraChannel = new TestWire()
    const extraProvider = new RemoteHostV3InheritedWireProvider(extraChannel, allocator, devices)
    const extraWaiting = extraProvider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => extraChannel.sent.length).toBe(1)
    extraChannel.receive(deviceEnroll({ deviceToken: 'x'.repeat(32) }))
    await expect(extraWaiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
    expect(devices.enroll).not.toHaveBeenCalled()

    const duplicateChannel = new TestWire()
    const duplicateProvider = new RemoteHostV3InheritedWireProvider(duplicateChannel, allocator, devices)
    const duplicateWaiting = duplicateProvider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => duplicateChannel.sent.length).toBe(1)
    duplicateChannel.receive(recordWithRawMetadata('device.enroll', `{"deviceId":"${DEVICE}","label":"Ruan’s iPhone","signingPublicKey":"${SIGNING}","agreementPublicKey":"${AGREEMENT}","deviceId":"${DEVICE}"}`))
    await expect(duplicateWaiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
    expect(devices.enroll).not.toHaveBeenCalled()

    const escapedDuplicateChannel = new TestWire()
    const escapedDuplicateProvider = new RemoteHostV3InheritedWireProvider(escapedDuplicateChannel, allocator, devices)
    const escapedDuplicateWaiting = escapedDuplicateProvider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => escapedDuplicateChannel.sent.length).toBe(1)
    escapedDuplicateChannel.receive(recordWithRawMetadata('device.enroll', `{"deviceId":"${DEVICE}","label":"Ruan’s iPhone","signingPublicKey":"${SIGNING}","agreementPublicKey":"${AGREEMENT}","\\u0064eviceId":"${DEVICE}"}`))
    await expect(escapedDuplicateWaiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
    expect(devices.enroll).not.toHaveBeenCalled()

    const keyChannel = new TestWire()
    const keyProvider = new RemoteHostV3InheritedWireProvider(keyChannel, allocator, devices)
    const keyWaiting = keyProvider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => keyChannel.sent.length).toBe(1)
    keyChannel.receive(deviceEnroll({ signingPublicKey: `${SIGNING.slice(0, -1)}B` }))
    await expect(keyWaiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
    expect(devices.enroll).not.toHaveBeenCalled()
  })

  it('replays an identical local confirmation without changing its Host-minted enrollment', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const device = enrolledDevice()
    const devices = directoryFixture({
      get: vi.fn<RemoteDeviceDirectory['get']>(() => device),
      enroll: vi.fn<RemoteDeviceDirectory['enroll']>(),
    })
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator, devices)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    void iterator.next().catch(() => {})
    await expect.poll(() => channel.sent.length).toBe(1)

    channel.receive(deviceEnroll())

    await expect.poll(() => channel.sent.length).toBe(2)
    expect(sent(channel, 1).metadata).toMatchObject({ deviceEnrollmentId: DEVICE_ENROLLMENT, hostEnrollmentId: HOST_ENROLLMENT })
    expect(devices.enroll).not.toHaveBeenCalled()
  })

  it('requires a native-confirmed enrollment seed before a hosted child accepts device or route writes', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const devices = directoryFixture({ get: vi.fn(), seed: vi.fn(), enroll: vi.fn() })
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator, devices, true)
    const waiting = provider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(routeUpsert())
    await expect(waiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
    expect(devices.seed).not.toHaveBeenCalled()
    expect(devices.enroll).not.toHaveBeenCalled()
  })

  it('preserves the seeded native enrollment identities through the ordinary receipt path and rejects a replay', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const device = enrolledDevice()
    const devices = directoryFixture({
      get: vi.fn<RemoteDeviceDirectory['get']>(() => device),
      seed: vi.fn<RemoteDeviceDirectory['seed']>(async (input, incarnation) => {
        expect(input).toEqual({ id: DEVICE, label: 'Ruan’s iPhone', signingPublicKey: SIGNING, agreementPublicKey: AGREEMENT })
        expect(incarnation).toBe(DEVICE_ENROLLMENT)
        return device
      }),
      enroll: vi.fn<RemoteDeviceDirectory['enroll']>(),
    })
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator, devices, true)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    const terminal = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)

    channel.receive(enrollmentSeed())
    channel.receive(deviceEnroll())
    await expect.poll(() => channel.sent.length).toBe(2)
    expect(sent(channel, 1)).toMatchObject({
      kind: 'device.enrolled',
      metadata: { deviceEnrollmentId: DEVICE_ENROLLMENT, hostEnrollmentId: HOST_ENROLLMENT },
    })
    expect(devices.seed).toHaveBeenCalledOnce()
    expect(devices.enroll).not.toHaveBeenCalled()

    channel.receive(enrollmentSeed())
    await expect(terminal).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
  })

  it('yields only an opened connection, exchanges strict frames, and emits fixed sends and closes', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const abort = new AbortController()
    const iterator = provider.accept(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)
    expect(sent(channel, 0)).toEqual({ kind: 'runtime.ready', metadata: {}, payload: new Uint8Array() })

    const upsert = routeUpsert()
    channel.receive(upsert.slice(0, 8))
    channel.receive(upsert.slice(8))
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const opened = await pending
    expect(opened.done).toBe(false)
    if (opened.done) throw new Error('expected open connection')
    expect(opened.value.peer.deviceId).toBe(DEVICE)

    const receive = opened.value.receive(new AbortController().signal)[Symbol.asyncIterator]()
    const inbound = new TextEncoder().encode(JSON.stringify({
      version: 3, type: 'request', connectionEpoch: 1, requestId: 'remote_request_0001', idempotencyKey: 'remote_idempotency1', method: 'host.describe', payload: {},
    }))
    channel.receive(record('connection.frame', { connectionId: CONNECTION }, inbound))
    await expect(receive.next()).resolves.toMatchObject({ done: false, value: { type: 'request', connectionEpoch: 1 } })

    const fence = { active: true, generation: 1, abortSignal: new AbortController().signal }
    await expect(opened.value.send({
      version: 3, type: 'response', connectionEpoch: 1, requestId: REQUEST, result: { ok: true, value: {} },
    }, fence)).resolves.toEqual({ status: 'committed-before-fence' })
    await expect.poll(() => channel.sent.length).toBe(4)
    expect(sent(channel, 3)).toMatchObject({ kind: 'connection.send', metadata: { connectionId: CONNECTION } })

    await opened.value.close('transport-failed')
    await expect.poll(() => channel.sent.length).toBe(5)
    expect(sent(channel, 4)).toMatchObject({ kind: 'connection.close', metadata: { connectionId: CONNECTION, reason: 'transport-failed' } })
    abort.abort()
  })

  it('responds to the exact epoch begin and commit lifecycle with public route facts', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const abort = new AbortController()
    const iterator = provider.accept(abort.signal)[Symbol.asyncIterator]()
    void iterator.next().catch(() => {})
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    await expect.poll(() => channel.sent.length).toBe(2)
    expect(sent(channel, 1)).toMatchObject({ kind: 'epoch.begun', metadata: { deviceId: DEVICE, routeId: ROUTE, generation: 1, connectionEpoch: 1 } })
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    await expect.poll(() => channel.sent.length).toBe(3)
    expect(sent(channel, 2)).toMatchObject({ kind: 'epoch.committed', metadata: { deviceId: DEVICE, routeId: ROUTE, generation: 1, connectionEpoch: 1 } })
    abort.abort()
  })

  it('aborts one slow consumer when near-8MiB valid frames exceed its bounded queue', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const opened = await pending
    expect(opened.done).toBe(false)
    if (opened.done) throw new Error('expected open connection')

    const oneMiBish = 'x'.repeat(1_040_000)
    const nearEightMiB = new TextEncoder().encode(JSON.stringify({
      version: 3, type: 'response', connectionEpoch: 1, requestId: 'remote_request_0001',
      result: { ok: true, value: Array.from({ length: 8 }, () => oneMiBish) },
    }))
    expect(nearEightMiB.byteLength).toBeGreaterThan(8 * 1_000_000)
    channel.receive(record('connection.frame', { connectionId: CONNECTION }, nearEightMiB))
    const receive = opened.value.receive(new AbortController().signal)[Symbol.asyncIterator]()
    await expect(receive.next()).resolves.toMatchObject({ done: false, value: { type: 'response' } })
    channel.receive(record('connection.frame', { connectionId: CONNECTION }, nearEightMiB))
    await flushWireDispatcher()
    channel.receive(record('connection.frame', { connectionId: CONNECTION }, nearEightMiB))
    await expect.poll(() => channel.sent.length).toBe(4)
    expect(sent(channel, 3)).toMatchObject({ kind: 'connection.close', metadata: { connectionId: CONNECTION, reason: 'protocol-rejected' } })
  })

  it('bounds raw pending-dispatch chunks before parsing them', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const waiting = provider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => channel.sent.length).toBe(1)
    for (let index = 0; index < 40; index += 1) channel.receive(routeUpsert())
    await expect(waiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OVERFLOW' })
  })

  it('rejects an oversized raw descriptor chunk before copying it', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const waiting = provider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(new Uint8Array(REMOTE_HOST_V3_WIRE_MAX_INGRESS_BYTES + 1))
    await expect(waiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OVERFLOW' })
  })

  it('streams dense complete records and fails closed at the per-chunk record limit', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const waiting = provider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => channel.sent.length).toBe(1)

    channel.receive(joinRecords(Array.from(
      { length: REMOTE_HOST_V3_WIRE_MAX_RECORDS_PER_INGRESS_CHUNK + 1 },
      () => routeUpsert(),
    )))
    await expect(waiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OVERFLOW' })
  })

  it('iterates a near-8MiB dense valid chunk without retaining copied record suffixes', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const waiting = provider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    void waiting.catch(() => {})
    await expect.poll(() => channel.sent.length).toBe(1)

    const routes = Array.from({ length: REMOTE_HOST_V3_WIRE_MAX_RECORDS_PER_INGRESS_CHUNK }, (_, index) => {
      const suffix = index.toString().padStart(5, '0')
      const deviceId = `dense_device_${suffix}`
      const raw = JSON.stringify({
        routeId: `dense_route_${suffix}`,
        deviceId,
        deviceEnrollmentId: `dense_enrollment_${suffix}`,
        hostDeviceId: HOST,
        hostEnrollmentId: HOST_ENROLLMENT,
        generation: 1,
      })
      return recordWithRawMetadata('route.upsert', `{${' '.repeat(7_500)}${raw.slice(1)}`)
    })
    const dense = joinRecords(routes)
    expect(dense.byteLength).toBeGreaterThan(7 * 1024 * 1024)
    expect(dense.byteLength).toBeLessThanOrEqual(REMOTE_HOST_V3_WIRE_MAX_INGRESS_BYTES)
    channel.receive(dense)
    await expect.poll(() => allocator.get('dense_device_01023' as RemoteDeviceId)).toMatchObject({ routeId: 'dense_route_01023' })
  })

  it('preserves malformed-record rejection after a dense valid prefix without materializing it', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const waiting = provider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => channel.sent.length).toBe(1)

    const validPrefix = Array.from({ length: REMOTE_HOST_V3_WIRE_MAX_RECORDS_PER_INGRESS_CHUNK }, () => routeUpsert())
    channel.receive(joinRecords([...validPrefix, new Uint8Array([0, 0, 0, 3, 255, 0, 0])]))
    await expect(waiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
  })

  it('contains post-overflow frame bursts to one connection while another remains usable', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    const firstPending = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const first = await firstPending
    if (first.done) throw new Error('expected first connection')
    const secondPending = iterator.next()
    channel.receive(record('connection.open', {
      connectionId: CONNECTION_TWO,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const second = await secondPending
    if (second.done) throw new Error('expected second connection')

    const response = new TextEncoder().encode(JSON.stringify({
      version: 3, type: 'response', connectionEpoch: 1, requestId: 'remote_request_0001', result: { ok: true, value: {} },
    }))
    for (let index = 0; index <= 32; index += 1) {
      channel.receive(record('connection.frame', { connectionId: CONNECTION }, response))
      await flushWireDispatcher()
    }
    await expect.poll(() => channel.sent.length).toBe(4)
    expect(sent(channel, 3)).toMatchObject({ kind: 'connection.close', metadata: { connectionId: CONNECTION, reason: 'protocol-rejected' } })
    for (let index = 0; index < 8; index += 1) channel.receive(record('connection.frame', { connectionId: CONNECTION }, response))
    channel.receive(record('connection.frame', { connectionId: CONNECTION_TWO }, response))
    const receive = second.value.receive(new AbortController().signal)[Symbol.asyncIterator]()
    await expect(receive.next()).resolves.toMatchObject({ done: false, value: { type: 'response' } })
    expect(first.value.peer.deviceId).toBe(DEVICE)

    const reusedPending = iterator.next()
    channel.receive(record('connection.closed', { connectionId: CONNECTION }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    await expect(reusedPending).resolves.toMatchObject({ done: false, value: { route: { connectionEpoch: 1 } } })
  })

  it('contains normal local-close races while another connection remains usable', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new SlowTestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    const firstPending = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const first = await firstPending
    if (first.done) throw new Error('expected first connection')
    const secondPending = iterator.next()
    channel.receive(record('connection.open', {
      connectionId: CONNECTION_TWO,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const second = await secondPending
    if (second.done) throw new Error('expected second connection')

    channel.stall()
    const closing = first.value.close('transport-failed')
    await expect.poll(() => channel.sent.length).toBe(4)
    const response = new TextEncoder().encode(JSON.stringify({
      version: 3, type: 'response', connectionEpoch: 1, requestId: 'remote_request_0001', result: { ok: true, value: {} },
    }))
    channel.receive(record('connection.frame', { connectionId: CONNECTION }, response))
    channel.receive(record('connection.closed', { connectionId: CONNECTION }))
    channel.receive(record('connection.frame', { connectionId: CONNECTION_TWO }, response))
    const receive = second.value.receive(new AbortController().signal)[Symbol.asyncIterator]()
    await expect(receive.next()).resolves.toMatchObject({ done: false, value: { type: 'response' } })
    channel.release()
    await closing

    const restoredPending = iterator.next()
    channel.receive(record('route.revoked', { deviceId: DEVICE }))
    channel.receive(record('connection.closed', { connectionId: CONNECTION_TWO }))
    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION_TWO,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    await expect(restoredPending).resolves.toMatchObject({ done: false, value: { peer: { deviceId: DEVICE } } })
  })

  it('does not reuse a locally closing ID until its outbound close has committed', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new SlowTestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const opened = await pending
    if (opened.done) throw new Error('expected open connection')
    channel.stall()
    const closing = opened.value.close('transport-failed')
    await expect.poll(() => channel.sent.length).toBe(4)
    const terminal = iterator.next()
    channel.receive(record('connection.closed', { connectionId: CONNECTION }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    await expect(terminal).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
    await expect(closing).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
  })

  it('drops a queued peer-closed send and blocks same-ID reuse by a different device', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new SlowTestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    const firstPending = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const first = await firstPending
    if (first.done) throw new Error('expected first connection')
    const secondPending = iterator.next()
    channel.receive(routeUpsertTwo())
    channel.receive(record('epoch.begin', { deviceId: DEVICE_TWO }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE_TWO, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION_TWO,
      deviceId: DEVICE_TWO,
      enrollmentId: DEVICE_TWO_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE_TWO,
      generation: 1,
      connectionEpoch: 1,
    }))
    const second = await secondPending
    if (second.done) throw new Error('expected second connection')

    channel.stall()
    const blockingClose = first.value.close('transport-failed')
    await expect.poll(() => channel.sent.length).toBe(6)
    const fence = { active: true, generation: 1, abortSignal: new AbortController().signal }
    const queued = second.value.send({
      version: 3, type: 'response', connectionEpoch: 1, requestId: REQUEST, result: { ok: true, value: {} },
    }, fence)
    const terminal = iterator.next()
    channel.receive(record('connection.closed', { connectionId: CONNECTION_TWO }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION_TWO,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    await expect(terminal).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
    await expect(queued).resolves.toEqual({ status: 'not-committed' })
    expect(channel.sent.filter(value => sent(channel, channel.sent.indexOf(value)).kind === 'connection.send')).toHaveLength(0)
    await expect(blockingClose).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
  })

  it('drops a queued send before a route-revocation close reaches the descriptor', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new SlowTestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    const firstPending = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const first = await firstPending
    if (first.done) throw new Error('expected first connection')
    const secondPending = iterator.next()
    channel.receive(record('connection.open', {
      connectionId: CONNECTION_TWO,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const second = await secondPending
    if (second.done) throw new Error('expected second connection')

    channel.stall()
    const blockingClose = first.value.close('transport-failed')
    await expect.poll(() => channel.sent.length).toBe(4)
    const fence = { active: true, generation: 1, abortSignal: new AbortController().signal }
    const queued = second.value.send({
      version: 3, type: 'response', connectionEpoch: 1, requestId: REQUEST, result: { ok: true, value: {} },
    }, fence)
    channel.receive(record('route.revoked', { deviceId: DEVICE }))
    channel.release()
    await expect(queued).resolves.toEqual({ status: 'not-committed' })
    await blockingClose
    await expect.poll(() => channel.sent.length).toBe(5)
    expect(sent(channel, 4)).toMatchObject({ kind: 'connection.close', metadata: { connectionId: CONNECTION_TWO, reason: 'transport-failed' } })
    expect(channel.sent.some((_, index) => sent(channel, index).kind === 'connection.send')).toBe(false)
  })

  it('reserves outbound capacity before large concurrent sends serialize', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new SlowTestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const opened = await pending
    if (opened.done) throw new Error('expected open connection')
    channel.stall()
    const fence = { active: true, generation: 1, abortSignal: new AbortController().signal }
    const largeResponse = {
      version: 3 as const, type: 'response' as const, connectionEpoch: 1, requestId: REQUEST,
      result: { ok: true as const, value: Array.from({ length: 8 }, () => 'x'.repeat(1_040_000)) },
    }
    const sends = Array.from({ length: REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_ITEMS + 1 }, () => opened.value.send(largeResponse, fence))
    await expect(Promise.all(sends)).resolves.toEqual(Array.from(
      { length: REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_ITEMS + 1 },
      () => ({ status: 'not-committed' }),
    ))
    expect(channel.sent).toHaveLength(4)
    channel.release()
  })

  it('bounds global outbound writes by encoded bytes when the descriptor stalls', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new SlowTestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(routeUpsert())
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    channel.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
    channel.receive(record('connection.open', {
      connectionId: CONNECTION,
      deviceId: DEVICE,
      enrollmentId: DEVICE_ENROLLMENT,
      signingPublicKey: SIGNING,
      agreementPublicKey: AGREEMENT,
      routeId: ROUTE,
      generation: 1,
      connectionEpoch: 1,
    }))
    const opened = await pending
    if (opened.done) throw new Error('expected open connection')
    channel.stall()
    const fence = { active: true, generation: 1, abortSignal: new AbortController().signal }
    const largeResponse = {
      version: 3 as const, type: 'response' as const, connectionEpoch: 1, requestId: REQUEST,
      result: { ok: true as const, value: Array.from({ length: 8 }, () => 'x'.repeat(1_040_000)) },
    }
    const results = await Promise.all([opened.value.send(largeResponse, fence), opened.value.send(largeResponse, fence)])
    expect(results).toEqual([{ status: 'not-committed' }, { status: 'not-committed' }])
    channel.release()
  })

  it('fails closed on malformed, out-of-order, and EOF input', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    const iterator = provider.accept(new AbortController().signal)[Symbol.asyncIterator]()
    const waiting = iterator.next()
    await expect.poll(() => channel.sent.length).toBe(1)
    channel.receive(record('connection.frame', { connectionId: CONNECTION }, new TextEncoder().encode('{}')))
    await expect(waiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })

    const metadataChannel = new TestWire()
    const metadataProvider = new RemoteHostV3InheritedWireProvider(metadataChannel, allocator)
    const metadataWaiting = metadataProvider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => metadataChannel.sent.length).toBe(1)
    metadataChannel.receive(recordWithRawMetadata('epoch.begin', `{"deviceId":"${DEVICE}","deviceId":"${DEVICE}"}`))
    await expect(metadataWaiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })

    const eofChannel = new TestWire()
    const eofProvider = new RemoteHostV3InheritedWireProvider(eofChannel, allocator)
    const eofWaiting = eofProvider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()
    await expect.poll(() => eofChannel.sent.length).toBe(1)
    eofChannel.receive(new Uint8Array([0, 0, 0, 3]))
    eofChannel.eof()
    await expect(eofWaiting).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
  })
})

describe('deferred-start decision', () => {
  it('defers only for a genuine hosted launch with the empty marker path', async () => {
    const { shouldDeferStart } = await import('../src/index.ts')
    expect(shouldDeferStart({ enabled: true, hostAppPath: '' }, undefined, true)).toBe(true)
    // Ordinary enabled deployments fail closed instead of going inert.
    expect(shouldDeferStart({ enabled: true, hostAppPath: '' }, undefined, false)).toBe(false)
    expect(shouldDeferStart({ enabled: true, hostAppPath: '/Applications/DSH Host.app' }, undefined, false)).toBe(false)
    expect(shouldDeferStart({ enabled: false, hostAppPath: '' }, undefined, true)).toBe(false)
  })
})

async function wireFixture(devices?: RemoteDeviceDirectory, channel = new TestWire()) {
  const { allocator, dispose } = await harness()
  disposers.push(dispose)
  const provider = new RemoteHostV3InheritedWireProvider(channel, allocator, devices)
  const control = new AbortController()
  const iterator = provider.accept(control.signal)[Symbol.asyncIterator]()
  const pending = iterator.next()
  void pending.catch(() => {})
  disposers.push(async () => { control.abort(); await pending.catch(() => {}) })
  await expect.poll(() => channel.sent.length).toBe(1)
  return { allocator, provider, channel, control, iterator, pending }
}

function openConnection(connectionId = CONNECTION, changes: Record<string, unknown> = {}) {
  return record('connection.open', {
    connectionId, deviceId: DEVICE, enrollmentId: DEVICE_ENROLLMENT,
    signingPublicKey: SIGNING, agreementPublicKey: AGREEMENT,
    routeId: ROUTE, generation: 1, connectionEpoch: 1, ...changes,
  })
}

async function openedWireFixture(channel = new TestWire()) {
  const fixture = await wireFixture(undefined, channel)
  await create(fixture.allocator)
  await fixture.allocator.beginConnection(DEVICE)
  await fixture.allocator.commitConnection(DEVICE, 1)
  channel.receive(openConnection())
  const opened = await fixture.pending
  if (opened.done) throw new Error('fixture did not accept its committed connection')
  return { ...fixture, connection: opened.value }
}

describe('private-wire parser rejection', () => {
  it.each([
    '[]', '{} trailing', '{"deviceId":"x"} trailing', '{deviceId:1}',
    '{"deviceId" 1}', '{"deviceId":1 "other":2}', '{"deviceId":null}',
    '{"deviceId":1e999}', '{"deviceId":"unterminated', '{"deviceId":"bad\\q"}',
    '{"deviceId":"raw\ncontrol"}', '{"other":"remote_device_0001"}',
    '{"deviceId":0}', ' {} ',
  ])('rejects malformed or nonmatching metadata %j before route mutation', async (metadata) => {
    const { channel, pending, allocator } = await wireFixture()
    channel.receive(recordWithRawMetadata('epoch.begin', metadata))
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
    expect(allocator.list()).toEqual([])
  })

  it.each(['runtime.ready', 'epoch.begun', 'epoch.committed', 'connection.send', 'connection.close', 'device.enrolled', 'epoch.synchronized'] as const)
  ('rejects outbound-only %s arriving from the native peer', async (kind) => {
    const { channel, pending } = await wireFixture()
    channel.receive(record(kind))
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
  })

  it.each(['short-body', 'large-body', 'unknown-kind', 'large-metadata', 'metadata-overrun', 'invalid-utf8'] as const)
  ('rejects %s framing', async (kind) => {
    const { channel, pending } = await wireFixture()
    const bytes = record('epoch.begin', { deviceId: DEVICE })
    const view = new DataView(bytes.buffer)
    if (kind === 'short-body') view.setUint32(0, 2)
    else if (kind === 'large-body') view.setUint32(0, 8 * 1024 * 1024 + 1)
    else if (kind === 'unknown-kind') bytes[4] = 255
    else if (kind === 'large-metadata') view.setUint16(5, 16 * 1024 + 1)
    else if (kind === 'metadata-overrun') view.setUint16(5, bytes.byteLength)
    else bytes[7] = 255
    channel.receive(bytes)
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
  })

  it.each(['', ' ', ' padded', 'x'.repeat(65), 'control\u0000', 0])('rejects invalid enrollment label %j', async (label) => {
    const { channel, pending } = await wireFixture()
    channel.receive(deviceEnroll({ label }))
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
  })

  it.each([0, 'short', '!'.repeat(43)])('rejects invalid public key %j', async (signingPublicKey) => {
    const { channel, pending } = await wireFixture()
    channel.receive(deviceEnroll({ signingPublicKey }))
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
  })

  it.each(['0', 1.5, 0, 2_147_483_648])('rejects invalid route generation %j', async (generation) => {
    const { channel, pending } = await wireFixture()
    channel.receive(record('route.upsert', { ...finalizedEpoch(1), connectionEpoch: undefined, generation }))
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
  })

  it.each(['device.enroll', 'enrollment.seed'] as const)('rejects %s without a trusted device directory', async (kind) => {
    const { channel, pending } = await wireFixture()
    channel.receive(kind === 'device.enroll' ? deviceEnroll() : enrollmentSeed())
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_HELPER_UNAVAILABLE' })
  })

  it.each([
    { label: 'Changed label' }, { signingPublicKey: AGREEMENT }, { agreementPublicKey: SIGNING },
  ])('rejects changed enrollment facts %j without reenrolling', async (changes) => {
    const devices = directoryFixture({ get: () => enrolledDevice(), enroll: vi.fn() })
    const { channel, pending } = await wireFixture(devices)
    channel.receive(deviceEnroll(changes))
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
    expect(devices.enroll).not.toHaveBeenCalled()
  })

  it('preserves exact routes across fragmented prefixes and rejects conflicting upserts', async () => {
    const { channel, pending, allocator } = await wireFixture()
    const bytes = routeUpsert()
    channel.receive(bytes.subarray(0, 2))
    await flushWireDispatcher()
    channel.receive(bytes.subarray(2))
    await expect.poll(() => allocator.list().length).toBe(1)
    channel.receive(routeUpsert())
    await flushWireDispatcher()
    channel.receive(record('route.upsert', { ...finalizedEpoch(1, { routeId: ROUTE_TWO }), connectionEpoch: undefined }))
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
    expect(allocator.get(DEVICE)?.routeId).toBe(ROUTE)
  })

  it.each(['stop', 'stop-metadata', 'unexpected-payload', 'eof', 'close', 'error'] as const)('settles the accept loop after %s', async (kind) => {
    const { channel, pending } = await wireFixture()
    if (kind === 'stop') channel.receive(record('host.stopping'))
    else if (kind === 'stop-metadata') channel.receive(record('host.stopping', {}))
    else if (kind === 'unexpected-payload') channel.receive(record('host.stopping', undefined, new Uint8Array([1])))
    else if (kind === 'eof') channel.eof()
    else if (kind === 'close') channel.emit('close')
    else channel.emit('error', new Error('descriptor failed'))
    await expect(pending).rejects.toMatchObject({
      code: kind === 'stop-metadata' || kind === 'unexpected-payload' ? 'REMOTE_HOST_V3_WIRE_MALFORMED' : 'REMOTE_HOST_V3_WIRE_CLOSED',
    })
    expect(channel.destroyed).toBe(true)
  })
})

describe('private-wire connection termination', () => {
  it('settles a send when its payload size accessor stops the provider during record encoding', async () => {
    const { provider, control, channel } = await openedWireFixture()
    const reservation = provider.reserveConnectionSend()
    const payload = new ObservedBytes(new Uint8Array(), () => { control.abort() })
    const outcomes: unknown[] = []
    const sending = provider.writeConnectionSend(CONNECTION, payload, {
      active: true, generation: 1, abortSignal: new AbortController().signal,
    }, reservation, { active: true, pendingSends: 0 })
    void sending.then(() => { outcomes.push('committed') }, (error: unknown) => { outcomes.push(error) })
    await flushWireDispatcher()
    expect([...outcomes]).toEqual([expect.objectContaining({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })])
    expect(channel.sent).toHaveLength(1)
    expect(channel.destroyed).toBe(true)
  })

  it('does not process an inbound chunk after its size accessor stops the provider', async () => {
    const { channel, allocator, control, pending } = await wireFixture()
    await flushWireDispatcher()
    channel.emit('data', new ObservedBytes(routeUpsert(), () => { control.abort() }))
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
    expect(allocator.list()).toEqual([])
    expect(channel.sent).toHaveLength(1)
  })

  it('settles a local close and its pending reader when the close descriptor write fails', async () => {
    const { channel, connection } = await openedWireFixture()
    const reading = connection.receive(new AbortController().signal)[Symbol.asyncIterator]().next()
    vi.spyOn(channel, '_write').mockImplementationOnce((_chunk, _encoding, callback) => { callback(new Error('close write failed')) })
    await Promise.all([
      expect(connection.close('transport-failed')).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' }),
      expect(reading).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' }),
    ])
    expect(channel.destroyed).toBe(true)
  })

  it('preserves another provider\'s live reservation when asked to release it', async () => {
    const first = await openedWireFixture()
    const second = await openedWireFixture()
    const reservation = second.provider.reserveConnectionSend()
    first.provider.releaseOutboundReservation(reservation)
    expect(reservation.active).toBe(true)
    const payload = new TextEncoder().encode(JSON.stringify({ version: 3, type: 'stream-ack', connectionEpoch: 1, cursor: 0 }))
    await expect(second.provider.writeConnectionSend(CONNECTION, payload, {
      active: true, generation: 1, abortSignal: new AbortController().signal,
    }, reservation, { active: true, pendingSends: 0 })).resolves.toBeUndefined()
    expect(second.channel.sent).toHaveLength(2)
    const available = first.provider.reserveConnectionSend()
    first.provider.releaseOutboundReservation(available)
  })

  it.each(['throw', 'stop', 'enqueue-and-throw'] as const)('contains a queued fence getter that will %s during commit', async (action) => {
    const channel = new SlowTestWire()
    const { provider, connection, control } = await openedWireFixture(channel)
    const write = vi.spyOn(channel, 'write')
    channel.stall()
    const preceding = provider.writeConnectionClose(CONNECTION_TWO, 'transport-failed')
    let failing = false
    const fence = {
      get active() {
        if (failing) {
          if (action === 'stop') control.abort()
          else {
            if (action === 'enqueue-and-throw') void provider.writeConnectionClose(CONNECTION, 'transport-failed').catch(() => {})
            throw new Error('fence failed')
          }
        }
        return true
      },
      generation: 1, abortSignal: new AbortController().signal,
    }
    const outcomes: unknown[] = []
    const sending = connection.send({ version: 3, type: 'stream-ack', connectionEpoch: 1, cursor: 0 }, fence)
    void sending.then((result) => { outcomes.push(result) })
    failing = true
    channel.release()
    await preceding
    try {
      await flushWireDispatcher()
      expect(channel.destroyed).toBe(true)
      expect([...outcomes]).toEqual([{ status: 'not-committed' }])
      expect(write).toHaveBeenCalledOnce()
      await expect(provider.writeConnectionClose(CONNECTION, 'transport-failed')).rejects.toMatchObject({
        code: action === 'stop' ? 'REMOTE_HOST_V3_WIRE_CLOSED' : 'REMOTE_HOST_V3_WIRE_WRITE_FAILED',
      })
    } finally {
      control.abort()
      await sending
    }
  })

  it('does not admit a connection when its durable lookup synchronously stops the gateway', async () => {
    const { allocator, channel, control, pending } = await wireFixture()
    await create(allocator)
    await allocator.beginConnection(DEVICE)
    await allocator.commitConnection(DEVICE, 1)
    await flushWireDispatcher()
    const lookup = allocator.get.bind(allocator)
    vi.spyOn(allocator, 'get').mockImplementation((device) => {
      const route = lookup(device)
      control.abort()
      return route
    })
    channel.receive(openConnection())
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
    await flushWireDispatcher()
    expect(channel.sent).toHaveLength(1)
    expect(channel.destroyed).toBe(true)
  })

  it('tolerates repeated retirement callbacks before and after gateway shutdown', async () => {
    const { provider, connection, control, channel } = await openedWireFixture()
    await connection.close('transport-failed')
    provider.retireConnection(CONNECTION, 'closed', { active: false, pendingSends: 0 })
    expect(channel.destroyed).toBe(false)
    control.abort()
    provider.retireConnection(CONNECTION, 'closed', { active: false, pendingSends: 0 })
    expect(channel.destroyed).toBe(true)
  })

  it('releases capacity when payload serialization synchronously revokes the caller fence', async () => {
    const { channel, connection } = await openedWireFixture()
    const caller = new AbortController()
    const envelope = {
      version: 3 as const, type: 'response' as const, connectionEpoch: 1, requestId: REQUEST,
      result: { ok: true as const, get value() { caller.abort(); return {} } },
    }
    await expect(connection.send(envelope, { active: true, generation: 1, abortSignal: caller.signal }))
      .resolves.toEqual({ status: 'not-committed' })
    expect(channel.sent).toHaveLength(1)
    await expect(connection.send({ ...envelope, result: { ok: true, value: {} } }, {
      active: true, generation: 1, abortSignal: new AbortController().signal,
    })).resolves.toEqual({ status: 'committed-before-fence' })
  })

  it('refuses a queued send whose capacity reservation was released before submission', async () => {
    const { provider, channel } = await openedWireFixture()
    const reservation = provider.reserveConnectionSend()
    provider.releaseOutboundReservation(reservation)
    const lifetime = { active: true, pendingSends: 0 }
    await expect(provider.writeConnectionSend(CONNECTION, new Uint8Array(), {
      active: true, generation: 1, abortSignal: new AbortController().signal,
    }, reservation, lifetime)).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
    expect(lifetime.pendingSends).toBe(0)
    expect(channel.sent).toHaveLength(1)
    const replacement = provider.reserveConnectionSend()
    provider.releaseOutboundReservation(replacement)
  })

  it('ignores a captured data callback after an earlier descriptor listener stops the gateway', async () => {
    const { channel, control, pending, allocator } = await wireFixture()
    await flushWireDispatcher()
    channel.prependOnceListener('data', () => { control.abort() })
    channel.receive(routeUpsert())
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
    expect(allocator.list()).toEqual([])
    expect(channel.sent).toHaveLength(1)
  })

  it.each([0, 1, 2, 3, 4, 5, 6])('observes caller cancellation %i microtasks after descriptor completion', async (depth) => {
    const channel = new CompletionWire()
    const { connection } = await openedWireFixture(channel)
    const caller = new AbortController()
    channel.afterWrite = () => {
      const abortAfter = (remaining: number): void => {
        if (remaining === 0) caller.abort()
        else queueMicrotask(() => { abortAfter(remaining - 1) })
      }
      abortAfter(depth)
    }
    const result = await connection.send({
      version: 3, type: 'response', connectionEpoch: 1, requestId: REQUEST,
      result: { ok: true, value: {} },
    }, { active: true, generation: 1, abortSignal: caller.signal })
    expect(result.status).toBe(depth <= 3 ? 'not-committed' : 'committed-before-fence')
    expect(channel.sent).toHaveLength(2)
  })

  it.each([0, 1, 2, 3, 4])('settles a local close when the gateway stops %i microtasks after descriptor completion', async (depth) => {
    const channel = new CompletionWire()
    const { connection, control } = await openedWireFixture(channel)
    channel.afterWrite = () => {
      const abortAfter = (remaining: number): void => {
        if (remaining === 0) control.abort()
        else queueMicrotask(() => { abortAfter(remaining - 1) })
      }
      abortAfter(depth)
    }
    const closing = connection.close('transport-failed')
    if (depth === 0) await expect(closing).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
    else await expect(closing).resolves.toBeUndefined()
    expect(sent(channel, 1)).toMatchObject({ kind: 'connection.close' })
  })

  it('removes an aborted receive waiter before the next frame reaches a replacement reader', async () => {
    const { channel, connection } = await openedWireFixture()
    const abandoned = new AbortController()
    const first = connection.receive(abandoned.signal)[Symbol.asyncIterator]().next()
    abandoned.abort()
    await expect(first).resolves.toMatchObject({ done: true })

    const replacement = new AbortController()
    const deliveries: unknown[] = []
    const second = connection.receive(replacement.signal)[Symbol.asyncIterator]().next()
    void second.then((value) => { deliveries.push(value) })
    const envelope = { version: 3, type: 'stream-ack', connectionEpoch: 1, cursor: 0 }
    try {
      channel.receive(record('connection.frame', { connectionId: CONNECTION }, new TextEncoder().encode(JSON.stringify(envelope))))
      await flushWireDispatcher()
      expect([...deliveries]).toEqual([{ done: false, value: envelope }])
    } finally {
      replacement.abort()
      await second
    }
  })

  it('initializes the inherited transport only once for repeated accept iterators', async () => {
    const { provider, channel } = await wireFixture()
    await expect(provider.accept(AbortSignal.abort())[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true })
    expect(channel.sent).toHaveLength(1)
  })

  it('fails closed when another send reserves the entire outbound byte budget', async () => {
    const { provider, pending } = await wireFixture()
    const reservation = provider.reserveConnectionSend()
    expect(() => provider.reserveConnectionSend()).toThrow('outbound queue overflowed')
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OVERFLOW' })
    expect(reservation.active).toBe(false)
    provider.releaseOutboundReservation(reservation)
  })

  it('releases reserved capacity when an otherwise valid envelope exceeds the private record budget', async () => {
    const { connection, channel } = await openedWireFixture()
    const value = Array.from({ length: 8 }, () => '')
    const envelope = { version: 3 as const, type: 'response' as const, connectionEpoch: 1, requestId: REQUEST, result: { ok: true as const, value } }
    let remaining = 8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(envelope))
    for (let index = 0; index < value.length; index += 1) {
      const bytes = Math.min(1024 * 1024, remaining)
      value[index] = 'x'.repeat(bytes)
      remaining -= bytes
    }
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBe(8 * 1024 * 1024)
    const fence = { active: true, generation: 1, abortSignal: new AbortController().signal }
    await expect(connection.send(envelope, fence)).resolves.toEqual({ status: 'not-committed' })
    expect(channel.sent).toHaveLength(1)
    await expect(connection.send({ ...envelope, result: { ok: true, value: {} } }, fence))
      .resolves.toEqual({ status: 'committed-before-fence' })
  })

  it('rejects an allocator response that did not reserve its promised epoch', async () => {
    const { allocator, channel, pending } = await wireFixture()
    const route = await create(allocator)
    vi.spyOn(allocator, 'beginConnection').mockResolvedValueOnce(route)
    channel.receive(record('epoch.begin', { deviceId: DEVICE }))
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
    expect(channel.sent).toHaveLength(1)
  })

  it('does not serialize a send after another operation consumed its outbound capacity', async () => {
    const { provider, connection, iterator } = await openedWireFixture()
    provider.reserveConnectionSend()
    const next = iterator.next()
    const envelope = {
      version: 3 as const, type: 'response' as const, connectionEpoch: 1,
      requestId: REQUEST, result: { ok: true as const, value: {} },
    }
    await expect(connection.send(envelope, { active: true, generation: 1, abortSignal: new AbortController().signal }))
      .resolves.toEqual({ status: 'not-committed' })
    await expect(next).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OVERFLOW' })
  })

  it('does not commit a send when its caller aborts while the descriptor write is pending', async () => {
    const channel = new SlowTestWire()
    const { connection } = await openedWireFixture(channel)
    channel.stall()
    const control = new AbortController()
    const sending = connection.send({
      version: 3, type: 'response', connectionEpoch: 1, requestId: REQUEST,
      result: { ok: true, value: {} },
    }, { active: true, generation: 1, abortSignal: control.signal })
    await expect.poll(() => channel.sent.length).toBe(2)
    control.abort()
    channel.release()
    await expect(sending).resolves.toEqual({ status: 'not-committed' })
  })

  it('drains earlier work before settling repeated end notifications', async () => {
    const { allocator, channel, pending } = await wireFixture()
    let finish!: () => void
    const held = new Promise<void>((resolve) => { finish = resolve })
    const createRoute = allocator.create.bind(allocator)
    const createSpy = vi.spyOn(allocator, 'create').mockImplementation(async (input) => { await held; return createRoute(input) })
    channel.receive(routeUpsert())
    await expect.poll(() => createSpy).toHaveBeenCalledOnce()
    channel.emit('end')
    channel.emit('close')
    finish()
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
    expect(allocator.get(DEVICE)?.routeId).toBe(ROUTE)
  })

  it('limits live connections before another connection can be accepted', async () => {
    const { channel, iterator } = await openedWireFixture()
    const pending = iterator.next()
    channel.receive(joinRecords(Array.from({ length: 64 }, (_, index) => openConnection(`remote_connection_${String(index).padStart(4, '0')}`))))
    await pending
    await expect.poll(() => channel.destroyed).toBe(true)
    await expect(iterator.next()).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OVERFLOW' })
  })

  it('bounds unconsumed accepted connections independently of live connection count', async () => {
    const { channel, iterator } = await openedWireFixture()
    channel.receive(joinRecords(Array.from({ length: 65 }, (_, index) => {
      const id = `remote_connection_${String(index).padStart(4, '0')}`
      return joinRecords([openConnection(id), record('connection.closed', { connectionId: id })])
    })))
    await expect.poll(() => channel.sent.length).toBe(2)
    expect(sent(channel, 1)).toMatchObject({ kind: 'connection.close', metadata: { reason: 'protocol-rejected' } })
    channel.eof()
    await expect.poll(() => channel.destroyed).toBe(true)
    await expect(iterator.next()).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
  })

  it('fails closed after too many local closes remain unacknowledged', async () => {
    const { channel, iterator, connection } = await openedWireFixture()
    await connection.close('transport-failed')
    for (let index = 0; index < 64; index += 1) {
      const next = iterator.next()
      channel.receive(openConnection(`remote_connection_${String(index).padStart(4, '0')}`))
      const opened = await next
      if (opened.done) throw new Error('expected admitted connection')
      if (index === 63) {
        await expect(opened.value.close('transport-failed')).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OVERFLOW' })
      } else {
        await opened.value.close('transport-failed')
      }
    }
    expect(channel.destroyed).toBe(true)
  })

  it('bounds peer-close retention when old-lifetime writes are still pending', async () => {
    const channel = new SlowTestWire()
    const { iterator, connection } = await openedWireFixture(channel)
    await connection.close('transport-failed')
    for (let index = 0; index < 63; index += 1) {
      const next = iterator.next()
      channel.receive(openConnection(`remote_connection_${String(index).padStart(4, '0')}`))
      const opened = await next
      if (opened.done) throw new Error('expected admitted connection')
      await opened.value.close('transport-failed')
    }
    const next = iterator.next()
    channel.receive(openConnection(CONNECTION_TWO))
    const opened = await next
    if (opened.done) throw new Error('expected admitted connection')
    channel.stall()
    const sending = opened.value.send({
      version: 3, type: 'response', connectionEpoch: 1, requestId: REQUEST, result: { ok: true, value: {} },
    }, { active: true, generation: 1, abortSignal: new AbortController().signal })
    const stopped = iterator.next()
    channel.receive(record('connection.closed', { connectionId: CONNECTION_TWO }))
    await expect(stopped).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OVERFLOW' })
    await expect(sending).resolves.toEqual({ status: 'not-committed' })
    channel.release()
  })

  it.each([
    { routeId: ROUTE_TWO }, { enrollmentId: DEVICE_TWO_ENROLLMENT },
    { generation: 2 }, { connectionEpoch: 2 }, { deviceId: DEVICE_TWO },
  ])('refuses a connection whose durable facts differ: %j', async (changes) => {
    const { channel, pending, allocator } = await wireFixture()
    await create(allocator)
    await allocator.beginConnection(DEVICE)
    await allocator.commitConnection(DEVICE, 1)
    channel.receive(openConnection(CONNECTION, changes))
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
  })

  it('refuses an open connection while its epoch remains pending', async () => {
    const { channel, pending, allocator } = await wireFixture()
    await create(allocator)
    await allocator.beginConnection(DEVICE)
    channel.receive(openConnection())
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
  })

  it.each(['invalid-utf8', 'wrong-epoch', 'unknown-close', 'duplicate-open'] as const)('terminates on %s', async (kind) => {
    const { channel, iterator } = await openedWireFixture()
    const pending = iterator.next()
    if (kind === 'duplicate-open') channel.receive(openConnection())
    else if (kind === 'unknown-close') channel.receive(record('connection.closed', { connectionId: CONNECTION_TWO }))
    else channel.receive(record('connection.frame', { connectionId: CONNECTION }, kind === 'invalid-utf8'
      ? new Uint8Array([255])
      : new TextEncoder().encode(JSON.stringify({ version: 3, type: 'stream-ack', connectionEpoch: 2, cursor: 0 }))))
    await expect(pending).rejects.toMatchObject({ code: kind === 'invalid-utf8' ? 'REMOTE_HOST_V3_WIRE_MALFORMED' : 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER' })
  })

  it('cancels a waiting receive without delivering another frame', async () => {
    const { connection } = await openedWireFixture()
    const control = new AbortController()
    const iterator = connection.receive(control.signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    control.abort()
    await expect(next).resolves.toMatchObject({ done: true })
    await expect(connection.receive(AbortSignal.abort())[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true })
    await connection.close('transport-failed')
    await connection.close('transport-failed')
  })

  it('rejects sends after local cancellation and terminal reservations after shutdown', async () => {
    const { connection, provider, control, iterator } = await openedWireFixture()
    const envelope = { version: 3 as const, type: 'response' as const, connectionEpoch: 1, requestId: REQUEST, result: { ok: true as const, value: {} } }
    await expect(connection.send(envelope, { active: false, generation: 1, abortSignal: new AbortController().signal }))
      .resolves.toEqual({ status: 'not-committed' })
    await expect(connection.send(envelope, { active: true, generation: 1, abortSignal: AbortSignal.abort() }))
      .resolves.toEqual({ status: 'not-committed' })
    const pending = iterator.next()
    control.abort()
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
    expect(() => provider.reserveConnectionSend()).toThrow('Gateway stopped')
    await expect(provider.writeConnectionClose(CONNECTION, 'transport-failed')).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
    await expect(provider.accept(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
  })

  it('settles startup when the inherited descriptor write callback fails', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    vi.spyOn(channel, 'write').mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1)
      if (typeof callback !== 'function') throw new Error('write callback missing')
      const complete = callback as (error: Error) => void
      complete(new Error('write failed'))
      return false
    })
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator)
    await expect(provider.accept(new AbortController().signal)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_WRITE_FAILED' })
    expect(channel.destroyed).toBe(true)
  })

  it('contains a storage failure and closes the inherited descriptor', async () => {
    const { channel, allocator, pending } = await wireFixture()
    vi.spyOn(allocator, 'create').mockRejectedValueOnce(new Error('storage failed'))
    channel.receive(routeUpsert())
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_MALFORMED' })
    expect(channel.destroyed).toBe(true)
  })
})
