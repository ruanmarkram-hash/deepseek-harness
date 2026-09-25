/**
 * Host-owned dispatch for authenticated remote DSH clients. The plugin mounts
 * no listener: a relay connection provider explicitly attaches only an already
 * mutually-authenticated and decrypted connection.
 * @module @deepseek-ai/dsh-remote-gateway
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  invokeApiProxyMethod,
  RpcId as rpcId,
  type ApiProxy,
  type ClientResponse,
  type HostFrame,
  type MuxFrame,
  type RpcId,
  type RpcMethodMap,
  type RpcReceipt,
  type RpcResult,
} from '@deepseek-ai/dsh-remote-api'
import type {
  RemoteDeviceChange,
  RemoteDeviceDirectory,
  RemoteDeviceId,
  RemoteDeviceRecord,
} from '@deepseek-ai/dsh-remote-devices'
import {
  parseRemoteWireId,
  parseRemoteWireEnvelope,
  type RemoteWireEnvelope,
  type RemoteWireEvent,
  type RemoteWireId,
  type RemoteWireJson,
  type RemoteWireResult,
} from '@deepseek-ai/dsh-remote-wire'
import type {
  RemoteGatewayAuditEntry,
  RemoteGatewayCloseReason,
  RemoteGatewayConnectionStatus,
  RemoteGatewayOptions,
  TrustedRemoteConnection,
  TrustedRemotePeerIdentity,
  TrustedRemoteConnectionProvider,
  TrustedRemoteRoute,
  TrustedRemoteSendFence,
} from './types.ts'

export { RemoteGatewayError, isRemoteGatewayError } from './error.ts'
export type {
  RemoteGatewayAuditEntry,
  RemoteGatewayCloseReason,
  RemoteGatewayConnectionStatus,
  RemoteGatewayOptions,
  TrustedRemoteConnection,
  TrustedRemotePeerIdentity,
  TrustedRemoteConnectionProvider,
  TrustedRemoteRoute,
  TrustedRemoteSendFence,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'remote-gateway'
/** The composed public Host API and local trusted-device directory are required. */
export const inject = ['apiProxy', 'remoteDevices']

/** Gateway memory limits. They are deployment settings, not wire constants. */
export interface Config extends RemoteGatewayOptions {}

export const Config: z<Config> = z.object({
  maxIdempotencyEntriesPerDevice: z.natural().min(1).required(),
  maxEventEntriesPerDevice: z.natural().min(1).required(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host service that attaches authenticated remote connections to DSH. */
    remoteGateway: RemoteGateway
  }

  interface Events {
    /**
     * A trusted remote operation reached a Host gateway decision point.
     * The entry identifies the authenticated device and route and never copies a payload.
     * @mode emit
     * @param entry - Completed or rejected gateway audit record.
     */
    'remote-gateway/audit'(entry: RemoteGatewayAuditEntry): void
  }
}

interface RemoteGatewayDependencies {
  readonly api: ApiProxy
  readonly devices: RemoteDeviceDirectory
  readonly now: () => string
  readonly newId: () => RemoteWireId
  readonly audit: (entry: RemoteGatewayAuditEntry) => void
}

interface RetainedEvent {
  readonly cursor: number
  readonly eventId: RemoteWireId
  readonly requestId: RemoteWireId
  readonly event: RemoteWireEvent
  readonly payload: RemoteWireJson
}

interface IdempotentResult {
  readonly fingerprint: string
  readonly result: RemoteWireResult
}

interface DeviceState {
  nextCursor: number
  acknowledgedCursor: number
  readonly events: RetainedEvent[]
  readonly idempotency: Map<RemoteWireId, IdempotentResult | Promise<IdempotentResult>>
  active?: RemoteGatewayConnection
}

/** Process-lifetime freshness fence retained after replay and retry data is purged. */
interface DeviceFreshness {
  readonly incarnation: string
  routeGeneration: number
  connectionEpoch: number
  revoked: boolean
}

type DeliveryOutcome = 'delivered-current' | 'committed-before-close' | 'not-delivered'

/** Convert a known Host value through JSON serialization and the strict v3 result parser. */
function wireResult(result: RpcResult<unknown>): RemoteWireResult {
  try {
    const parsed = parseRemoteWireEnvelope({
      version: 3,
      type: 'response',
      connectionEpoch: 0,
      requestId: 'gateway_result_0001',
      result,
    })
    // The parser preserves the owned literal discriminant or throws.
    return (parsed as Extract<RemoteWireEnvelope, { type: 'response' }>).result
  } catch {
    return { ok: false, error: { code: 'remote-response-invalid', message: 'Host response cannot be sent to this remote client', details: {} } }
  }
}

/** Serialize a Host stream frame as a bounded remote-wire JSON payload. */
function wirePayload(value: unknown): RemoteWireJson | undefined {
  try {
    const serialized: unknown = JSON.stringify(value)
    if (typeof serialized !== 'string') return undefined
    const decoded: unknown = JSON.parse(serialized)
    const parsed = parseRemoteWireEnvelope({
      version: 3,
      type: 'response',
      connectionEpoch: 0,
      requestId: 'gateway_payload_001',
      result: { ok: true, value: decoded },
    })
    // JSON round-tripping removed caller-owned hooks; both discriminants are
    // our own literals and the parser either preserves them or throws.
    return (parsed as Extract<RemoteWireEnvelope, { type: 'response' }> & {
      result: { ok: true; value: RemoteWireJson }
    }).result.value
  } catch {
    return undefined
  }
}

/** @returns a stable fingerprint excluding per-attempt request correlation. */
function fingerprint(value: unknown): string {
  return JSON.stringify(value)
}

/** A non-throwing Host failure result for remote callers. */
function internalFailure(): RemoteWireResult {
  return { ok: false, error: { code: 'remote-internal', message: 'The Host could not complete this remote operation', details: {} } }
}

/** Translate a Host response-delivery receipt into a remote-wire result. */
function receiptResult(receipt: RpcReceipt): RemoteWireResult {
  return receipt.accepted
    ? { ok: true, value: { accepted: true } }
    : { ok: false, error: { code: 'remote-response-refused', message: 'The Host no longer accepts this response', details: { reason: receipt.reason } } }
}

/** A current DSH API baseline used when a remote device has no replay cursor. */
interface RemoteGatewaySnapshot {
  readonly host: RemoteWireResult
  readonly sessions: RemoteWireResult
  readonly workspaces: RemoteWireResult
}

/**
 * Host gateway for remote-wire v3. It owns dispatch, event ordering, retry
 * retention, and response routing. Relay identity proof, encryption, route
 * allocation, and byte transport remain with a connection provider.
 */
export class RemoteGateway {
  private readonly states = new Map<RemoteDeviceId, DeviceState>()
  private readonly freshness = new Map<RemoteDeviceId, DeviceFreshness>()
  private disposed = false

  /** @param deps - Composed Host authority and local observable services. @param options - Explicit live-memory bounds. */
  constructor(private readonly deps: RemoteGatewayDependencies, private readonly options: RemoteGatewayOptions) {}

  /**
   * Attach one already-authenticated remote connection. The gateway checks the
   * device directory again, so a revoked device cannot keep or regain access
   * through a stale relay authorization.
   * @param connection - Provider-authenticated and decrypted connection.
   * @returns the active connection controller, or `undefined` after refusal.
   */
  async attach(connection: TrustedRemoteConnection): Promise<RemoteGatewayConnection | undefined> {
    if (this.disposed) {
      await connection.close('gateway-disposed')
      return undefined
    }
    if (!this.validRoute(connection.route)) {
      this.audit(connection, 'connection', 'rejected', 'invalid-route')
      await connection.close('protocol-rejected')
      return undefined
    }
    const device = this.deps.devices.get(connection.peer.deviceId)
    if (device === undefined || !this.matchesEnrollment(device, connection.peer)) {
      this.audit(connection, 'connection', 'rejected', 'unauthorized-enrollment')
      await connection.close('unauthorized-device')
      return undefined
    }
    const freshness = this.freshnessFor(device)
    if (freshness.revoked || connection.route.generation < freshness.routeGeneration
      || (connection.route.generation === freshness.routeGeneration && connection.route.connectionEpoch <= freshness.connectionEpoch)) {
      this.audit(connection, 'connection', 'rejected', 'stale-route')
      await connection.close('protocol-rejected')
      return undefined
    }
    const state = this.state(connection.peer.deviceId)
    const prior = state.active
    if (prior !== undefined) await prior.close('superseded')
    freshness.routeGeneration = connection.route.generation
    freshness.connectionEpoch = connection.route.connectionEpoch
    try {
      await this.deps.devices.markSeen(connection.peer.deviceId, this.deps.now())
    } catch {
      this.audit(connection, 'connection', 'rejected', 'presence-write-failed')
      await connection.close('unauthorized-device')
      return undefined
    }
    // `markSeen` is durable and therefore asynchronous. A revoke or new
    // enrollment may win while it settles, so do not activate based on the
    // earlier directory/freshness observation.
    if (!this.isTrusted(connection.peer) || this.freshness.get(connection.peer.deviceId) !== freshness) {
      this.audit(connection, 'connection', 'rejected', 'authorization-changed')
      await connection.close('unauthorized-device')
      return undefined
    }
    const active = new RemoteGatewayConnection(this, connection, state)
    state.active = active
    this.audit(connection, 'connection', 'accepted', 'authenticated-device')
    active.start()
    return active
  }

  /**
   * Consumes authenticated connections from a relay provider until cancellation.
   * @param provider - Relay provider that yields only authenticated, decrypted connections.
   * @param signal - Owner cancellation signal.
   */
  async serve(provider: TrustedRemoteConnectionProvider, signal: AbortSignal): Promise<void> {
    for await (const connection of provider.accept(signal)) {
      if (signal.aborted || this.disposed) {
        await connection.close('gateway-disposed')
        return
      }
      await this.attach(connection)
    }
  }

  /** Stop every current connection and drop all in-memory replay and retry state. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all([...this.states.values()].flatMap(state => state.active === undefined ? [] : [state.active.close('gateway-disposed')]))
    this.states.clear()
    this.freshness.clear()
  }

  /**
   * Removes an active controller only when it still owns the device slot.
   * @param connection - Active controller whose endpoint needs removal.
   */
  detach(connection: RemoteGatewayConnection): void {
    const state = this.states.get(connection.deviceId)
    if (state?.active === connection) delete state.active
  }

  /**
   * End an active connection after its local device authorization is revoked.
   * @param deviceId - Revoked device whose process-lifetime state must close.
   */
  revoke(deviceId: RemoteDeviceId): void {
    const state = this.states.get(deviceId)
    this.states.delete(deviceId)
    const freshness = this.freshness.get(deviceId)
    if (freshness !== undefined) freshness.revoked = true
    const active = state?.active
    if (active !== undefined) void active.close('unauthorized-device')
  }

  /**
   * Emits a non-throwing gateway audit record without payload data.
   * @param connection - Authenticated device and route for this operation.
   * @param operation - Decided operation.
   * @param outcome - Gateway outcome.
   * @param reason - Stable reason.
   * @param requestId - Optional correlation id.
   */
  audit(connection: TrustedRemoteConnection, operation: RemoteGatewayAuditEntry['operation'], outcome: RemoteGatewayAuditEntry['outcome'], reason: string, requestId?: RemoteWireId): void {
    try {
      this.deps.audit({
        deviceId: connection.peer.deviceId,
        route: connection.route,
        operation,
        outcome,
        reason,
        ...(requestId === undefined ? {} : { requestId }),
      })
    } catch {
      // An audit observer cannot turn a durable Host operation into a false failure.
    }
  }

  /**
   * Invoke the same checked route table that backs the Host HTTP API.
   * @param peer - Authenticated remote identity that must remain trusted.
   * @param method - Public Host RPC method to invoke.
   * @param requestId - Remote-wire request correlation id.
   * @param payload - RPC request payload.
   * @param signal - Cancellation signal for the Host RPC.
   * @returns the wire-safe Host result or a non-sensitive failure result.
   */
  async invoke(
    peer: TrustedRemotePeerIdentity,
    method: keyof RpcMethodMap,
    requestId: RemoteWireId,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<RemoteWireResult> {
    if (!this.isTrusted(peer)) return { ok: false, error: { code: 'remote-device-unavailable', message: 'This device is no longer trusted by the Host', details: {} } }
    try {
      const response = await invokeApiProxyMethod(this.deps.api, method, { rpcId: rpcId(requestId), payload }, signal)
      return wireResult(response.result)
    } catch {
      return internalFailure()
    }
  }

  /**
   * Obtain the baseline needed when retained events cannot safely replay.
   * @param peer - Authenticated remote identity that must remain trusted.
   * @param signal - Cancellation signal shared by the baseline requests.
   * @returns the current Host, session, and workspace baseline results.
   */
  async snapshot(peer: TrustedRemotePeerIdentity, signal: AbortSignal): Promise<RemoteGatewaySnapshot> {
    const [host, sessions, workspaces] = await Promise.all([
      this.invoke(peer, 'host.describe', this.deps.newId(), {}, signal),
      this.invoke(peer, 'session.list', this.deps.newId(), {}, signal),
      this.invoke(peer, 'workspace.list', this.deps.newId(), {}, signal),
    ])
    return { host, sessions, workspaces }
  }

  /**
   * Creates a fresh stable remote-wire id.
   * @returns a fresh stable remote-wire id.
   */
  newId(): RemoteWireId {
    return this.deps.newId()
  }

  /**
   * Exposes the composed public Host API authority.
   * @returns Host authority used only to open its public event streams and respond to pending interactions.
   */
  get api(): ApiProxy {
    return this.deps.api
  }

  /**
   * Checks whether an authenticated device remains trusted by this Host.
   * @param peer - Authenticated remote identity to compare with the local directory.
   * @returns whether the device remains present with the same enrollment identity.
   */
  isTrusted(peer: TrustedRemotePeerIdentity): boolean {
    const device = this.deps.devices.get(peer.deviceId)
    return device !== undefined && this.matchesEnrollment(device, peer)
  }

  /**
   * Record authenticated device presence through the Host-owned directory.
   * @param peer - Authenticated remote identity whose presence is recorded.
   * @returns the durable directory write result.
   */
  markSeen(peer: TrustedRemotePeerIdentity): Promise<unknown> {
    if (!this.isTrusted(peer)) return Promise.reject(new Error('remote device is no longer trusted'))
    return this.deps.devices.markSeen(peer.deviceId, this.deps.now())
  }

  /**
   * Reports the configured live-memory bounds for this gateway.
   * @returns live bounds for this Host gateway.
   */
  get limits(): RemoteGatewayOptions {
    return this.options
  }

  private state(deviceId: RemoteDeviceId): DeviceState {
    let state = this.states.get(deviceId)
    if (state === undefined) {
      state = { nextCursor: 1, acknowledgedCursor: 0, events: [], idempotency: new Map() }
      this.states.set(deviceId, state)
    }
    return state
  }

  private validRoute(route: TrustedRemoteRoute): boolean {
    return typeof route.routeId === 'string' && route.routeId.length > 0
      && Number.isSafeInteger(route.generation) && route.generation >= 0
      && Number.isSafeInteger(route.connectionEpoch) && route.connectionEpoch >= 0
  }

  private freshnessFor(device: RemoteDeviceRecord): DeviceFreshness {
    const existing = this.freshness.get(device.id)
    if (existing !== undefined && existing.incarnation === device.incarnation) return existing
    const freshness: DeviceFreshness = { incarnation: device.incarnation, routeGeneration: -1, connectionEpoch: -1, revoked: false }
    this.freshness.set(device.id, freshness)
    return freshness
  }

  private matchesEnrollment(device: RemoteDeviceRecord, peer: TrustedRemotePeerIdentity): boolean {
    return device.id === peer.deviceId
      && device.incarnation === peer.enrollmentId
      && device.signingPublicKey === peer.signingPublicKey
      && device.agreementPublicKey === peer.agreementPublicKey
  }
}

/** One physical connection's receive loop, outgoing serialization, and event pumps. */
export class RemoteGatewayConnection {
  private readonly abort = new AbortController()
  private outbound: Promise<void> = Promise.resolve()
  private closed = false
  private live = true
  private readonly sendFence: TrustedRemoteSendFence = { active: true, generation: 0, abortSignal: this.abort.signal }
  private synchronized = false

  /**
   * @param gateway - Owning Host remote gateway.
   * @param connection - Authenticated physical connection.
   * @param state - Durable-in-process device retry and replay state.
   */
  constructor(
    private readonly gateway: RemoteGateway,
    private readonly connection: TrustedRemoteConnection,
    private readonly state: DeviceState,
  ) {}

  /** Authenticated remote device currently connected. */
  get deviceId(): RemoteDeviceId {
    return this.connection.peer.deviceId
  }

  /**
   * Returns a copy-safe view of this connection's synchronization progress.
   * @returns a copy-safe public connection progress view.
   */
  status(): RemoteGatewayConnectionStatus {
    return {
      deviceId: this.connection.peer.deviceId,
      route: { ...this.connection.route },
      latestCursor: this.state.nextCursor - 1,
      acknowledgedCursor: this.state.acknowledgedCursor,
      synchronized: this.synchronized,
    }
  }

  /** Start the incoming remote-wire loop and both current Host event sources. */
  start(): void {
    void this.receiveLoop()
    void this.pump(this.gateway.api.events.mux({ rpcId: rpcId(this.gateway.newId()), payload: {} }, this.abort.signal))
    void this.pump(this.gateway.api.events.host({ rpcId: rpcId(this.gateway.newId()), payload: {} }, this.abort.signal))
  }

  /**
   * Closes the provider connection and invalidates pending sends.
   * @param reason - Explicit local end reason.
   */
  async close(reason: RemoteGatewayCloseReason): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.live = false
    this.sendFence.active = false
    this.sendFence.generation += 1
    this.abort.abort()
    this.gateway.detach(this)
    try {
      await this.connection.close(reason)
    } catch {
      // The provider is already ending this physical connection.
    }
  }

  /**
   * Process one provider-delivered envelope. Exposed for focused lifecycle tests.
   * @param envelope - Decrypted remote-wire envelope from the attached provider.
   */
  async receive(envelope: RemoteWireEnvelope): Promise<void> {
    if (!this.isLive()) return
    let message: RemoteWireEnvelope
    try {
      message = parseRemoteWireEnvelope(envelope)
    } catch {
      this.gateway.audit(this.connection, 'connection', 'rejected', 'invalid-envelope')
      await this.close('protocol-rejected')
      return
    }
    if (message.connectionEpoch !== this.connection.route.connectionEpoch) {
      this.gateway.audit(this.connection, 'connection', 'rejected', 'epoch-mismatch')
      await this.close('protocol-rejected')
      return
    }
    switch (message.type) {
      case 'request':
        await this.request(message)
        return
      case 'approval':
        await this.approval(message)
        return
      case 'client-response':
        await this.clientResponse(message)
        return
      case 'device-control':
        await this.deviceControl(message)
        return
      case 'stream-ack':
        await this.acknowledge(message.cursor)
        return
      case 'response':
      case 'event':
        this.gateway.audit(this.connection, 'connection', 'rejected', 'host-envelope-from-client')
        await this.close('protocol-rejected')
        return
    }
  }

  /** @param frames - One Host event source. */
  private async pump(frames: AsyncIterable<{ readonly rpcId: RpcId; readonly payload: MuxFrame | HostFrame }>): Promise<void> {
    try {
      for await (const frame of frames) {
        if (!this.isLive()) return
        const payload = wirePayload(frame.payload)
        if (payload === undefined) {
          this.gateway.audit(this.connection, 'event-delivery', 'rejected', 'frame-not-json')
          continue
        }
        const entry: RetainedEvent = {
          cursor: this.state.nextCursor++,
          eventId: this.gateway.newId(),
          requestId: parseRemoteWireId(frame.rpcId),
          event: frame.payload.type,
          payload,
        }
        this.state.events.push(entry)
        while (this.state.events.length > this.gateway.limits.maxEventEntriesPerDevice) this.state.events.shift()
        if (this.synchronized) await this.sendEvent(entry)
      }
    } catch {
      if (this.isLive()) await this.streamFailure()
    }
  }

  private async receiveLoop(): Promise<void> {
    try {
      for await (const envelope of this.connection.receive(this.abort.signal)) await this.receive(envelope)
    } catch {
      if (this.isLive()) this.gateway.audit(this.connection, 'connection', 'rejected', 'transport-read-failed')
    } finally {
      await this.close('transport-failed')
    }
  }

  private async request(message: Extract<RemoteWireEnvelope, { type: 'request' }>): Promise<void> {
    const result = await this.idempotent(message.idempotencyKey, {
      type: 'request', method: message.method, payload: message.payload,
    }, async () => {
      if (!this.authorize('request', message.requestId)) return this.unauthorizedFailure()
      return this.gateway.invoke(this.connection.peer, message.method, message.requestId, message.payload, this.abort.signal)
    })
    const delivery = await this.respond('request', message.requestId, result)
    this.gateway.audit(this.connection, 'request', delivery === 'delivered-current' ? 'completed' : 'rejected', delivery === 'delivered-current'
      ? result.ok ? 'api-completed' : 'api-refused'
      : delivery === 'committed-before-close' ? 'response-committed-before-close' : 'response-not-delivered', message.requestId)
  }

  private async approval(message: Extract<RemoteWireEnvelope, { type: 'approval' }>): Promise<void> {
    const result = await this.idempotent(message.idempotencyKey, {
      type: 'approval', requestId: message.requestId, sessionId: message.sessionId, approvalId: message.approvalId, outcome: message.outcome,
    }, async () => {
      if (!this.authorize('approval', message.requestId)) return this.unauthorizedFailure()
      return receiptResult(await this.gateway.api.respond({
        type: 'client-response',
        rpcId: rpcId(message.requestId),
        result: { ok: true, value: { sessionId: message.sessionId, approvalId: message.approvalId, outcome: message.outcome } },
      }))
    })
    const delivery = await this.respond('approval', message.requestId, result)
    this.gateway.audit(this.connection, 'approval', delivery === 'delivered-current' ? 'completed' : 'rejected', delivery === 'delivered-current'
      ? result.ok ? 'approval-routed' : 'approval-refused'
      : delivery === 'committed-before-close' ? 'response-committed-before-close' : 'response-not-delivered', message.requestId)
  }

  private async clientResponse(message: Extract<RemoteWireEnvelope, { type: 'client-response' }>): Promise<void> {
    const result = await this.idempotent(message.idempotencyKey, {
      type: 'client-response', requestId: message.requestId, result: message.result,
    }, async () => {
      if (!this.authorize('client-response', message.requestId)) return this.unauthorizedFailure()
      return receiptResult(await this.gateway.api.respond({
        type: 'client-response',
        rpcId: rpcId(message.requestId),
        result: message.result as ClientResponse['result'],
      }))
    })
    const delivery = await this.respond('client-response', message.requestId, result)
    this.gateway.audit(this.connection, 'client-response', delivery === 'delivered-current' ? 'completed' : 'rejected', delivery === 'delivered-current'
      ? result.ok ? 'response-routed' : 'response-refused'
      : delivery === 'committed-before-close' ? 'response-committed-before-close' : 'response-not-delivered', message.requestId)
  }

  private async deviceControl(message: Extract<RemoteWireEnvelope, { type: 'device-control' }>): Promise<void> {
    if (String(message.deviceId) !== String(this.connection.peer.deviceId)) {
      this.gateway.audit(this.connection, 'device-control', 'rejected', 'foreign-device', message.requestId)
      await this.close('protocol-rejected')
      return
    }
    const result = await this.idempotent(message.idempotencyKey, {
      type: 'device-control', action: message.action, payload: message.payload,
    }, async () => {
      if (!this.authorize('device-control', message.requestId)) return this.unauthorizedFailure()
      return this.runDeviceControl(message)
    })
    const delivery = await this.respond('device-control', message.requestId, result)
    if (delivery === 'delivered-current' && this.isLive() && message.action === 'device.describe' && result.ok) {
      const cursor = this.resultMode(result.value) === 'replay'
        ? this.resumeCursor(message.payload)
        : this.resultCursor(result.value)
      if (cursor !== undefined) {
        this.synchronized = true
        await this.replay(cursor)
      }
    }
    this.gateway.audit(this.connection, 'device-control', delivery === 'delivered-current' ? 'completed' : 'rejected', delivery === 'delivered-current'
      ? result.ok ? 'device-control-completed' : 'device-control-refused'
      : delivery === 'committed-before-close' ? 'response-committed-before-close' : 'response-not-delivered', message.requestId)
    if (delivery === 'delivered-current' && this.isLive() && message.action === 'device.disconnect' && result.ok) await this.close('transport-failed')
  }

  private async runDeviceControl(message: Extract<RemoteWireEnvelope, { type: 'device-control' }>): Promise<RemoteWireResult> {
    switch (message.action) {
      case 'device.describe':
        return this.synchronize(message.payload)
      case 'device.heartbeat':
        return this.heartbeat()
      case 'device.disconnect':
        return { ok: true, value: { disconnected: true } }
    }
  }

  private async synchronize(payload: RemoteWireJson): Promise<RemoteWireResult> {
    const resumeCursor = this.resumeCursor(payload)
    const latestCursor = this.state.nextCursor - 1
    const retainedFirst = this.state.events[0]?.cursor ?? latestCursor + 1
    if (resumeCursor !== undefined && resumeCursor >= retainedFirst - 1 && resumeCursor <= latestCursor) {
      return { ok: true, value: { mode: 'replay', cursor: latestCursor } }
    }
    // Capture before the asynchronous baseline reads. Events emitted while the
    // three reads settle are replayed after the snapshot, which can duplicate
    // a baseline fact but cannot make a Host transition disappear.
    const cursor = this.state.nextCursor - 1
    const snapshot = await this.gateway.snapshot(this.connection.peer, this.abort.signal)
    const value = wirePayload({ mode: 'snapshot', cursor, snapshot: { host: snapshot.host, sessions: snapshot.sessions, workspaces: snapshot.workspaces } })
    return value === undefined ? internalFailure() : { ok: true, value }
  }

  private async heartbeat(): Promise<RemoteWireResult> {
    try {
      if (!this.authorize('device-control')) return this.unauthorizedFailure()
      const device = await this.gateway.markSeen(this.connection.peer)
      return { ok: true, value: { device: wirePayload(device) ?? {} } }
    } catch {
      return { ok: false, error: { code: 'remote-device-unavailable', message: 'This device is no longer trusted by the Host', details: {} } }
    }
  }

  private resumeCursor(payload: RemoteWireJson): number | undefined {
    if (payload === null || Array.isArray(payload) || typeof payload !== 'object') return undefined
    const value = (payload as { readonly cursor?: RemoteWireJson }).cursor
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }

  private resultCursor(value: RemoteWireJson): number | undefined {
    if (value === null || Array.isArray(value) || typeof value !== 'object') return undefined
    const cursor = (value as { readonly cursor?: RemoteWireJson }).cursor
    return typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined
  }

  private resultMode(value: RemoteWireJson): 'replay' | 'snapshot' | undefined {
    if (value === null || Array.isArray(value) || typeof value !== 'object') return undefined
    const mode = (value as { readonly mode?: RemoteWireJson }).mode
    return mode === 'replay' || mode === 'snapshot' ? mode : undefined
  }

  private async acknowledge(cursor: number): Promise<void> {
    if (!this.authorize('stream-ack')) return
    if (cursor > this.state.nextCursor - 1 || cursor < this.state.acknowledgedCursor) {
      this.gateway.audit(this.connection, 'stream-ack', 'rejected', 'invalid-cursor')
      await this.close('protocol-rejected')
      return
    }
    this.state.acknowledgedCursor = cursor
    this.gateway.audit(this.connection, 'stream-ack', 'accepted', 'cursor-acknowledged')
  }

  private async replay(cursor: number): Promise<void> {
    for (const entry of this.state.events) {
      if (!this.isLive()) return
      if (entry.cursor > cursor) await this.sendEvent(entry)
    }
  }

  /** Recheck local authorization immediately before an operation reaches Host state. */
  private authorize(operation: RemoteGatewayAuditEntry['operation'], requestId?: RemoteWireId): boolean {
    if (!this.live || this.closed) {
      this.gateway.audit(this.connection, operation, 'rejected', 'connection-closed', requestId)
      return false
    }
    if (this.gateway.isTrusted(this.connection.peer)) return true
    this.gateway.audit(this.connection, operation, 'rejected', 'device-revoked', requestId)
    void this.close('unauthorized-device')
    return false
  }

  /** Read a synchronous local and Host-directory liveness guard before each use. */
  private isLive(): boolean {
    return this.live && !this.closed && this.gateway.isTrusted(this.connection.peer)
  }

  /** @returns a non-sensitive denial after the Host has revoked this device. */
  private unauthorizedFailure(): RemoteWireResult {
    return { ok: false, error: { code: 'remote-device-unavailable', message: 'This device is no longer trusted by the Host', details: {} } }
  }

  private async sendEvent(entry: RetainedEvent): Promise<DeliveryOutcome> {
    if (!this.authorize('event-delivery', entry.requestId)) return 'not-delivered'
    const delivery = await this.send({
      version: 3,
      type: 'event',
      connectionEpoch: this.connection.route.connectionEpoch,
      cursor: entry.cursor,
      eventId: entry.eventId,
      requestId: entry.requestId,
      event: entry.event,
      payload: entry.payload,
    })
    this.gateway.audit(this.connection, 'event-delivery', delivery === 'delivered-current' ? 'completed' : 'rejected', delivery === 'delivered-current'
      ? 'event-sent'
      : delivery === 'committed-before-close' ? 'event-committed-before-close' : 'event-not-delivered', entry.requestId)
    return delivery
  }

  private async streamFailure(): Promise<void> {
    // This bounded payload is entirely owned here, not a value from a Host
    // stream or connection provider that needs the generic JSON boundary.
    const payload: RemoteWireJson = {
      type: 'stream/error', error: { code: 'internal', message: 'Host event stream ended unexpectedly', details: {} },
    }
    const entry: RetainedEvent = {
      cursor: this.state.nextCursor++, eventId: this.gateway.newId(), requestId: this.gateway.newId(), event: 'stream/error', payload,
    }
    this.state.events.push(entry)
    while (this.state.events.length > this.gateway.limits.maxEventEntriesPerDevice) this.state.events.shift()
    if (this.synchronized) await this.sendEvent(entry)
  }

  private async respond(
    operation: RemoteGatewayAuditEntry['operation'],
    requestId: RemoteWireId,
    result: RemoteWireResult,
  ): Promise<DeliveryOutcome> {
    if (!this.authorize(operation, requestId)) return 'not-delivered'
    return this.send({ version: 3, type: 'response', connectionEpoch: this.connection.route.connectionEpoch, requestId, result })
  }

  private async idempotent(
    idempotencyKey: RemoteWireId,
    operation: unknown,
    run: () => Promise<RemoteWireResult>,
  ): Promise<RemoteWireResult> {
    const requestFingerprint = fingerprint(operation)
    const existing = this.state.idempotency.get(idempotencyKey)
    if (existing !== undefined) {
      const settled = await existing
      return settled.fingerprint === requestFingerprint
        ? settled.result
        : { ok: false, error: { code: 'remote-idempotency-conflict', message: 'This retry key belongs to a different remote operation', details: {} } }
    }
    const pending = Promise.resolve().then(run).then(
      result => ({ fingerprint: requestFingerprint, result }),
      () => ({ fingerprint: requestFingerprint, result: internalFailure() }),
    )
    this.state.idempotency.set(idempotencyKey, pending)
    const settled = await pending
    this.state.idempotency.set(idempotencyKey, settled)
    for (const oldest of this.state.idempotency.keys()) {
      if (!(this.state.idempotency.size > this.gateway.limits.maxIdempotencyEntriesPerDevice)) break
      this.state.idempotency.delete(oldest)
    }
    return settled.result
  }

  private async send(envelope: RemoteWireEnvelope): Promise<DeliveryOutcome> {
    if (!this.isLive()) return 'not-delivered'
    const sent = this.outbound.then(async () => {
      if (!this.isLive()) return 'not-delivered' as const
      const fenceGeneration = this.sendFence.generation
      const result = await this.connection.send(envelope, this.sendFence)
      if (result.status !== 'committed-before-fence') return 'not-delivered' as const
      return this.sendFence.active && this.sendFence.generation === fenceGeneration && this.isLive()
        ? 'delivered-current' as const
        : 'committed-before-close' as const
    })
    this.outbound = sent.then(() => {}, () => {})
    try {
      return await sent
    } catch {
      await this.close('transport-failed')
      return 'not-delivered'
    }
  }

}

/** Mount a dormant Host gateway. A future encrypted relay plugin explicitly calls `ctx.remoteGateway.serve(provider, signal)`. */
export function apply(ctx: Context, config: Config): void {
  const gateway = new RemoteGateway({
    api: ctx.apiProxy,
    devices: ctx.remoteDevices,
    now: () => new Date().toISOString(),
    newId: () => randomUUID() as RemoteWireId,
    audit: (entry) => { ctx.emit('remote-gateway/audit', entry) },
  }, config)
  ctx.effect(() => () => gateway.dispose())
  ctx.on('remote-devices/changed', (change: RemoteDeviceChange) => {
    if (change.type === 'revoked') gateway.revoke(change.deviceId)
  })
  ctx.provide('remoteGateway', gateway)
}
