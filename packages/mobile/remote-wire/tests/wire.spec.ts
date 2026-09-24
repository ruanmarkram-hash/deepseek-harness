import { describe, expect, it } from 'vitest'
import {
  MAX_REMOTE_WIRE_PAYLOAD_BYTES,
  MAX_REMOTE_WIRE_STRING_BYTES,
  MAX_REMOTE_WIRE_JSON_ITEMS,
  RemoteWireError,
  isRemoteWireError,
  parseRemoteWireId,
  parseRemoteWireEnvelope,
  parseRemoteWireJson,
  serializeRemoteWireEnvelope,
} from '@deepseek-ai/dsh-remote-wire'

const ID = 'remote_identifier_123'
const IDEM = 'idempotency_key_123'

it('checks final serialized bytes even when an unknown JS payload changes its JSON representation', () => {
  let calls = 0
  const payload: unknown[] = []
  Object.defineProperty(payload, 'map', { value: () => ({
    toJSON(): string {
      calls += 1
      return calls >= 3 ? 'x'.repeat(MAX_REMOTE_WIRE_PAYLOAD_BYTES + 1) : 'x'
    },
  }) })
  expect(() => serializeRemoteWireEnvelope(request({ payload }))).toThrow('REMOTE_WIRE_PAYLOAD_TOO_LARGE')
  expect(calls).toBe(3)
})

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    type: 'request',
    connectionEpoch: 7,
    requestId: ID,
    idempotencyKey: IDEM,
    method: 'session.prompt',
    payload: { sessionId: ID, mode: 'queue', content: [{ type: 'text', text: 'ship' }] },
    ...overrides,
  }
}

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteWireError)
    return (error as RemoteWireError).code
  }
  throw new Error('Expected remote wire rejection')
}

describe('trusted remote v3 envelopes', () => {
  it('keeps error identity and rejects invalid scalars and non-JSON values', () => {
    expect(isRemoteWireError(new RemoteWireError('REMOTE_WIRE_MALFORMED'))).toBe(true)
    expect(isRemoteWireError(new Error('REMOTE_WIRE_MALFORMED'))).toBe(false)
    for (const id of [undefined, 1, 'x'.repeat(MAX_REMOTE_WIRE_STRING_BYTES * 2 + 1), '界'.repeat(MAX_REMOTE_WIRE_STRING_BYTES)]) {
      expect(code(() => parseRemoteWireId(id))).toBe('REMOTE_WIRE_ID_INVALID')
    }
    for (const value of [NaN, Infinity, undefined, () => {}, Symbol('invalid'), Array(MAX_REMOTE_WIRE_JSON_ITEMS + 1).fill(null), Object.fromEntries(Array.from({ length: MAX_REMOTE_WIRE_JSON_ITEMS + 1 }, (_, index) => [String(index), null]))]) {
      expect(code(() => parseRemoteWireEnvelope(request({ payload: value })))).toBe('REMOTE_WIRE_PAYLOAD_INVALID')
    }
    expect(parseRemoteWireEnvelope(request({ payload: [null, true, false, 1, 'value'] }))).toMatchObject({ payload: [null, true, false, 1, 'value'] })
    expect(code(() => parseRemoteWireEnvelope(request({ payload: Array(9).fill('x'.repeat(MAX_REMOTE_WIRE_STRING_BYTES)) })))).toBe('REMOTE_WIRE_PAYLOAD_TOO_LARGE')
    for (const value of [null, [], { version: 3 }, { version: 3, type: 'future' }]) {
      expect(code(() => parseRemoteWireEnvelope(value))).toBe(value && !Array.isArray(value) && 'type' in value ? 'REMOTE_WIRE_UNKNOWN_TYPE' : 'REMOTE_WIRE_MALFORMED')
    }
    for (const value of [undefined, 'x'.repeat(MAX_REMOTE_WIRE_PAYLOAD_BYTES * 2 + 1)]) {
      expect(code(() => parseRemoteWireJson(value))).toBe('REMOTE_WIRE_PAYLOAD_INVALID')
    }
    expect(code(() => parseRemoteWireJson('{'))).toBe('REMOTE_WIRE_MALFORMED')
    expect(code(() => parseRemoteWireJson('{}'))).toBe('REMOTE_WIRE_MALFORMED')
    expect(code(() => parseRemoteWireEnvelope(request({ connectionEpoch: -1 })))).toBe('REMOTE_WIRE_EPOCH_INVALID')
  })

  it('rejects extra fields on every envelope and invalid response union members', () => {
    const base = { version: 3, connectionEpoch: 7, requestId: ID }
    const envelopes = [
      { ...base, type: 'response', result: { ok: true, value: null } },
      { ...base, type: 'event', cursor: 0, eventId: ID, event: 'session/event', payload: null },
      { version: 3, type: 'stream-ack', connectionEpoch: 7, cursor: 0 },
      { ...base, type: 'approval', idempotencyKey: IDEM, sessionId: ID, approvalId: ID, outcome: 'rejected' },
      { ...base, type: 'client-response', idempotencyKey: IDEM, result: { ok: true, value: null } },
      { ...base, type: 'device-control', idempotencyKey: IDEM, deviceId: ID, action: 'device.describe', payload: null },
    ]
    for (const envelope of envelopes) expect(code(() => parseRemoteWireEnvelope({ ...envelope, extra: true }))).toBe('REMOTE_WIRE_MALFORMED')
    for (const result of [null, { ok: 'true' }, { ok: true }, { ok: false }, { ok: false, error: null }, { ok: false, error: {} }]) {
      expect(code(() => parseRemoteWireEnvelope({ ...base, type: 'response', result }))).toBe('REMOTE_WIRE_RESPONSE_INVALID')
    }
    expect(parseRemoteWireEnvelope({ ...base, type: 'response', result: { ok: false, error: { code: 'failure', message: 'safe', details: {} } } })).toMatchObject({ result: { ok: false } })
    expect(code(() => parseRemoteWireEnvelope({ ...base, type: 'device-control', idempotencyKey: IDEM, deviceId: ID, action: 'future', payload: {} }))).toBe('REMOTE_WIRE_UNKNOWN_DEVICE_CONTROL')
  })
  it('round-trips every fixed envelope form', () => {
    const envelopes = [
      request(),
      { version: 3, type: 'response', connectionEpoch: 7, requestId: ID, result: { ok: true, value: { accepted: true } } },
      { version: 3, type: 'event', connectionEpoch: 7, cursor: 3, eventId: ID, requestId: ID, event: 'session/event', payload: { seq: 3 } },
      { version: 3, type: 'stream-ack', connectionEpoch: 7, cursor: 3 },
      { version: 3, type: 'approval', connectionEpoch: 7, requestId: ID, idempotencyKey: IDEM, sessionId: ID, approvalId: ID, outcome: 'allowed-once' },
      { version: 3, type: 'client-response', connectionEpoch: 7, requestId: ID, idempotencyKey: IDEM, result: { ok: true, value: { answers: ['yes'] } } },
      { version: 3, type: 'device-control', connectionEpoch: 7, requestId: ID, idempotencyKey: IDEM, deviceId: ID, action: 'device.heartbeat', payload: {} },
    ]

    for (const envelope of envelopes) {
      expect(parseRemoteWireJson(serializeRemoteWireEnvelope(envelope))).toEqual(parseRemoteWireEnvelope(envelope))
    }
  })

  it('admits only names still present in the host request map and stream map', () => {
    expect(parseRemoteWireEnvelope(request({ method: 'workspace.archiveSession' }))).toMatchObject({ method: 'workspace.archiveSession' })
    expect(parseRemoteWireEnvelope({ version: 3, type: 'event', connectionEpoch: 7, cursor: 3, eventId: ID, requestId: ID, event: 'approval/requested', payload: {} })).toMatchObject({ event: 'approval/requested' })
    expect(code(() => parseRemoteWireEnvelope(request({ method: 'computer.use' })))).toBe('REMOTE_WIRE_UNKNOWN_METHOD')
    expect(code(() => parseRemoteWireEnvelope({ version: 3, type: 'event', connectionEpoch: 7, cursor: 3, eventId: ID, requestId: ID, event: 'screen/frame', payload: {} }))).toBe('REMOTE_WIRE_UNKNOWN_EVENT')
  })

  it('rejects ambiguous envelopes, bad ids, replay-unframed writes, and unsupported versions', () => {
    expect(code(() => parseRemoteWireEnvelope({ ...request(), extra: true }))).toBe('REMOTE_WIRE_MALFORMED')
    expect(code(() => parseRemoteWireEnvelope(request({ requestId: 'short' })))).toBe('REMOTE_WIRE_ID_INVALID')
    const { idempotencyKey: _idempotencyKey, ...missingIdempotency } = request()
    expect(code(() => parseRemoteWireEnvelope(missingIdempotency))).toBe('REMOTE_WIRE_MALFORMED')
    expect(code(() => parseRemoteWireEnvelope(request({ version: 2 })))).toBe('REMOTE_WIRE_UNSUPPORTED_VERSION')
  })

  it('enforces hostile nested and oversized payload bounds before a transport may use them', () => {
    let deep: unknown = null
    for (let index = 0; index <= 32; index += 1) deep = [deep]
    expect(code(() => parseRemoteWireEnvelope(request({ payload: deep })))).toBe('REMOTE_WIRE_PAYLOAD_INVALID')
    expect(code(() => parseRemoteWireJson('x'.repeat(MAX_REMOTE_WIRE_PAYLOAD_BYTES + 1)))).toBe('REMOTE_WIRE_PAYLOAD_TOO_LARGE')
    const prototypePayload: unknown = JSON.parse('{"__proto__":{"injected":true}}')
    expect(code(() => parseRemoteWireEnvelope(request({ payload: prototypePayload })))).toBe('REMOTE_WIRE_PAYLOAD_INVALID')
    const oversizedResult = {
      version: 3, type: 'response', connectionEpoch: 7, requestId: ID,
      result: { ok: false, error: {
        code: 'c'.repeat(1024 * 1024), message: 'm'.repeat(1024 * 1024),
        details: Array.from({ length: 8 }, () => 'd'.repeat(768 * 1024)),
      } },
    }
    expect(code(() => parseRemoteWireEnvelope(oversizedResult))).toBe('REMOTE_WIRE_PAYLOAD_TOO_LARGE')
    expect(code(() => serializeRemoteWireEnvelope(oversizedResult))).toBe('REMOTE_WIRE_PAYLOAD_TOO_LARGE')
  })

  it('requires exact host approval outcomes and monotonic-syntax cursor values', () => {
    expect(code(() => parseRemoteWireEnvelope({ version: 3, type: 'approval', connectionEpoch: 7, requestId: ID, idempotencyKey: IDEM, sessionId: ID, approvalId: ID, outcome: 'allowed-session' }))).toBe('REMOTE_WIRE_APPROVAL_INVALID')
    expect(code(() => parseRemoteWireEnvelope({ version: 3, type: 'stream-ack', connectionEpoch: 7, cursor: -1 }))).toBe('REMOTE_WIRE_CURSOR_INVALID')
  })

  it('preserves the host request id needed to answer a received question', () => {
    const question = parseRemoteWireEnvelope({
      version: 3, type: 'event', connectionEpoch: 7, cursor: 3, eventId: IDEM, requestId: ID,
      event: 'question/requested', payload: { questions: [] },
    })
    const answer = parseRemoteWireEnvelope({
      version: 3, type: 'client-response', connectionEpoch: 7, requestId: ID, idempotencyKey: IDEM,
      result: { ok: true, value: { answers: [] } },
    })
    expect(question.type).toBe('event')
    expect(answer.type).toBe('client-response')
    if (question.type !== 'event' || answer.type !== 'client-response') throw new Error('Expected question and response')
    expect(answer.requestId).toBe(question.requestId)
  })
})
