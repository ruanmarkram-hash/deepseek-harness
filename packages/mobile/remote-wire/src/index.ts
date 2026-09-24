/**
 * Strict, transport-neutral envelope vocabulary for a trusted remote DSH client.
 * This package defines no connection, trust store, cryptography, or host dispatch.
 * @module @deepseek-ai/dsh-remote-wire
 */

import type { HostFrame, MuxFrame, RpcMethodMap } from '@deepseek-ai/dsh-remote-api/api'
import { RemoteWireError } from './error.ts'
import type {
  RemoteDeviceControl,
  RemoteWireEnvelope,
  RemoteWireErrorCode,
  RemoteWireEvent,
  RemoteWireId,
  RemoteWireJson,
  RemoteWireMethod,
  RemoteWireResult,
} from './types.ts'

export { RemoteWireError, isRemoteWireError } from './error.ts'
export type {
  RemoteDeviceControl,
  RemoteWireApproval,
  RemoteWireClientResponse,
  RemoteWireEnvelope,
  RemoteWireErrorCode,
  RemoteWireEvent,
  RemoteWireEventEnvelope,
  RemoteWireFailure,
  RemoteWireId,
  RemoteWireJson,
  RemoteWireMethod,
  RemoteWireRequest,
  RemoteWireResponse,
  RemoteWireResult,
  RemoteWireStreamAck,
  RemoteWireDeviceControlEnvelope,
} from './types.ts'

/** The only accepted remote-client wire version. */
export const REMOTE_WIRE_VERSION = 3 as const
/** Maximum JSON-encoded byte size of one v3 payload or result value. */
export const MAX_REMOTE_WIRE_PAYLOAD_BYTES = 8 * 1024 * 1024
/** Maximum UTF-8 byte size of one scalar string inside an admitted payload. */
export const MAX_REMOTE_WIRE_STRING_BYTES = 1024 * 1024
/** Maximum nesting depth accepted in a payload. */
export const MAX_REMOTE_WIRE_JSON_DEPTH = 32
/** Maximum array entries or object properties at one payload level. */
export const MAX_REMOTE_WIRE_JSON_ITEMS = 1024
/** Largest connection epoch or stream cursor accepted by the syntax layer. */
export const MAX_REMOTE_WIRE_SEQUENCE = 2_147_483_647

/**
 * Public DSH API request names from RpcMethodMap. `satisfies` makes a renamed
 * or removed Host public method fail this package's typecheck instead of silently
 * widening the remote surface.
 */
export const REMOTE_WIRE_METHODS = [
  'session.list', 'session.search', 'session.create', 'session.history', 'session.models',
  'session.selectModel', 'session.rename', 'session.fork', 'session.prompt', 'session.attachment',
  'session.updateQueue', 'session.cancel', 'subagent.list', 'subagent.history', 'subagent.prompt',
  'subagent.interrupt', 'host.describe', 'host.pickDirectory', 'host.listDirectory',
  'host.createDirectory', 'host.openPath', 'workspace.list', 'workspace.create', 'workspace.rename',
  'workspace.delete', 'workspace.insertBefore', 'workspace.insertSessionBefore',
  'workspace.archiveSession', 'skill.list', 'agentPreset.list', 'agentPreset.select',
  'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
  'goal.create', 'goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear',
  'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace',
  'settings.mutate', 'credentials.describe', 'credentials.set', 'credentials.unset',
  'llm.providers', 'llm.models', 'llm.discoverModels',
] as const satisfies readonly (keyof RpcMethodMap)[]

type Assert<T extends true> = T

/** Compile-time proof that this fixed remote surface covers every public API Proxy request. */
export type RemoteWirePublicMethodCoverage = Assert<
  Exclude<keyof RpcMethodMap, typeof REMOTE_WIRE_METHODS[number]> extends never ? true : false
>

/** Existing Host and mux event kinds delivered without transport-specific renaming. */
export const REMOTE_WIRE_EVENTS = [
  'session/event', 'session/subscribed', 'approval/requested', 'approval/resolved',
  'question/requested', 'question/resolved', 'session/queue', 'session/jobs',
  'session/projection', 'host/session-added', 'host/session-removed', 'host/session-status',
  'host/agent-error', 'host/workspace-changed', 'host/workspace-removed',
  'host/workspace-order-changed', 'host/archived-sessions-changed', 'host/remote-event',
  'stream/error',
] as const satisfies readonly (MuxFrame['type'] | HostFrame['type'])[]

/** Compile-time proof that every current public mux and host event has a remote representation. */
export type RemoteWirePublicEventCoverage = Assert<
  Exclude<MuxFrame['type'] | HostFrame['type'], typeof REMOTE_WIRE_EVENTS[number]> extends never ? true : false
>

/** Connection-lifecycle controls. These never stand in for a DSH RPC method. */
export const REMOTE_DEVICE_CONTROLS = [
  'device.describe', 'device.heartbeat', 'device.disconnect',
] as const

const TEXT = new TextEncoder()
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const METHODS = new Set<string>(REMOTE_WIRE_METHODS)
const EVENTS = new Set<string>(REMOTE_WIRE_EVENTS)
const DEVICE_CONTROLS = new Set<string>(REMOTE_DEVICE_CONTROLS)
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function failure(code: RemoteWireErrorCode): never {
  throw new RemoteWireError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function boundedString(value: unknown, code: RemoteWireErrorCode): string {
  if (typeof value !== 'string' || value.length > MAX_REMOTE_WIRE_STRING_BYTES * 2) return failure(code)
  return TEXT.encode(value).byteLength <= MAX_REMOTE_WIRE_STRING_BYTES ? value : failure(code)
}

/**
 * Validate an opaque identifier at a protocol boundary.
 * @param value - Candidate identifier from a transport or another protocol.
 * @returns the validated remote-wire identifier.
 */
export function parseRemoteWireId(value: unknown): RemoteWireId {
  const parsed = boundedString(value, 'REMOTE_WIRE_ID_INVALID')
  return OPAQUE_ID.test(parsed) ? parsed as RemoteWireId : failure('REMOTE_WIRE_ID_INVALID')
}

function sequence(value: unknown, code: 'REMOTE_WIRE_EPOCH_INVALID' | 'REMOTE_WIRE_CURSOR_INVALID'): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REMOTE_WIRE_SEQUENCE
    ? value
    : failure(code)
}

function json(value: unknown, depth = 0): RemoteWireJson {
  if (depth > MAX_REMOTE_WIRE_JSON_DEPTH) return failure('REMOTE_WIRE_PAYLOAD_INVALID')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : failure('REMOTE_WIRE_PAYLOAD_INVALID')
  if (typeof value === 'string') return boundedString(value, 'REMOTE_WIRE_PAYLOAD_INVALID')
  if (Array.isArray(value)) {
    if (value.length > MAX_REMOTE_WIRE_JSON_ITEMS) return failure('REMOTE_WIRE_PAYLOAD_INVALID')
    return value.map(item => json(item, depth + 1))
  }
  if (!isRecord(value)) return failure('REMOTE_WIRE_PAYLOAD_INVALID')
  const entries = Object.entries(value)
  if (entries.length > MAX_REMOTE_WIRE_JSON_ITEMS) return failure('REMOTE_WIRE_PAYLOAD_INVALID')
  const result: Record<string, RemoteWireJson> = Object.create(null) as Record<string, RemoteWireJson>
  for (const [key, item] of entries) {
    boundedString(key, 'REMOTE_WIRE_PAYLOAD_INVALID')
    if (DANGEROUS_JSON_KEYS.has(key)) return failure('REMOTE_WIRE_PAYLOAD_INVALID')
    result[key] = json(item, depth + 1)
  }
  return result
}

function payload(value: unknown): RemoteWireJson {
  const parsed = json(value)
  return TEXT.encode(JSON.stringify(parsed)).byteLength <= MAX_REMOTE_WIRE_PAYLOAD_BYTES
    ? parsed
    : failure('REMOTE_WIRE_PAYLOAD_TOO_LARGE')
}

function method(value: unknown): RemoteWireMethod {
  return typeof value === 'string' && METHODS.has(value)
    ? value as RemoteWireMethod
    : failure('REMOTE_WIRE_UNKNOWN_METHOD')
}

function event(value: unknown): RemoteWireEvent {
  return typeof value === 'string' && EVENTS.has(value)
    ? value as RemoteWireEvent
    : failure('REMOTE_WIRE_UNKNOWN_EVENT')
}

function deviceControl(value: unknown): RemoteDeviceControl {
  return typeof value === 'string' && DEVICE_CONTROLS.has(value)
    ? value as RemoteDeviceControl
    : failure('REMOTE_WIRE_UNKNOWN_DEVICE_CONTROL')
}

function result(value: unknown): RemoteWireResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return failure('REMOTE_WIRE_RESPONSE_INVALID')
  if (value.ok) {
    if (!hasExactKeys(value, ['ok', 'value'])) return failure('REMOTE_WIRE_RESPONSE_INVALID')
    return { ok: true, value: payload(value.value) }
  }
  if (!hasExactKeys(value, ['ok', 'error']) || !isRecord(value.error)
    || !hasExactKeys(value.error, ['code', 'message', 'details'])) {
    return failure('REMOTE_WIRE_RESPONSE_INVALID')
  }
  const code = boundedString(value.error.code, 'REMOTE_WIRE_RESPONSE_INVALID')
  const message = boundedString(value.error.message, 'REMOTE_WIRE_RESPONSE_INVALID')
  return { ok: false, error: { code, message, details: payload(value.error.details) } }
}

function version(value: Record<string, unknown>): void {
  if (value.version !== REMOTE_WIRE_VERSION) failure('REMOTE_WIRE_UNSUPPORTED_VERSION')
}

/** Reject a reconstructed envelope that exceeds the complete wire payload limit. */
function completeEnvelope<T extends RemoteWireEnvelope>(value: T): T {
  return TEXT.encode(JSON.stringify(value)).byteLength <= MAX_REMOTE_WIRE_PAYLOAD_BYTES
    ? value
    : failure('REMOTE_WIRE_PAYLOAD_TOO_LARGE')
}

/**
 * Parse one exact, bounded v3 remote-client envelope.
 * @param value - untrusted decoded value from the encrypted transport.
 * @returns a canonical, bounded remote-wire envelope.
 */
export function parseRemoteWireEnvelope(value: unknown): RemoteWireEnvelope {
  if (!isRecord(value) || typeof value.type !== 'string') return failure('REMOTE_WIRE_MALFORMED')
  version(value)
  if (value.type === 'request') {
    if (!hasExactKeys(value, ['version', 'type', 'connectionEpoch', 'requestId', 'idempotencyKey', 'method', 'payload'])) {
      return failure('REMOTE_WIRE_MALFORMED')
    }
    return completeEnvelope({
      version: REMOTE_WIRE_VERSION, type: 'request',
      connectionEpoch: sequence(value.connectionEpoch, 'REMOTE_WIRE_EPOCH_INVALID'),
      requestId: parseRemoteWireId(value.requestId), idempotencyKey: parseRemoteWireId(value.idempotencyKey),
      method: method(value.method), payload: payload(value.payload),
    })
  }
  if (value.type === 'response') {
    if (!hasExactKeys(value, ['version', 'type', 'connectionEpoch', 'requestId', 'result'])) {
      return failure('REMOTE_WIRE_MALFORMED')
    }
    return completeEnvelope({
      version: REMOTE_WIRE_VERSION, type: 'response',
      connectionEpoch: sequence(value.connectionEpoch, 'REMOTE_WIRE_EPOCH_INVALID'),
      requestId: parseRemoteWireId(value.requestId), result: result(value.result),
    })
  }
  if (value.type === 'event') {
    if (!hasExactKeys(value, ['version', 'type', 'connectionEpoch', 'cursor', 'eventId', 'requestId', 'event', 'payload'])) {
      return failure('REMOTE_WIRE_MALFORMED')
    }
    return completeEnvelope({
      version: REMOTE_WIRE_VERSION, type: 'event',
      connectionEpoch: sequence(value.connectionEpoch, 'REMOTE_WIRE_EPOCH_INVALID'),
      cursor: sequence(value.cursor, 'REMOTE_WIRE_CURSOR_INVALID'), eventId: parseRemoteWireId(value.eventId), requestId: parseRemoteWireId(value.requestId),
      event: event(value.event), payload: payload(value.payload),
    })
  }
  if (value.type === 'stream-ack') {
    if (!hasExactKeys(value, ['version', 'type', 'connectionEpoch', 'cursor'])) return failure('REMOTE_WIRE_MALFORMED')
    return completeEnvelope({
      version: REMOTE_WIRE_VERSION, type: 'stream-ack',
      connectionEpoch: sequence(value.connectionEpoch, 'REMOTE_WIRE_EPOCH_INVALID'),
      cursor: sequence(value.cursor, 'REMOTE_WIRE_CURSOR_INVALID'),
    })
  }
  if (value.type === 'approval') {
    if (!hasExactKeys(value, ['version', 'type', 'connectionEpoch', 'requestId', 'idempotencyKey', 'sessionId', 'approvalId', 'outcome'])) {
      return failure('REMOTE_WIRE_MALFORMED')
    }
    if (value.outcome !== 'allowed-once' && value.outcome !== 'rejected') return failure('REMOTE_WIRE_APPROVAL_INVALID')
    return completeEnvelope({
      version: REMOTE_WIRE_VERSION, type: 'approval',
      connectionEpoch: sequence(value.connectionEpoch, 'REMOTE_WIRE_EPOCH_INVALID'),
      requestId: parseRemoteWireId(value.requestId), idempotencyKey: parseRemoteWireId(value.idempotencyKey),
      sessionId: parseRemoteWireId(value.sessionId), approvalId: parseRemoteWireId(value.approvalId), outcome: value.outcome,
    })
  }
  if (value.type === 'client-response') {
    if (!hasExactKeys(value, ['version', 'type', 'connectionEpoch', 'requestId', 'idempotencyKey', 'result'])) {
      return failure('REMOTE_WIRE_MALFORMED')
    }
    return completeEnvelope({
      version: REMOTE_WIRE_VERSION, type: 'client-response',
      connectionEpoch: sequence(value.connectionEpoch, 'REMOTE_WIRE_EPOCH_INVALID'),
      requestId: parseRemoteWireId(value.requestId), idempotencyKey: parseRemoteWireId(value.idempotencyKey),
      result: result(value.result),
    })
  }
  if (value.type === 'device-control') {
    if (!hasExactKeys(value, ['version', 'type', 'connectionEpoch', 'requestId', 'idempotencyKey', 'deviceId', 'action', 'payload'])) {
      return failure('REMOTE_WIRE_MALFORMED')
    }
    return completeEnvelope({
      version: REMOTE_WIRE_VERSION, type: 'device-control',
      connectionEpoch: sequence(value.connectionEpoch, 'REMOTE_WIRE_EPOCH_INVALID'),
      requestId: parseRemoteWireId(value.requestId), idempotencyKey: parseRemoteWireId(value.idempotencyKey),
      deviceId: parseRemoteWireId(value.deviceId), action: deviceControl(value.action), payload: payload(value.payload),
    })
  }
  return failure('REMOTE_WIRE_UNKNOWN_TYPE')
}

/**
 * Parse a bounded JSON string and then one exact v3 envelope.
 * @param serialized - UTF-8 JSON received from a transport frame.
 * @returns a canonical, bounded remote-wire envelope.
 */
export function parseRemoteWireJson(serialized: unknown): RemoteWireEnvelope {
  if (typeof serialized !== 'string' || serialized.length > MAX_REMOTE_WIRE_PAYLOAD_BYTES * 2) {
    return failure('REMOTE_WIRE_PAYLOAD_INVALID')
  }
  if (TEXT.encode(serialized).byteLength > MAX_REMOTE_WIRE_PAYLOAD_BYTES) failure('REMOTE_WIRE_PAYLOAD_TOO_LARGE')
  try {
    return parseRemoteWireEnvelope(JSON.parse(serialized))
  } catch (error) {
    if (error instanceof RemoteWireError) throw error
    return failure('REMOTE_WIRE_MALFORMED')
  }
}

/**
 * Validate then serialize an envelope, preserving the package's byte bounds.
 * @param value - candidate remote-wire envelope to encode.
 * @returns canonical JSON safe to place in one v3 payload.
 */
export function serializeRemoteWireEnvelope(value: unknown): string {
  const parsed = parseRemoteWireEnvelope(value)
  const serialized = JSON.stringify(parsed)
  return TEXT.encode(serialized).byteLength <= MAX_REMOTE_WIRE_PAYLOAD_BYTES
    ? serialized
    : failure('REMOTE_WIRE_PAYLOAD_TOO_LARGE')
}
