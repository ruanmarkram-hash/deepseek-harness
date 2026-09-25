import assert from 'node:assert/strict'
import test from 'node:test'
import { FixedSessionGateway } from './fixed-session-gateway.ts'

const CONNECTION = 'connection_1234567890'
const DEVICE = 'device_1234567890'
const ENROLLMENT = 'enrollment_1234567890'
const ROUTE = 'route_1234567890'
const REQUEST = 'request_1234567890'
const RETRY = 'retry_123456789012'
const KEY = Buffer.alloc(32, 9).toString('base64url')
const text = new TextEncoder()
const decode = new TextDecoder()
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

interface Record { readonly kind: number; readonly metadata: Uint8Array; readonly payload: Uint8Array }

function native(kind: number, metadata: object, payload: object | undefined = undefined): Record {
  return { kind, metadata: text.encode(JSON.stringify(metadata)), payload: payload === undefined ? new Uint8Array() : text.encode(JSON.stringify(payload)) }
}

function open(): Record {
  return native(8, { connectionId: CONNECTION, deviceId: DEVICE, enrollmentId: ENROLLMENT, signingPublicKey: KEY, agreementPublicKey: KEY, routeId: ROUTE, generation: 1, connectionEpoch: 7 })
}

class MemoryPort {
  readonly records: Record[] = []
  write(record: Record): void { this.records.push(record) }
}

class MemoryCarrier {
  readonly kind = 'native-attested-private-carrier' as const
  readonly calls: Array<{ path: string; body: unknown }> = []
  readonly subscribers: Array<(value: Json) => void> = []
  async post(path: string, body: Json): Promise<Json> { this.calls.push({ path, body }); throw new Error('override post') }
  subscribe(_path: string, message: (value: Json) => void, _end: () => void): () => void { this.subscribers.push(message); return () => {} }
}

function sent(port: MemoryPort): object[] {
  return port.records.filter(record => record.kind === 11).map(record => JSON.parse(decode.decode(record.payload)) as object)
}

test('correlates the exact v3 session request and reuses a matching idempotency result', async () => {
  const port = new MemoryPort()
  const carrier = new MemoryCarrier()
  carrier.post = async (path, body) => {
    carrier.calls.push({ path, body })
    return { type: 'server-response', rpcId: REQUEST, result: { ok: true, value: [{ id: 'session_1234567890' }] } } as never
  }
  const gateway = new FixedSessionGateway(port, carrier)
  await gateway.receive(open())
  const request = { version: 3, type: 'request', connectionEpoch: 7, requestId: REQUEST, idempotencyKey: RETRY, method: 'session.list', payload: {} }
  await gateway.receive(native(9, { connectionId: CONNECTION }, request))
  await gateway.receive(native(9, { connectionId: CONNECTION }, request))
  assert.equal(JSON.stringify(carrier.calls), JSON.stringify([{ path: '/api/session.list', body: { type: 'client-request', rpcId: REQUEST, method: 'session.list', payload: {} } }]))
  assert.deepEqual(sent(port), [
    { version: 3, type: 'response', connectionEpoch: 7, requestId: REQUEST, result: { ok: true, value: [{ id: 'session_1234567890' }] } },
    { version: 3, type: 'response', connectionEpoch: 7, requestId: REQUEST, result: { ok: true, value: [{ id: 'session_1234567890' }] } },
  ])
})

test('routes an approval through the exact pending-host response correlation', async () => {
  const port = new MemoryPort()
  const carrier = new MemoryCarrier()
  carrier.post = async (path, body) => {
    carrier.calls.push({ path, body })
    return { accepted: true } as never
  }
  const gateway = new FixedSessionGateway(port, carrier)
  await gateway.receive(open())
  await gateway.receive(native(9, { connectionId: CONNECTION }, {
    version: 3, type: 'approval', connectionEpoch: 7, requestId: REQUEST, idempotencyKey: RETRY,
    sessionId: 'session_1234567890', approvalId: 'approval_123456789', outcome: 'allowed-once',
  }))
  assert.deepEqual(carrier.calls, [{ path: '/api/respond', body: { type: 'client-response', rpcId: REQUEST, result: { ok: true, value: { sessionId: 'session_1234567890', approvalId: 'approval_123456789', outcome: 'allowed-once' } } } }])
  assert.deepEqual(sent(port), [{ version: 3, type: 'response', connectionEpoch: 7, requestId: REQUEST, result: { ok: true, value: { accepted: true } } }])
})

test('forwards only allowlisted host events under a fresh v3 cursor', async () => {
  const port = new MemoryPort()
  const carrier = new MemoryCarrier()
  const gateway = new FixedSessionGateway(port, carrier)
  await gateway.receive(open())
  carrier.subscribers[0]?.({ type: 'server-request', rpcId: REQUEST, method: 'approval/requested', payload: { type: 'approval/requested', sessionId: 'session_1234567890', approvalId: 'approval_123456789', toolName: 'bash' } })
  await new Promise(resolve => setImmediate(resolve))
  const envelope = sent(port)[0] as { type: string; connectionEpoch: number; cursor: number; requestId: string; event: string; payload: object }
  assert.equal(envelope.type, 'event')
  assert.equal(envelope.connectionEpoch, 7)
  assert.equal(envelope.cursor, 1)
  assert.equal(envelope.requestId, REQUEST)
  assert.equal(envelope.event, 'approval/requested')
})

test('fails closed on a non-session remote method', async () => {
  const port = new MemoryPort()
  const gateway = new FixedSessionGateway(port, new MemoryCarrier())
  await gateway.receive(open())
  await gateway.receive(native(9, { connectionId: CONNECTION }, { version: 3, type: 'request', connectionEpoch: 7, requestId: REQUEST, idempotencyKey: RETRY, method: 'workspace.delete', payload: {} }))
  assert.equal(port.records.at(-1)?.kind, 12)
})

test('never writes an outbound FD record that exceeds the complete record bound', async () => {
  const port = new MemoryPort()
  const carrier = new MemoryCarrier()
  const gateway = new FixedSessionGateway(port, carrier)
  await gateway.receive(open())
  const almostFullPayload = Array.from({ length: 8 }, () => 'x'.repeat(1_048_550))
  carrier.subscribers[0]?.({ type: 'server-request', rpcId: REQUEST, method: 'session/event', payload: { type: 'session/event', data: almostFullPayload } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(port.records.some(record => record.kind === 11), false)
  assert.equal(port.records.at(-1)?.kind, 12)
})
