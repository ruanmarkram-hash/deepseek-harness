/** Built-artifact smoke: native epoch wire, durable JSON reload, frame ingress and response egress. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { Context } from '../vendor/cordis/lib/index.js'
import Storage, { storageBackendServiceKey } from '../packages/storage/storage/lib/index.js'
import { JsonStorageBackend } from '../packages/storage/storage-json/lib/index.js'
import { DomainFacility } from '../packages/storage/storage-domain/lib/index.js'
import { RemoteDeviceDirectory, REMOTE_DEVICE_DOMAIN } from '../packages/mobile/remote-devices/lib/index.js'
import { RemoteHostV3RouteAllocator, RemoteHostV3InheritedWireProvider, REMOTE_HOST_V3_DOMAIN } from '../packages/mobile/remote-host-v3/lib/index.js'

const temp = await mkdtemp(join(tmpdir(), 'dsh-epoch-smoke-'))
const facts = { routeId: 'smoke_route_00001', deviceId: 'smoke_device_001', deviceEnrollmentId: 'smoke_device_enr1',
  hostDeviceId: 'smoke_host_000001', hostEnrollmentId: 'smoke_host_enr001', generation: 1 }
const seed = { deviceId: facts.deviceId, label: 'Smoke phone', signingPublicKey: Buffer.alloc(32, 1).toString('base64url'),
  agreementPublicKey: Buffer.alloc(32, 2).toString('base64url'), deviceEnrollmentId: facts.deviceEnrollmentId, hostEnrollmentId: facts.hostEnrollmentId }
function encode(kind, metadata, payload = Buffer.alloc(0)) {
  const data = Buffer.from(JSON.stringify(metadata))
  const frame = Buffer.alloc(7 + data.length + payload.length)
  frame.writeUInt32BE(frame.length - 4); frame[4] = kind; frame.writeUInt16BE(data.length, 5)
  data.copy(frame, 7); payload.copy(frame, 7 + data.length)
  return frame
}
function decode(frame) {
  const size = frame.readUInt16BE(5)
  return { kind: frame[4], metadata: JSON.parse(frame.subarray(7, 7 + size).toString()), payload: frame.subarray(7 + size) }
}
class Wire extends Duplex {
  sent = []
  _read() {}
  _write(frame, _encoding, callback) { this.sent.push(Buffer.from(frame)); callback() }
}
async function until(test) {
  const deadline = Date.now() + 2000
  while (!test()) {
    assert.ok(Date.now() < deadline, 'built wire smoke timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
async function run(epoch, expectedPrevious) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(temp)
  ctx.storage.backend.register('json', backend)
  const unprovide = ctx.provide(storageBackendServiceKey('json'), backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const deviceDomain = await facility.open(REMOTE_DEVICE_DOMAIN)
  const routeDomain = await facility.open(REMOTE_HOST_V3_DOMAIN)
  const devices = new RemoteDeviceDirectory(ctx, deviceDomain.table('devices'))
  const allocator = new RemoteHostV3RouteAllocator(routeDomain.table('routes'), routeDomain.table('host'))
  assert.equal(allocator.get(facts.deviceId)?.lastConnectionEpoch ?? 0, expectedPrevious)
  const wire = new Wire()
  const provider = new RemoteHostV3InheritedWireProvider(wire, allocator, devices, true)
  const abort = new AbortController()
  const accepted = provider.accept(abort.signal)[Symbol.asyncIterator]().next()
  void accepted.catch(() => {})
  try {
    await until(() => wire.sent.length === 1)
    wire.push(encode(16, seed)); wire.push(encode(2, facts))
    wire.push(encode(17, { ...facts, connectionEpoch: epoch }))
    await until(() => wire.sent.length === 2)
    assert.deepEqual(decode(wire.sent[1]), { kind: 18, metadata: { ...facts, connectionEpoch: epoch }, payload: Buffer.alloc(0) })
    assert.equal(allocator.get(facts.deviceId).lastConnectionEpoch, epoch)
    const connectionId = 'smoke_connection01'
    wire.push(encode(8, { connectionId, deviceId: facts.deviceId, enrollmentId: facts.deviceEnrollmentId,
      signingPublicKey: seed.signingPublicKey, agreementPublicKey: seed.agreementPublicKey,
      routeId: facts.routeId, generation: 1, connectionEpoch: epoch }))
    const connection = (await accepted).value
    assert.ok(connection)
    const request = { version: 3, type: 'request', connectionEpoch: epoch, requestId: 'smoke_request001',
      idempotencyKey: 'smoke_idempotency01', method: 'host.describe', payload: {} }
    wire.push(encode(9, { connectionId }, Buffer.from(JSON.stringify(request))))
    const received = (await connection.receive(abort.signal)[Symbol.asyncIterator]().next()).value
    assert.deepEqual(JSON.parse(JSON.stringify(received)), request)
    const response = { version: 3, type: 'response', connectionEpoch: epoch, requestId: request.requestId, result: { ok: true, value: {} } }
    assert.deepEqual(await connection.send(response, { active: true, generation: 1, abortSignal: abort.signal }), { status: 'committed-before-fence' })
    await until(() => wire.sent.length === 3)
    assert.deepEqual(JSON.parse(decode(wire.sent[2]).payload.toString()), response)
    assert.equal(decode(wire.sent[2]).kind, 11)
  } finally {
    abort.abort()
    await accepted.catch(() => {})
    await deviceDomain.close(); await routeDomain.close(); await backend.close(); unprovide()
  }
}
try {
  await run(1, 0)
  await run(1, 1) // Lost receipt/restart, same finalized epoch, no counter bump.
  await run(4, 1) // Native progressed while the old child was unavailable.
  console.log('PASS: built native epoch wire, JSON reload, idempotent retry, forward progress, frame ingress and response egress')
} finally { await rm(temp, { recursive: true, force: true }) }
