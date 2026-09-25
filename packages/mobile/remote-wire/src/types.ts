/** Trusted remote-client v3 wire types. @module @deepseek-ai/dsh-remote-wire/types */

import type {
  REMOTE_DEVICE_CONTROLS,
  REMOTE_WIRE_EVENTS,
  REMOTE_WIRE_METHODS,
} from './index.ts'

/** An opaque, public v3 correlation or resource identifier. */
export type RemoteWireId = string & { readonly __remoteWireId: unique symbol }

/** A JSON value admitted after the package's bounded recursive parse. */
export type RemoteWireJson = null | boolean | number | string | readonly RemoteWireJson[] | {
  readonly [key: string]: RemoteWireJson
}

/** A v3 method pinned to the currently public DSH API Proxy map. */
export type RemoteWireMethod = typeof REMOTE_WIRE_METHODS[number]

/** A v3 event pinned to the currently public DSH host and mux stream vocabulary. */
export type RemoteWireEvent = typeof REMOTE_WIRE_EVENTS[number]

/** A device lifecycle command reserved for the host-owned connection controller. */
export type RemoteDeviceControl = typeof REMOTE_DEVICE_CONTROLS[number]

/** Closed protocol failures that never include untrusted input. */
export type RemoteWireErrorCode =
  | 'REMOTE_WIRE_MALFORMED'
  | 'REMOTE_WIRE_UNSUPPORTED_VERSION'
  | 'REMOTE_WIRE_UNKNOWN_TYPE'
  | 'REMOTE_WIRE_UNKNOWN_METHOD'
  | 'REMOTE_WIRE_UNKNOWN_EVENT'
  | 'REMOTE_WIRE_UNKNOWN_DEVICE_CONTROL'
  | 'REMOTE_WIRE_ID_INVALID'
  | 'REMOTE_WIRE_EPOCH_INVALID'
  | 'REMOTE_WIRE_CURSOR_INVALID'
  | 'REMOTE_WIRE_PAYLOAD_INVALID'
  | 'REMOTE_WIRE_PAYLOAD_TOO_LARGE'
  | 'REMOTE_WIRE_RESPONSE_INVALID'
  | 'REMOTE_WIRE_APPROVAL_INVALID'

/** A host-originated remote-operation failure. The details remain opaque to this framing layer. */
export interface RemoteWireFailure {
  readonly code: string
  readonly message: string
  readonly details: RemoteWireJson
}

/** Result returned by the host for one request. */
export type RemoteWireResult =
  | { readonly ok: true; readonly value: RemoteWireJson }
  | { readonly ok: false; readonly error: RemoteWireFailure }

/** Client-to-host request. requestId correlates the result, idempotencyKey controls retries. */
export interface RemoteWireRequest {
  readonly version: 3
  readonly type: 'request'
  readonly connectionEpoch: number
  readonly requestId: RemoteWireId
  readonly idempotencyKey: RemoteWireId
  readonly method: RemoteWireMethod
  readonly payload: RemoteWireJson
}

/** Host response echoing a client request id in the same connection epoch. */
export interface RemoteWireResponse {
  readonly version: 3
  readonly type: 'response'
  readonly connectionEpoch: number
  readonly requestId: RemoteWireId
  readonly result: RemoteWireResult
}

/** Ordered host event. Consumers acknowledge `cursor` only after durable local application. */
export interface RemoteWireEventEnvelope {
  readonly version: 3
  readonly type: 'event'
  readonly connectionEpoch: number
  readonly cursor: number
  readonly eventId: RemoteWireId
  /** Original Host RpcRequest id; answerable events require this value in a client response. */
  readonly requestId: RemoteWireId
  readonly event: RemoteWireEvent
  readonly payload: RemoteWireJson
}

/** Client acknowledgement of the highest contiguous host-event cursor applied locally. */
export interface RemoteWireStreamAck {
  readonly version: 3
  readonly type: 'stream-ack'
  readonly connectionEpoch: number
  readonly cursor: number
}

/** Client response to a host approval request. Its request and idempotency ids make reconnect retries safe. */
export interface RemoteWireApproval {
  readonly version: 3
  readonly type: 'approval'
  readonly connectionEpoch: number
  readonly requestId: RemoteWireId
  readonly idempotencyKey: RemoteWireId
  readonly sessionId: RemoteWireId
  readonly approvalId: RemoteWireId
  readonly outcome: 'allowed-once' | 'rejected'
}

/** Client reply to an answerable host request such as a user question. */
export interface RemoteWireClientResponse {
  readonly version: 3
  readonly type: 'client-response'
  readonly connectionEpoch: number
  /** Echoes the host request correlation id and is never client-minted. */
  readonly requestId: RemoteWireId
  readonly idempotencyKey: RemoteWireId
  readonly result: RemoteWireResult
}

/** Client request affecting connection lifecycle only, never a host filesystem or tool operation. */
export interface RemoteWireDeviceControlEnvelope {
  readonly version: 3
  readonly type: 'device-control'
  readonly connectionEpoch: number
  readonly requestId: RemoteWireId
  readonly idempotencyKey: RemoteWireId
  readonly deviceId: RemoteWireId
  readonly action: RemoteDeviceControl
  readonly payload: RemoteWireJson
}

/** Every v3 remote wire envelope. */
export type RemoteWireEnvelope =
  | RemoteWireRequest
  | RemoteWireResponse
  | RemoteWireEventEnvelope
  | RemoteWireStreamAck
  | RemoteWireApproval
  | RemoteWireClientResponse
  | RemoteWireDeviceControlEnvelope
