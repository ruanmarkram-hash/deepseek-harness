import { afterEach, describe, expect, it, vi } from 'vitest'
import { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { RemoteDeviceDirectory, RemoteDeviceId, RemoteDeviceIncarnation, RemoteDeviceRecord } from '@deepseek-ai/dsh-remote-devices'
import type { RemoteWireId } from '@deepseek-ai/dsh-remote-wire'
import { RemoteGateway } from '@deepseek-ai/dsh-remote-gateway'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
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

function sent(channel: TestWire, index: number): { readonly kind: WireKind; readonly metadata: Record<string, unknown>; readonly payload: Uint8Array } {
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
  const devices = { get: () => undefined } as unknown as RemoteDeviceDirectory

  it('hands only a signed Host-app inherited transport to the generic gateway', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const serve = vi.fn(async () => {})
    const native = {
      hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
      runtimePipe: pipe,
    } satisfies RemoteHostV3NativeProvider
    const controller = new RemoteHostV3Controller({ remoteGateway: { serve } } as unknown as Context, allocator, devices, native, {
      enabled: true,
      hostAppPath: native.hostAppPath,
    })

    await controller.start()
    expect(serve).toHaveBeenCalledWith(pipe, expect.any(AbortSignal))
    await controller.dispose()
  })

  it('rejects a missing Host-app handoff before starting the gateway', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const serve = vi.fn(async () => {})
    const controller = new RemoteHostV3Controller({ remoteGateway: { serve } } as unknown as Context, allocator, devices, undefined, {
      enabled: true,
      hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
    })

    expect(() => controller.start()).toThrow()
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
    const controller = new RemoteHostV3Controller({ remoteGateway: { serve } } as unknown as Context, allocator, devices, native, {
      enabled: true,
      hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
    })

    expect(() => controller.start()).toThrow()
    expect(serve).not.toHaveBeenCalled()
  })

  it('serves a deferred activated handoff exactly once and rejects repeat or stopped attaches', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const serve = vi.fn(async () => {})
    const controller = new RemoteHostV3Controller({ remoteGateway: { serve } } as unknown as Context, allocator, devices, undefined, {
      enabled: true,
      hostAppPath: '',
    })
    const activated = (hostAppPath: string) => ({
      hostAppPath,
      runtimePipe: pipe,
    }) satisfies RemoteHostV3NativeProvider

    controller.startWithNative(activated('/Applications/DSH Host.app/Contents/MacOS/DSH Host'))
    expect(serve).toHaveBeenCalledTimes(1)
    expect(() => controller.startWithNative(activated('/Applications/DSH Host.app/Contents/MacOS/DSH Host')))
      .toThrow()
    controller.dispose()
    expect(() => controller.startWithNative(activated('/Applications/DSH Host.app/Contents/MacOS/DSH Host')))
      .toThrow()
  })

  it('rejects a deferred handoff with an invalid path or pipe kind', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const serve = vi.fn(async () => {})
    const controller = new RemoteHostV3Controller({ remoteGateway: { serve } } as unknown as Context, allocator, devices, undefined, {
      enabled: true,
      hostAppPath: '',
    })

    expect(() => controller.startWithNative({ hostAppPath: 'relative/Host', runtimePipe: pipe }))
      .toThrow()
    expect(() => controller.startWithNative({
      hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
      runtimePipe: { ...pipe, kind: 'loopback-proxy' as never },
    })).toThrow()
    expect(serve).not.toHaveBeenCalled()
  })

  it('rejects a deferred handoff on a disabled composition', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const controller = new RemoteHostV3Controller({} as unknown as Context, allocator, devices, undefined, {
      enabled: false,
      hostAppPath: '',
    })

    expect(() => controller.startWithNative({ hostAppPath: '/Host', runtimePipe: pipe }))
      .toThrow()
  })

  it('builds the inherited native provider from fixed descriptor facts and an injected test pipe', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const controller = new RemoteHostV3Controller({} as unknown as Context, allocator, devices, undefined, {
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
    const directory = {
      get: vi.fn<RemoteDeviceDirectory['get']>(() => device),
      markSeen: vi.fn<RemoteDeviceDirectory['markSeen']>(async () => device),
    } as unknown as RemoteDeviceDirectory
    const list = vi.fn(async (request: { readonly rpcId: string }) => ({
      rpcId: request.rpcId,
      result: { ok: true as const, value: { sessions: [] } },
    }))
    const gateway = new RemoteGateway({
      api: {
        sessions: { list },
        events: {
          mux: async function* () {},
          host: async function* () {},
        },
      } as unknown as ApiProxy,
      devices: directory,
      now: () => NOW,
      newId: () => REQUEST,
      audit: () => {},
    }, { maxIdempotencyEntriesPerDevice: 2, maxEventEntriesPerDevice: 2 })
    const provider = new RemoteHostV3InheritedWireProvider(channel, allocator, directory)
    const abort = new AbortController()
    const serving = gateway.serve(provider, abort.signal).catch(error => error)
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
    channel.receive(record('connection.frame', { connectionId: CONNECTION }, new TextEncoder().encode(JSON.stringify({
      version: 3,
      type: 'request',
      connectionEpoch: 1,
      requestId: REQUEST,
      idempotencyKey: 'remote_idempotency1',
      method: 'session.list',
      payload: {},
    }))))

    await expect.poll(() => channel.sent.length).toBe(4)
    expect(directory.markSeen).toHaveBeenCalledWith(DEVICE, NOW)
    expect(list).toHaveBeenCalledOnce()
    expect(sent(channel, 1)).toMatchObject({ kind: 'epoch.begun', metadata: { deviceId: DEVICE, routeId: ROUTE, generation: 1, connectionEpoch: 1 } })
    expect(sent(channel, 2)).toMatchObject({ kind: 'epoch.committed', metadata: { deviceId: DEVICE, routeId: ROUTE, generation: 1, connectionEpoch: 1 } })
    expect(sent(channel, 3)).toMatchObject({ kind: 'connection.send', metadata: { connectionId: CONNECTION } })
    expect(JSON.parse(new TextDecoder().decode(sent(channel, 3).payload))).toMatchObject({ type: 'response', connectionEpoch: 1, requestId: REQUEST, result: { ok: true, value: { sessions: [] } } })
    expect(JSON.stringify(channel.sent)).not.toMatch(/token|private|secret/i)

    abort.abort()
    await expect(serving).resolves.toMatchObject({ code: 'REMOTE_HOST_V3_WIRE_CLOSED' })
    await gateway.dispose()
  })

  it('persists a locally-confirmed public device tuple and returns only public enrollment facts', async () => {
    const { allocator, dispose } = await harness()
    disposers.push(dispose)
    const channel = new TestWire()
    const device = enrolledDevice()
    const devices = {
      get: vi.fn<RemoteDeviceDirectory['get']>(() => undefined),
      enroll: vi.fn<RemoteDeviceDirectory['enroll']>(async input => {
        expect(input).toEqual({ id: DEVICE, label: 'Ruan’s iPhone', signingPublicKey: SIGNING, agreementPublicKey: AGREEMENT })
        return device
      }),
    } as unknown as RemoteDeviceDirectory
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
    const devices = { get: vi.fn(), enroll: vi.fn() } as unknown as RemoteDeviceDirectory
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
    const devices = {
      get: vi.fn<RemoteDeviceDirectory['get']>(() => device),
      enroll: vi.fn<RemoteDeviceDirectory['enroll']>(),
    } as unknown as RemoteDeviceDirectory
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
    const devices = { get: vi.fn(), seed: vi.fn(), enroll: vi.fn() } as unknown as RemoteDeviceDirectory
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
    const devices = {
      get: vi.fn<RemoteDeviceDirectory['get']>(() => device),
      seed: vi.fn<RemoteDeviceDirectory['seed']>(async (input, incarnation) => {
        expect(input).toEqual({ id: DEVICE, label: 'Ruan’s iPhone', signingPublicKey: SIGNING, agreementPublicKey: AGREEMENT })
        expect(incarnation).toBe(DEVICE_ENROLLMENT)
        return device
      }),
      enroll: vi.fn<RemoteDeviceDirectory['enroll']>(),
    } as unknown as RemoteDeviceDirectory
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
