/** Integration checks for the sealed in-process FD198 DSH composition. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Duplex } from 'node:stream'
import type { ApiProxy } from '../../../packages/host/apiproxy/src/api/index.ts'
import { RemoteHostV3InheritedWireProvider } from '../../../packages/mobile/remote-host-v3/src/remote-wire.ts'
import type { RemoteDeviceDirectory, RemoteDeviceId, RemoteDeviceIncarnation, RemoteDeviceRecord } from '../../../packages/mobile/remote-devices/src/types.ts'
import type { RemoteHostV3Route } from '../../../packages/mobile/remote-host-v3/src/types.ts'
import type { RemoteWireId } from '../../../packages/mobile/remote-wire/src/types.ts'
import { SEALED_HOST_DSH_OWNERSHIP, internals, type SealedHostDshServices } from './host-owned-dsh-runtime.ts'
import { createStaticHostDshServices, SealedHostDshCompositionUnavailableError, internals as staticServices } from './static-host-dsh-services.ts'
import { SEALED_DSH_SERVICE_GRAPH, type SealedDshServiceCore } from './sealed-dsh-service-graph.ts'

const DEVICE = 'remote_device_0001' as RemoteDeviceId
const ENROLLMENT = 'host_enrollment_001' as RemoteDeviceIncarnation
const ROUTE = 'remote_route_000001'
const CONNECTION = 'remote_connection_001'
const SIGNING = Buffer.from(new Uint8Array(32).fill(1)).toString('base64url')
const AGREEMENT = Buffer.from(new Uint8Array(32).fill(2)).toString('base64url')
const NOW = '2026-08-21T00:00:00.000Z'

const KIND = {
  'runtime.ready': 1,
  'route.upsert': 2,
  'epoch.begin': 4,
  'epoch.commit': 6,
  'connection.open': 8,
  'connection.frame': 9,
  'connection.send': 11,
} as const

type Kind = keyof typeof KIND

class TestWire extends Duplex {
  readonly sent: Buffer[] = []
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sent.push(Buffer.from(chunk))
    callback()
  }
  receive(value: Uint8Array): void { this.push(Buffer.from(value)) }
}

function record(kind: Kind, metadata: Record<string, unknown> = {}, payload = new Uint8Array()): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(metadata))
  const result = new Uint8Array(7 + json.byteLength + payload.byteLength)
  new DataView(result.buffer).setUint32(0, 3 + json.byteLength + payload.byteLength)
  result[4] = KIND[kind]
  new DataView(result.buffer).setUint16(5, json.byteLength)
  result.set(json, 7)
  result.set(payload, 7 + json.byteLength)
  return result
}

function sent(wire: TestWire, index: number): { readonly kind: number; readonly metadata: Record<string, unknown>; readonly payload: Uint8Array } {
  const value = wire.sent[index]
  assert.ok(value)
  const metadataLength = value.readUInt16BE(5)
  return {
    kind: value[4] as number,
    metadata: metadataLength === 0 ? {} : JSON.parse(value.subarray(7, 7 + metadataLength).toString('utf8')) as Record<string, unknown>,
    payload: value.subarray(7 + metadataLength),
  }
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('condition did not settle')
}

function services(): SealedHostDshServices {
  let route: RemoteHostV3Route | undefined
  const device: RemoteDeviceRecord = {
    id: DEVICE,
    incarnation: ENROLLMENT,
    label: 'Phone',
    signingPublicKey: SIGNING,
    agreementPublicKey: AGREEMENT,
    enrolledAt: NOW,
  }
  const allocator = {
    async hostEnrollmentId(): Promise<string> { return 'host_enrollment_001' },
    get(deviceId: RemoteDeviceId): RemoteHostV3Route | undefined { return deviceId === DEVICE ? route : undefined },
    async create(input: Omit<RemoteHostV3Route, 'generation' | 'lastConnectionEpoch' | 'pendingConnectionEpoch' | 'createdAt'> & { readonly generation: number }): Promise<RemoteHostV3Route> {
      route = { ...input, lastConnectionEpoch: 0, createdAt: NOW }
      return route
    },
    async beginConnection(deviceId: RemoteDeviceId): Promise<RemoteHostV3Route> {
      assert.equal(deviceId, DEVICE)
      assert.ok(route)
      route = { ...route, pendingConnectionEpoch: 1 }
      return route
    },
    async commitConnection(deviceId: RemoteDeviceId, connectionEpoch: number): Promise<RemoteHostV3Route> {
      assert.equal(deviceId, DEVICE)
      assert.equal(connectionEpoch, 1)
      assert.ok(route)
      const { pendingConnectionEpoch: _pendingConnectionEpoch, ...committed } = route
      route = { ...committed, lastConnectionEpoch: connectionEpoch }
      return route
    },
    async remove(deviceId: RemoteDeviceId): Promise<RemoteHostV3Route | undefined> {
      assert.equal(deviceId, DEVICE)
      const removed = route
      route = undefined
      return removed
    },
  }
  const remoteDevices = {
    get: (deviceId: RemoteDeviceId) => deviceId === DEVICE ? device : undefined,
    markSeen: async () => device,
  } as unknown as RemoteDeviceDirectory
  const list = async (request: { readonly rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true as const, value: { sessions: [] } } })
  const empty = async function* (): AsyncIterable<never> {}
  return {
    apiProxy: {
      sessions: { list },
      events: { mux: empty, host: empty },
    } as unknown as ApiProxy,
    remoteDevices,
    routeAllocator: allocator,
    now: () => NOW,
    newId: () => 'gateway_event_0001' as RemoteWireId,
    audit: () => {},
  }
}

test('sealed runtime composes the existing FD198 provider with RemoteGateway and correlates a v3 response', async () => {
  const wire = new TestWire()
  const service = services()
  const provider = new RemoteHostV3InheritedWireProvider(wire, service.routeAllocator, service.remoteDevices)
  const runtime = internals.startWithInheritedPipe(service, provider)
  await eventually(() => wire.sent.length === 1)
  assert.equal(sent(wire, 0).kind, KIND['runtime.ready'])

  wire.receive(record('route.upsert', {
    routeId: ROUTE, deviceId: DEVICE, deviceEnrollmentId: ENROLLMENT,
    hostDeviceId: 'host_device_000001', hostEnrollmentId: 'host_enrollment_001', generation: 1,
  }))
  wire.receive(record('epoch.begin', { deviceId: DEVICE }))
  wire.receive(record('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 }))
  wire.receive(record('connection.open', {
    connectionId: CONNECTION, deviceId: DEVICE, enrollmentId: ENROLLMENT,
    signingPublicKey: SIGNING, agreementPublicKey: AGREEMENT, routeId: ROUTE, generation: 1, connectionEpoch: 1,
  }))
  wire.receive(record('connection.frame', { connectionId: CONNECTION }, new TextEncoder().encode(JSON.stringify({
    version: 3, type: 'request', connectionEpoch: 1, requestId: 'remote_request_0001',
    idempotencyKey: 'remote_retry_00001', method: 'session.list', payload: {},
  }))))

  await eventually(() => wire.sent.length === 4)
  const response = sent(wire, 3)
  assert.equal(response.kind, KIND['connection.send'])
  assert.deepEqual(response.metadata, { connectionId: CONNECTION })
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response.payload)), {
    version: 3,
    type: 'response',
    connectionEpoch: 1,
    requestId: 'remote_request_0001',
    result: { ok: true, value: { sessions: [] } },
  })
  await runtime.stop()
})

test('static composition owns a separate locked durable store and never needs the Web runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sealed-host-'))
  try {
    const receivedRoots: string[] = []
    const core: SealedDshServiceCore = {
      composition: SEALED_DSH_SERVICE_GRAPH.composition,
      async createApiProxy(storage) { receivedRoots.push(storage.sessionsRoot); return services().apiProxy },
      async dispose() {},
    }
    const first = await staticServices.createServices(root, core)
    await assert.rejects(staticServices.createServices(root, core), SealedHostDshCompositionUnavailableError)
    assert.equal(receivedRoots.length, 1)
    assert.equal(receivedRoots[0], join(root, 'sessions'))
    await first.dispose()
    const second = await staticServices.createServices(root, core)
    await second.dispose()
    await assert.rejects(createStaticHostDshServices(), SealedHostDshCompositionUnavailableError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  assert.deepEqual(SEALED_HOST_DSH_OWNERSHIP, {
    persistence: 'signed-host-runtime-only',
    configuration: 'statically-composed-only',
    userPatchLayers: false,
    environmentConfiguration: false,
    localhostCarrier: false,
  })
})
