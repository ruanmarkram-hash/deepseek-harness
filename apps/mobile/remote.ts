/**
 * Mobile owner-client state over an authenticated encrypted v3 connection.
 *
 * This module owns the device side of the verified relay handshake. It accepts
 * a raw route-authenticated socket only, then calls the relay protocol's fixed
 * Host finish, device acknowledgement, Host commit, and final Host receipt
 * verification before exposing a usable remote connection.
 */

import {
  MAX_REMOTE_WIRE_SEQUENCE,
  parseRemoteWireEnvelope,
  REMOTE_WIRE_VERSION,
  type RemoteWireApproval,
  type RemoteWireClientResponse,
  type RemoteWireDeviceControlEnvelope,
  type RemoteWireEnvelope,
  type RemoteWireEventEnvelope,
  type RemoteWireId,
  type RemoteWireJson,
  type RemoteWireMethod,
  type RemoteWireResult,
} from '@deepseek-ai/dsh-remote-wire'
import {
  connectRemoteRelayDevice,
  type RemoteRelaySendFence,
  type RemoteRelaySocket,
  type TrustedRemoteRelayConnection,
} from '@deepseek-ai/dsh-remote-relay-protocol'

/** Raw WebSocket factory for the exact authenticated V3 route. It cannot claim handshake success. */
export interface MobileRemoteSocketFactory {
  create(config: MobileRemoteConnectionConfig, abortSignal: AbortSignal): Promise<RemoteRelaySocket>
}

/** Trusted pairing provider that mirrors the Host's persisted exact-next route epoch. */
export interface MobileRemoteEpochProvider {
  /**
   * Returns the Host-provided exact next epoch. During finality recovery it may
   * reconcile exactly one higher than `expectedEpoch`, never an invented value.
   */
  nextConnectionEpoch(config: MobileRemoteConnectionConfig, expectedEpoch: number, abortSignal: AbortSignal): Promise<number>
  /**
   * Durably record the exact next epoch after the authenticated Host receipt.
   *
   * @param config - The accepted Host invitation coordinates.
   * @param connectionEpoch - The receipt-authenticated live epoch.
   * @param abortSignal - Cancels a retired connection attempt before persistence commits.
   * @returns Resolves only after the next exact epoch is durable.
   */
  recordAuthenticatedConnection(config: MobileRemoteConnectionConfig, connectionEpoch: number, abortSignal: AbortSignal): Promise<void>
}

/** The Host-issued exact-next epoch is unavailable locally, so a new physical invitation is required. */
export class MobileRemoteReEnrollmentRequiredError extends Error {
  constructor() { super('This phone needs a fresh Host invitation before it can reconnect.') }
}

/** Hardware- or Keychain-protected X25519 agreement operation. */
export interface MobileProtectedAgreement {
  /** Canonical base64url X25519 public key enrolled with the DSH Host. */
  readonly publicKey: string
  /**
   * Derive a fresh 32-byte X25519 shared-secret copy for a canonical Host public key.
   * The provider never exposes or stores the mobile private agreement key in JS state.
   */
  deriveSharedSecret(peerAgreementPublicKey: string): Uint8Array
}

/** Stable public mobile identity. Private material never leaves its provider. */
export interface MobileDeviceIdentity {
  readonly deviceId: RemoteWireId
  /** Canonical base64url Ed25519 verification key enrolled with the DSH Host. */
  readonly signingPublicKey: string
  readonly agreement: MobileProtectedAgreement
}

/** Native Keychain/Secure Enclave and biometric owner seam. */
export interface MobileIdentityProvider {
  /** Loads or creates the device identity without exposing its private key. */
  deviceIdentity(): Promise<MobileDeviceIdentity>
  /** Requires current device-owner presence before starting a remote connection. */
  requireUserPresence(): Promise<void>
  /** Drops any native in-memory private-key session after the remote transport retires. */
  clearUserPresence(): void
}

/** V3 route material provided by an explicit Host pairing flow. Never render or log it. */
export interface MobileRemoteConnectionConfig {
  readonly clientAuthToken: string
  readonly connectionEpoch: number
  /** Host-minted device-enrollment incarnation from the accepted invitation. */
  readonly deviceEnrollmentId: string
  readonly hostDeviceId: string
  /** Host enrollment incarnation pinned by the same accepted invitation. */
  readonly hostEnrollmentId: string
  readonly hostStaticAgreementPublicKey: string
  readonly routeGeneration: number
  readonly routeId: string
}

/** Optional durable cursor store. Without one, the client never acknowledges host events. */
export interface RemoteEventCursorStore {
  apply(event: RemoteWireEventEnvelope): Promise<void>
  read(): Promise<number>
  /** Replace the cursor only while a Host snapshot replaces the local projection. */
  replace(cursor: number): Promise<void>
}

/** Observable connection status without credentials, QR material, or private keys. */
export type MobileRemoteState =
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly connectionEpoch: number }
  | { readonly kind: 'reconnecting'; readonly reason: 'network' | 'route-expired' }
  | { readonly kind: 're-pair-required' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'error'; readonly message: string }

/** Fixed local teardown reason; it never changes authentication or disconnect behavior. */
export type MobileRemoteDisconnectReason = 'background' | 'unmount' | 'manual'

/** Non-sensitive cancellation facts captured before the live attempt is cleared. */
export interface MobileRemoteDisconnectNotice {
  readonly reason: MobileRemoteDisconnectReason
  readonly stage: ConnectionStage | undefined
}

/** Callbacks for owner-client state. Event payloads remain Host-owned JSON. */
export interface MobileRemoteClientOptions {
  readonly cursorStore?: RemoteEventCursorStore
  /** Maximum time one owner-presence, socket-open, and V3 handshake attempt may retain native key access. */
  readonly connectionTimeoutMs?: number
  readonly identityProvider: MobileIdentityProvider
  /** Merges a current Host `session.list` result without discarding replay-backed detail. */
  readonly onSnapshot: (value: RemoteWireJson) => Promise<void> | void
  /** Replaces the entire projection only when `device.describe` returns a Host restart snapshot. */
  readonly onBaselineSnapshot?: (value: RemoteWireJson) => Promise<void> | void
  readonly onEvent: (event: RemoteWireEventEnvelope) => void
  readonly onState: (state: MobileRemoteState) => void
  /** Presentation-only local teardown facts. Never persist them as connection authority. */
  readonly onDisconnect?: (notice: MobileRemoteDisconnectNotice) => void
  readonly randomBytes: (length: number) => Uint8Array
  readonly epochProvider: MobileRemoteEpochProvider
  readonly socketFactory: MobileRemoteSocketFactory
}

interface PendingRequest {
  readonly reject: (reason: Error) => void
  readonly resolve: (result: RemoteWireResult) => void
}

interface ActiveConnection {
  readonly deviceId: RemoteWireId
  readonly epoch: number
  readonly fence: { readonly controller: AbortController; readonly generation: number }
  readonly generation: number
  readonly snapshotReady: Promise<void>
  readonly transport: TrustedRemoteRelayConnection
  releaseSnapshot: () => void
}

const ID_BYTES = 24
/** The mobile client releases native owner presence when a foreground V3 attempt does not settle promptly. */
export const DEFAULT_MOBILE_REMOTE_CONNECTION_TIMEOUT_MS = 20_000

interface ConnectingAttempt {
  readonly config: MobileRemoteConnectionConfig
  readonly controller: AbortController
  epoch: number
  stage: ConnectionStage
  socket: RemoteRelaySocket | undefined
  timeout: ReturnType<typeof setTimeout> | undefined
}

/** Closed, value-free stages of a foreground mobile connection attempt. */
export type ConnectionStage = 'owner-presence' | 'identity' | 'relay-open' | 'hello-send' | 'host-handshake' | 'host-bootstrap'

const CONNECTION_STAGE_HELP: Record<ConnectionStage, string> = {
  'owner-presence': 'Owner authentication did not complete.',
  'identity': 'The protected phone identity could not be loaded.',
  'relay-open': 'The phone could not open the relay connection. Check its internet connection.',
  'hello-send': 'The phone could not prepare or send its first handshake message.',
  'host-handshake': 'The encrypted Host handshake did not complete. Check that the Host is waiting for this phone.',
  'host-bootstrap': 'The authenticated Host connection could not finish loading the workspace.',
}

interface HostSynchronization {
  readonly cursor: number
  readonly mode: 'replay' | 'snapshot'
  readonly snapshot: RemoteWireJson | undefined
}

function connectionTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_MOBILE_REMOTE_CONNECTION_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('Mobile connection timeout must be a positive whole number of milliseconds')
  return timeout
}

function randomWireId(randomBytes: (length: number) => Uint8Array): RemoteWireId {
  const bytes = randomBytes(ID_BYTES)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== ID_BYTES) throw new Error('Mobile identity random source failed')
  try {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') as RemoteWireId
  } finally {
    bytes.fill(0)
  }
}

function hostSynchronization(value: RemoteWireJson): HostSynchronization {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('The signed Host synchronization response is malformed')
  const record = value as Record<string, RemoteWireJson>
  const cursor = record.cursor
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > MAX_REMOTE_WIRE_SEQUENCE) {
    throw new Error('The signed Host synchronization cursor is malformed')
  }
  if (record.mode === 'replay') return { mode: 'replay', cursor, snapshot: undefined }
  if (record.mode === 'snapshot' && record.snapshot !== undefined) return { mode: 'snapshot', cursor, snapshot: record.snapshot }
  throw new Error('The signed Host synchronization mode is malformed')
}

/**
 * Keeps remote request correlations and event acknowledgement after the relay
 * protocol has verified the enrolled Host identity plus encrypted finish/ack/commit.
 */
export class MobileRemoteClient {
  private readonly cursorStore: RemoteEventCursorStore | undefined
  private readonly identityProvider: MobileIdentityProvider
  private readonly onEvent: (event: RemoteWireEventEnvelope) => void
  private readonly onSnapshot: (value: RemoteWireJson) => Promise<void> | void
  private readonly onBaselineSnapshot: ((value: RemoteWireJson) => Promise<void> | void) | undefined
  private readonly onState: (state: MobileRemoteState) => void
  private readonly onDisconnect: ((notice: MobileRemoteDisconnectNotice) => void) | undefined
  private readonly randomBytes: (length: number) => Uint8Array
  private config: MobileRemoteConnectionConfig | undefined
  private activeEpoch: number | undefined
  private expectedEpoch: number | undefined
  private connecting: ConnectingAttempt | undefined
  private transport: TrustedRemoteRelayConnection | undefined
  private sendFence: { readonly controller: AbortController; readonly generation: number } | undefined
  private readonly socketFactory: MobileRemoteSocketFactory
  private readonly epochProvider: MobileRemoteEpochProvider
  private readonly connectionTimeoutMs: number
  private activeConnection: ActiveConnection | undefined
  private connectionGeneration = 0
  private eventTail: Promise<void> = Promise.resolve()
  private pending = new Map<RemoteWireId, PendingRequest>()
  private state: MobileRemoteState = { kind: 'unconfigured' }

  /** @param options - Platform providers and UI observers for one mobile process. */
  constructor(options: MobileRemoteClientOptions) {
    this.cursorStore = options.cursorStore
    this.identityProvider = options.identityProvider
    this.onEvent = options.onEvent
    this.onSnapshot = options.onSnapshot
    this.onBaselineSnapshot = options.onBaselineSnapshot
    this.onState = options.onState
    this.onDisconnect = options.onDisconnect
    this.randomBytes = options.randomBytes
    this.epochProvider = options.epochProvider
    this.socketFactory = options.socketFactory
    this.connectionTimeoutMs = connectionTimeout(options.connectionTimeoutMs)
  }

  /** Establish a fresh V3 connection at the epoch embedded in a trusted invitation. */
  async connect(config: MobileRemoteConnectionConfig): Promise<void> {
    this.cancelConnecting()
    this.identityProvider.clearUserPresence()
    this.disconnectPending(new Error('A newer remote connection replaced this request'))
    this.sendFence?.controller.abort()
    this.transport?.close()
    this.transport = undefined
    this.config = config
    this.activeEpoch = undefined
    this.expectedEpoch = config.connectionEpoch
    await this.connectAt(config, config.connectionEpoch)
  }

  /** Reconnect at the matching Host-persisted exact-next epoch. */
  async reconnect(): Promise<void> {
    const config = this.config
    const expectedEpoch = this.expectedEpoch
    if (this.state.kind !== 'reconnecting' && this.state.kind !== 'error') return
    if (config === undefined || expectedEpoch === undefined || this.transport !== undefined) {
      this.publish({ kind: 'error', message: 'The previous Host connection has not retired safely.' })
      return
    }
    this.cancelConnecting()
    const controller = new AbortController()
    this.connecting = { config, controller, epoch: expectedEpoch, stage: 'owner-presence', socket: undefined, timeout: undefined }
    try {
      const hostEpoch = await this.epochProvider.nextConnectionEpoch(config, expectedEpoch, controller.signal)
      const finalityRecovery = expectedEpoch < MAX_REMOTE_WIRE_SEQUENCE && hostEpoch === expectedEpoch + 1
      if (controller.signal.aborted || (hostEpoch !== expectedEpoch && !finalityRecovery)) {
        if (!controller.signal.aborted) this.publish({ kind: 'error', message: 'The Host did not supply the expected connection epoch.' })
        return
      }
      this.expectedEpoch = hostEpoch
      await this.connectAt(config, hostEpoch, controller)
    } catch (error) {
      if (!controller.signal.aborted && this.config === config) {
        this.publish(error instanceof MobileRemoteReEnrollmentRequiredError
          ? { kind: 're-pair-required' }
          : { kind: 'error', message: 'Could not obtain the next Host connection epoch.' })
      }
    } finally {
      if (this.connecting?.controller === controller) this.connecting = undefined
    }
  }

  private async connectAt(config: MobileRemoteConnectionConfig, epoch: number, existingController?: AbortController): Promise<void> {
    this.publish({ kind: 'connecting' })
    const controller = existingController ?? new AbortController()
    const connecting: ConnectingAttempt = this.connecting?.controller === controller
      ? this.connecting
      : { config, controller, epoch, stage: 'owner-presence', socket: undefined, timeout: undefined }
    connecting.epoch = epoch
    this.connecting = connecting
    this.armConnectionDeadline(connecting)
    let transport: TrustedRemoteRelayConnection | undefined
    try {
      const presencePromise = Promise.resolve().then(() => this.identityProvider.requireUserPresence())
      void presencePromise.then(() => {
        if (
          controller.signal.aborted && this.connecting === undefined && this.transport === undefined
        ) this.identityProvider.clearUserPresence()
      }, () => undefined)
      await this.awaitAttempt(presencePromise, connecting)
      if (controller.signal.aborted) return
      connecting.stage = 'identity'
      const identity = await this.awaitAttempt(Promise.resolve().then(() => this.identityProvider.deviceIdentity()), connecting)
      if (controller.signal.aborted) return
      connecting.stage = 'relay-open'
      const socketPromise = Promise.resolve().then(() => this.socketFactory.create(config, controller.signal))
      void socketPromise.then((socket) => {
        if (controller.signal.aborted) this.closeSocket(socket, 'mobile-connection-cancelled')
      }, () => undefined)
      const socket = await this.awaitAttempt(socketPromise, connecting)
      connecting.socket = socket
      if (controller.signal.aborted) {
        this.closeSocket(socket, 'mobile-connection-cancelled')
        return
      }
      connecting.stage = 'hello-send'
      let helloSent = false
      // A successful carrier send is not proof that the relay or Host received it.
      const handshakeSocket: RemoteRelaySocket = {
        send(data): void {
          socket.send(data)
          if (!helloSent) {
            helloSent = true
            connecting.stage = 'host-handshake'
          }
        },
        close: (code, reason) => socket.close(code, reason),
        receive: signal => socket.receive(signal),
      }
      transport = await this.awaitAttempt(connectRemoteRelayDevice({
        socket: handshakeSocket,
        identity: { deviceId: identity.deviceId, enrollmentId: config.deviceEnrollmentId, agreement: identity.agreement },
        host: {
          deviceId: config.hostDeviceId,
          enrollmentId: config.hostEnrollmentId,
          agreementPublicKey: config.hostStaticAgreementPublicKey,
        },
        route: { routeId: config.routeId, generation: config.routeGeneration, connectionEpoch: epoch },
        random: { randomBytes: this.randomBytes },
        signal: controller.signal,
      }), connecting)
      if (controller.signal.aborted || this.config !== config || this.expectedEpoch !== epoch) {
        transport.close()
        return
      }
      connecting.stage = 'host-bootstrap'
      await this.awaitAttempt(this.epochProvider.recordAuthenticatedConnection(config, epoch, controller.signal), connecting)
      if (controller.signal.aborted || this.config !== config || this.expectedEpoch !== epoch) {
        transport.close()
        return
      }
      if (epoch >= MAX_REMOTE_WIRE_SEQUENCE) {
        transport.close('remote-epoch-exhausted')
        this.config = undefined
        this.publish({ kind: 'error', message: 'The Host connection reached its supported epoch limit.' })
        return
      }
      this.expectedEpoch = epoch + 1
      const fence = { controller: new AbortController(), generation: epoch }
      let releaseSnapshot: (() => void) | undefined
      const snapshotReady = new Promise<void>((resolve) => { releaseSnapshot = resolve })
      const activation: ActiveConnection = {
        deviceId: identity.deviceId,
        epoch,
        fence,
        generation: ++this.connectionGeneration,
        snapshotReady,
        transport,
        releaseSnapshot: () => releaseSnapshot?.(),
      }
      this.transport = transport
      this.activeEpoch = epoch
      this.sendFence = fence
      this.activeConnection = activation
      void this.receive(transport)
      await this.bootstrapHost(activation, connecting)
      if (!this.isActive(activation) || controller.signal.aborted || this.config !== config || this.expectedEpoch !== epoch + 1) {
        transport.close()
        return
      }
      this.clearConnectionDeadline(connecting)
      this.connecting = undefined
      this.publish({ kind: 'connected', connectionEpoch: epoch })
    } catch {
      if (transport !== undefined) {
        this.retireActive(transport)
        transport.close('mobile-connection-bootstrap-failed')
      }
      this.identityProvider.clearUserPresence()
      if (!controller.signal.aborted && this.config === config) this.publish({
        kind: 'error',
        message: `Connection stopped at ${connecting.stage}. ${CONNECTION_STAGE_HELP[connecting.stage]} You can retry.`,
      })
    } finally {
      if (this.connecting === connecting) {
        this.clearConnectionDeadline(connecting)
        this.connecting = undefined
      }
    }
  }

  /**
   * Clear live relay state without modifying durable pairing credentials.
   * @param reason - Fixed presentation-only cause; all causes perform the same complete teardown.
   */
  disconnect(reason: MobileRemoteDisconnectReason = 'manual'): void {
    const notice = { reason, stage: this.connecting?.stage }
    this.config = undefined
    this.expectedEpoch = undefined
    this.activeEpoch = undefined
    this.cancelConnecting()
    const transport = this.transport
    this.retireActive(transport)
    transport?.close()
    this.identityProvider.clearUserPresence()
    this.disconnectPending(new Error('Remote connection closed'))
    this.publish({ kind: 'disconnected' })
    try { this.onDisconnect?.(notice) } catch { console.warn('Mobile disconnect observer failed') }
  }

  /** Invoke one public Host API method through the encrypted remote gateway. */
  request(method: RemoteWireMethod, payload: RemoteWireJson): Promise<RemoteWireResult> {
    const transport = this.transport
    const epoch = this.activeEpoch
    if (transport === undefined || epoch === undefined || this.state.kind !== 'connected') {
      return Promise.reject(new Error('DSH Host is not connected'))
    }
    const requestId = randomWireId(this.randomBytes)
    const idempotencyKey = randomWireId(this.randomBytes)
    const result = new Promise<RemoteWireResult>((resolve, reject) => this.pending.set(requestId, { resolve, reject }))
    void this.sendRequest(transport, requestId, { version: REMOTE_WIRE_VERSION, type: 'request', connectionEpoch: epoch, requestId, idempotencyKey, method, payload })
    return result
  }

  /** Reply to a pending Host approval exactly once or reject it. */
  respondApproval(input: Omit<RemoteWireApproval, 'version' | 'type' | 'connectionEpoch' | 'idempotencyKey'>): void {
    void this.sendControl({
      version: REMOTE_WIRE_VERSION, type: 'approval', connectionEpoch: this.requiredEpoch(),
      ...input, idempotencyKey: randomWireId(this.randomBytes),
    })
  }

  /** Return an answerable Host request result. */
  respondToHost(input: Omit<RemoteWireClientResponse, 'version' | 'type' | 'connectionEpoch' | 'idempotencyKey'>): void {
    void this.sendControl({
      version: REMOTE_WIRE_VERSION, type: 'client-response', connectionEpoch: this.requiredEpoch(),
      ...input, idempotencyKey: randomWireId(this.randomBytes),
    })
  }

  /** Mark one device as revoked when the durable pairing provider invalidates its route. */
  revoke(): void {
    this.config = undefined
    this.expectedEpoch = undefined
    this.activeEpoch = undefined
    this.cancelConnecting()
    const transport = this.transport
    this.retireActive(transport)
    transport?.close('device-revoked')
    this.identityProvider.clearUserPresence()
    this.disconnectPending(new Error('Remote device revoked'))
    this.publish({ kind: 'revoked' })
  }

  private handleClose(transport: TrustedRemoteRelayConnection, reason: 'network' | 'route-expired'): void {
    if (transport !== this.transport) return
    this.retireActive(transport)
    if (this.state.kind === 'connecting') this.connecting?.controller.abort()
    this.identityProvider.clearUserPresence()
    this.disconnectPending(new Error('Remote connection closed'))
    this.publish({ kind: 'reconnecting', reason })
  }

  private async receive(transport: TrustedRemoteRelayConnection): Promise<void> {
    try {
      for await (const envelope of transport.receive()) this.handleEnvelope(transport, envelope)
      this.handleClose(transport, 'network')
    } catch {
      this.handleClose(transport, 'network')
    }
  }

  private handleEnvelope(transport: TrustedRemoteRelayConnection, raw: unknown): void {
    if (transport !== this.transport) return
    let envelope: RemoteWireEnvelope
    try {
      envelope = parseRemoteWireEnvelope(raw)
    } catch {
      transport.close()
      this.config = undefined
      this.publish({ kind: 'error', message: 'The Host connection stopped safely after invalid remote traffic.' })
      return
    }
    if (envelope.connectionEpoch !== this.activeEpoch) return
    if (envelope.type === 'response') {
      const pending = this.pending.get(envelope.requestId)
      if (pending === undefined) return
      this.pending.delete(envelope.requestId)
      pending.resolve(envelope.result)
      return
    }
    if (envelope.type === 'event') {
      this.enqueueEvent(transport, envelope)
    }
  }

  private enqueueEvent(transport: TrustedRemoteRelayConnection, event: RemoteWireEventEnvelope): void {
    const activation = this.activeConnection
    if (activation === undefined || activation.transport !== transport || activation.epoch !== event.connectionEpoch) return
    this.eventTail = this.eventTail.catch(() => undefined).then(async () => {
      await activation.snapshotReady
      if (!this.isActive(activation) || this.cursorStore === undefined) return
      try {
        const previous = await this.cursorStore.read()
        if (!this.isActive(activation) || event.cursor <= previous) return
        if (event.cursor !== previous + 1) {
          this.failEventDelivery(activation)
          return
        }
        this.onEvent(event)
        if (!this.isActive(activation)) return
        await this.cursorStore.apply(event)
        if (!this.isActive(activation)) return
        await this.sendControlOn(activation, { version: REMOTE_WIRE_VERSION, type: 'stream-ack', connectionEpoch: activation.epoch, cursor: event.cursor })
      } catch {
        // The projection cannot safely advance without its durable cursor.
        this.failEventDelivery(activation)
      }
    })
  }

  /** Retire the exact source transport after a cursor gap or durable projection failure. */
  private failEventDelivery(activation: ActiveConnection): void {
    if (!this.isActive(activation)) return
    this.retireActive(activation.transport)
    this.identityProvider.clearUserPresence()
    this.disconnectPending(new Error('The Host event stream requires a fresh synchronization'))
    activation.transport.close('mobile-event-sync-failed')
    this.publish({ kind: 'reconnecting', reason: 'network' })
  }

  private async bootstrapHost(activation: ActiveConnection, connecting: ConnectingAttempt): Promise<void> {
    const cursor = this.cursorStore === undefined
      ? 0
      : await this.awaitAttempt(this.cursorStore.read(), connecting)
    const described = await this.awaitAttempt(this.deviceControlOn(activation, 'device.describe', { cursor }), connecting)
    if (!described.ok) throw new Error('The signed Host rejected its device description request')
    const synchronization = hostSynchronization(described.value)
    if (synchronization.mode === 'snapshot') {
      if (this.cursorStore === undefined) throw new Error('The Host snapshot requires durable mobile cursor storage')
      await this.awaitAttempt(
        Promise.resolve((this.onBaselineSnapshot ?? this.onSnapshot)(synchronization.snapshot as RemoteWireJson)), connecting)
      if (!this.isActive(activation)) throw new Error('The Host connection retired before its snapshot completed')
      await this.awaitAttempt(this.cursorStore.replace(synchronization.cursor), connecting)
    }
    const snapshot = await this.awaitAttempt(this.requestOn(activation, 'session.list', {}), connecting)
    if (!snapshot.ok) throw new Error('The signed Host did not provide a session snapshot')
    await this.awaitAttempt(Promise.resolve(this.onSnapshot(snapshot.value)), connecting)
    if (!this.isActive(activation)) throw new Error('The Host connection retired before its snapshot completed')
    activation.releaseSnapshot()
  }

  private requestOn(activation: ActiveConnection, method: RemoteWireMethod, payload: RemoteWireJson): Promise<RemoteWireResult> {
    if (!this.isActive(activation)) return Promise.reject(new Error('DSH Host is not connected'))
    const requestId = randomWireId(this.randomBytes)
    const idempotencyKey = randomWireId(this.randomBytes)
    const result = new Promise<RemoteWireResult>((resolve, reject) => this.pending.set(requestId, { resolve, reject }))
    void this.sendRequestOn(activation.transport, requestId, {
      version: REMOTE_WIRE_VERSION,
      type: 'request',
      connectionEpoch: activation.epoch,
      requestId,
      idempotencyKey,
      method,
      payload,
    }, this.fenceFor(activation))
    return result
  }

  private deviceControlOn(activation: ActiveConnection, action: RemoteWireDeviceControlEnvelope['action'], payload: RemoteWireJson): Promise<RemoteWireResult> {
    if (!this.isActive(activation)) return Promise.reject(new Error('DSH Host is not connected'))
    const requestId = randomWireId(this.randomBytes)
    const idempotencyKey = randomWireId(this.randomBytes)
    const result = new Promise<RemoteWireResult>((resolve, reject) => this.pending.set(requestId, { resolve, reject }))
    void this.sendRequestOn(activation.transport, requestId, {
      version: REMOTE_WIRE_VERSION,
      type: 'device-control',
      connectionEpoch: activation.epoch,
      requestId,
      idempotencyKey,
      deviceId: activation.deviceId,
      action,
      payload,
    }, this.fenceFor(activation))
    return result
  }

  private isActive(activation: ActiveConnection): boolean {
    return this.activeConnection === activation
      && this.transport === activation.transport
      && this.activeEpoch === activation.epoch
      && this.sendFence === activation.fence
      && !activation.fence.controller.signal.aborted
  }

  private retireActive(transport: TrustedRemoteRelayConnection | undefined): void {
    if (transport !== undefined && this.transport !== transport) return
    const activation = this.activeConnection
    activation?.releaseSnapshot()
    activation?.fence.controller.abort()
    this.activeConnection = undefined
    this.sendFence?.controller.abort()
    this.sendFence = undefined
    this.transport = undefined
    this.activeEpoch = undefined
  }

  private requiredEpoch(): number {
    if (this.activeEpoch === undefined || this.transport === undefined || this.state.kind !== 'connected') throw new Error('DSH Host is not connected')
    return this.activeEpoch
  }

  private async sendRequest(transport: TrustedRemoteRelayConnection, requestId: RemoteWireId, envelope: RemoteWireEnvelope): Promise<void> {
    await this.sendRequestOn(transport, requestId, envelope, this.requiredFence())
  }

  private async sendRequestOn(
    transport: TrustedRemoteRelayConnection, requestId: RemoteWireId, envelope: RemoteWireEnvelope, fence: RemoteRelaySendFence,
  ): Promise<void> {
    try {
      const result = await transport.send(envelope, fence)
      if (result.status === 'committed-before-fence') return
      const pending = this.pending.get(requestId)
      this.pending.delete(requestId)
      pending?.reject(new Error('Could not send request to DSH Host'))
    } catch {
      const pending = this.pending.get(requestId)
      this.pending.delete(requestId)
      pending?.reject(new Error('Could not send request to DSH Host'))
    }
  }

  private async sendControl(envelope: RemoteWireEnvelope): Promise<void> {
    const activation = this.activeConnection
    if (activation === undefined || !this.isActive(activation)) throw new Error('DSH Host is not connected')
    await this.sendControlOn(activation, envelope)
  }

  private async sendControlOn(activation: ActiveConnection, envelope: RemoteWireEnvelope): Promise<void> {
    if (!this.isActive(activation)) throw new Error('DSH Host is not connected')
    const result = await activation.transport.send(envelope, this.fenceFor(activation))
    if (result.status !== 'committed-before-fence') throw new Error('Could not send request to DSH Host')
  }

  private requiredFence(): RemoteRelaySendFence {
    const fence = this.sendFence
    if (fence === undefined || fence.controller.signal.aborted) throw new Error('DSH Host is not connected')
    return { active: true, generation: fence.generation, abortSignal: fence.controller.signal }
  }

  private fenceFor(activation: ActiveConnection): RemoteRelaySendFence {
    return { active: true, generation: activation.fence.generation, abortSignal: activation.fence.controller.signal }
  }

  private disconnectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private cancelConnecting(): void {
    const connecting = this.connecting
    if (connecting === undefined) return
    this.connecting = undefined
    this.clearConnectionDeadline(connecting)
    connecting.controller.abort()
    this.identityProvider.clearUserPresence()
    if (connecting.socket !== undefined) this.closeSocket(connecting.socket, 'mobile-connection-cancelled')
  }

  private armConnectionDeadline(connecting: ConnectingAttempt): void {
    this.clearConnectionDeadline(connecting)
    connecting.timeout = setTimeout(() => {
      if (this.connecting !== connecting || this.config !== connecting.config) return
      const transport = this.transport
      this.retireActive(transport)
      connecting.controller.abort()
      this.identityProvider.clearUserPresence()
      transport?.close('mobile-connection-timeout')
      if (connecting.socket !== undefined) this.closeSocket(connecting.socket, 'mobile-connection-timeout')
      this.disconnectPending(new Error('The Host connection did not complete before its deadline'))
      this.connecting = undefined
      this.publish({ kind: 'error', message: `The encrypted Host connection timed out at ${connecting.stage}. You can retry.` })
    }, this.connectionTimeoutMs)
  }

  private awaitAttempt<T>(operation: Promise<T>, connecting: ConnectingAttempt): Promise<T> {
    if (connecting.controller.signal.aborted) return Promise.reject(new Error('DSH Host connection cancelled'))
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        connecting.controller.signal.removeEventListener('abort', abort)
        reject(new Error('DSH Host connection cancelled'))
      }
      operation.then(
        (value) => {
          connecting.controller.signal.removeEventListener('abort', abort)
          resolve(value)
        },
        (error) => {
          connecting.controller.signal.removeEventListener('abort', abort)
          reject(error)
        },
      )
      connecting.controller.signal.addEventListener('abort', abort, { once: true })
      if (connecting.controller.signal.aborted) abort()
    })
  }

  private clearConnectionDeadline(connecting: ConnectingAttempt): void {
    if (connecting.timeout === undefined) return
    clearTimeout(connecting.timeout)
    connecting.timeout = undefined
  }

  private closeSocket(socket: RemoteRelaySocket, reason: string): void {
    try { socket.close(1000, reason) } catch { /* Raw relay socket cleanup is best effort. */ }
  }

  private publish(state: MobileRemoteState): void {
    this.state = state
    try { this.onState(state) } catch { console.warn('Mobile state observer failed') }
  }
}
