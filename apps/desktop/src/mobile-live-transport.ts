import { randomBytes } from 'node:crypto'
import {
  PAIRING_PROTOCOL_VERSION,
  confirmPairingKey,
  createDesktopPairingProof,
  createMobileSessionCipher,
  parseMobilePairingInit,
  serializeRelayFrame,
  verifyMobilePairingProof,
  type MobilePairingCapability,
  type MobileSessionCipher,
} from '@deepseek-ai/dsh-pairing-protocol'
import { LocalSessionApi, type LocalDesktopSession } from './local-session-api.js'
import { DesktopPairingBridge, type DesktopPairingBootstrap, type DesktopPairingConnection } from './mobile-pairing.js'
import { MobileSessionProjection, type MobileSessionView } from './mobile-session-projection.js'

const POLL_INTERVAL_MS = 2_000
const MAX_TIMER_MS = 2_147_483_647

/** Tiny abstraction over Electron/Node's main-process WebSocket. */
export interface DesktopRelaySocket {
  close(code?: number, reason?: string): void
  send(data: string): void
  onclose: ((event: { readonly code: number }) => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onopen: (() => void) | null
}

/** The Electron-main WebSocket factory. The renderer never sees bearer credentials. */
export type DesktopRelaySocketFactory = (url: string, protocols: string[]) => DesktopRelaySocket

interface TransportAttempt {
  readonly connection: DesktopPairingConnection
  readonly generation: number
  readonly socket: DesktopRelaySocket
}

/** Native confirmation callbacks; absence means denial. */
export interface MobileApproval {
  approvePairing?(capabilities: readonly MobilePairingCapability[]): Promise<boolean>
  approvePrompt?(text: string): Promise<boolean>
}

/** Non-secret desktop UI state. It is safe for the dedicated pairing window. */
export type DesktopMobileTransportState =
  | { readonly status: 'idle' }
  | { readonly status: 'creating' }
  | { readonly status: 'awaiting-phone'; readonly expiresAt: number }
  | { readonly status: 'awaiting-desktop-approval' }
  | { readonly status: 'paired' }
  | { readonly status: 'closed'; readonly reason: 'denied' | 'failed' | 'revoked' }

/**
 * Electron-main only encrypted mobile connection. It has one local desktop
 * session and one relay socket, closes on any fault, and never exposes a raw
 * event stream or general DSH API surface.
 */
export class DesktopMobileTransport {
  private readonly projection = new MobileSessionProjection()
  private readonly relaySocket: DesktopRelaySocketFactory
  private currentState: DesktopMobileTransportState = { status: 'idle' }
  private socket: DesktopRelaySocket | undefined
  private connection: DesktopPairingConnection | undefined
  private cipher: MobileSessionCipher | undefined
  private selectedSession: LocalDesktopSession | undefined
  private selectedView: MobileSessionView | undefined
  private poll: ReturnType<typeof setInterval> | undefined
  private expiry: ReturnType<typeof setTimeout> | undefined
  private refreshInFlight: TransportAttempt | undefined
  private acceptingMobile: TransportAttempt | undefined
  private closed = false
  private generation = 0
  private activeGeneration: number | undefined

  /** Construct one main-process bridge around fixed local and relay endpoints. */
  constructor(
    private readonly pairing: DesktopPairingBridge,
    private readonly localSessions: LocalSessionApi,
    private readonly approval: MobileApproval = {},
    socketFactory: DesktopRelaySocketFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as DesktopRelaySocket,
    private readonly onStateChange: (state: DesktopMobileTransportState) => void = () => undefined,
  ) {
    this.relaySocket = socketFactory
  }

  /** Return a defensive status snapshot without handles, tokens, or session ids. */
  state(): DesktopMobileTransportState {
    return { ...this.currentState }
  }

  /** Read local sessions for a desktop-only picker. Never sent to the phone. */
  listSelectableSessions(): Promise<readonly LocalDesktopSession[]> {
    return this.localSessions.listSessions()
  }

  /**
   * Start one pairing for the desktop-selected existing session. The QR value
   * is returned only to the isolated pairing window for immediate display.
   */
  async start(session: LocalDesktopSession): Promise<DesktopPairingBootstrap> {
    if (this.currentState.status !== 'idle' && this.currentState.status !== 'closed') {
      throw new Error('DSH Desktop mobile pairing is already active.')
    }
    this.reset('failed', false)
    this.closed = false
    const generation = ++this.generation
    this.activeGeneration = generation
    this.setState({ status: 'creating' })
    try {
      const history = await this.localSessions.history(session)
      if (!this.isCurrentGeneration(generation)) throw new Error('DSH Desktop mobile pairing was replaced.')
      const view = this.projection.project([{ sessionKey: session.key, history }])[0]
      this.projection.select(view.handle)
      this.selectedSession = { key: session.key }
      this.selectedView = view

      const bootstrap = await this.pairing.create()
      if (!this.isCurrentGeneration(generation)) throw new Error('DSH Desktop mobile pairing was replaced.')
      this.connection = this.pairing.connection()
      const socket = this.relaySocket(this.connection.relayConnectUrl, [
        'dsh-pairing-v2',
        `dsh-desktop.${this.connection.desktopRelayToken}`,
      ])
      this.socket = socket
      const boundAttempt = this.currentAttempt()
      if (boundAttempt === undefined) throw new Error('DSH Desktop mobile pairing was replaced.')
      this.expiry = setTimeout(
        () => { if (this.isCurrentAttempt(boundAttempt)) this.reset('failed') },
        Math.min(MAX_TIMER_MS, Math.max(1, boundAttempt.connection.bootstrap.expiresAt - Date.now())),
      )
      this.bindSocket(socket)
      return bootstrap
    } catch (error) {
      if (this.isCurrentGeneration(generation)) this.reset('failed')
      throw error instanceof Error ? error : new Error('DSH Desktop could not start mobile pairing.')
    }
  }

  /** Explicit user revocation closes the relay and erases all desktop state. */
  close(): void {
    this.reset('revoked')
  }

  private bindSocket(socket: DesktopRelaySocket): void {
    socket.onopen = () => {
      const attempt = this.currentAttempt()
      if (attempt === undefined || attempt.socket !== socket) return
      try {
        this.sendControl(attempt, {
          type: 'desktop-hello',
          version: PAIRING_PROTOCOL_VERSION,
          pairingId: attempt.connection.bootstrap.pairingId,
          desktopDeviceId: attempt.connection.bootstrap.desktopDeviceId,
        })
      } catch {
        if (this.isCurrentAttempt(attempt)) this.reset('failed')
      }
    }
    socket.onmessage = (event) => {
      void this.receive(socket, event.data)
    }
    socket.onerror = () => {
      if (this.socket === socket) this.reset('failed')
    }
    socket.onclose = () => {
      if (this.socket === socket && !this.closed) this.reset('failed')
    }
  }

  private async receive(socket: DesktopRelaySocket, raw: unknown): Promise<void> {
    // Late frames from a closed/replaced socket are expected and must never
    // reset the current pairing attempt.
    if (socket !== this.socket) return
    const attempt = this.currentAttempt()
    if (attempt === undefined) return
    if (typeof raw !== 'string') {
      this.reset('failed')
      return
    }
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      this.reset('failed')
      return
    }
    if (isRecord(message) && message.type === 'desktop-ready') {
      if (
        this.cipher !== undefined
        || message.version !== PAIRING_PROTOCOL_VERSION
        || message.pairingId !== attempt.connection.bootstrap.pairingId
        || message.expiresAt !== attempt.connection.bootstrap.expiresAt
      ) {
        this.reset('failed')
        return
      }
      this.setState({ status: 'awaiting-phone', expiresAt: attempt.connection.bootstrap.expiresAt })
      return
    }
    if (isRecord(message) && message.type === 'mobile-init') {
      await this.acceptMobile(attempt, message)
      return
    }
    if (isRecord(message) && (message.type === 'pairing-revoked' || message.type === 'relay-error')) {
      this.reset(message.type === 'pairing-revoked' ? 'revoked' : 'failed')
      return
    }
    if (this.cipher === undefined) {
      this.reset('failed')
      return
    }
    try {
      const inbound = this.cipher.open(message)
      if (inbound.type === 'send-text') await this.handlePrompt(attempt, inbound.sessionHandle, inbound.requestId, inbound.text)
      else if (inbound.type === 'cancel-turn') this.handleCancel(attempt, inbound.sessionHandle, inbound.requestId, inbound.turnId)
      else throw new Error('DSH Desktop rejected an unexpected mobile message.')
    } catch {
      if (this.isCurrentAttempt(attempt)) this.reset('failed')
    }
  }

  private async acceptMobile(attempt: TransportAttempt, value: unknown): Promise<void> {
    const { connection } = attempt
    if (!this.isCurrentAttempt(attempt)) return
    if (this.cipher !== undefined || this.acceptingMobile !== undefined) {
      if (this.isCurrentAttempt(attempt)) this.reset('failed')
      return
    }
    this.acceptingMobile = attempt
    try {
      const init = parseMobilePairingInit(value)
      verifyMobilePairingProof({
        bootstrap: connection.bootstrap,
        init,
        desktopSecretKey: connection.ephemeralKeyPair.secretKey,
      })
      this.setState({ status: 'awaiting-desktop-approval' })
      const allowed = await (this.approval.approvePairing?.(init.capabilities) ?? Promise.resolve(false))
      if (!this.isCurrentAttempt(attempt)) return
      if (!allowed) {
        this.reset('denied')
        return
      }
      const confirmation = confirmPairingKey()
      const encryptedProof = createDesktopPairingProof({
        bootstrap: connection.bootstrap,
        init,
        desktopSecretKey: connection.ephemeralKeyPair.secretKey,
        random: { randomBytes },
      })
      const cipher = createMobileSessionCipher({
        endpoint: 'desktop',
        bootstrap: connection.bootstrap,
        init,
        localSecretKey: connection.ephemeralKeyPair.secretKey,
        confirmation,
        random: { randomBytes },
      })
      this.pairing.eraseEphemeralKey()
      this.cipher = cipher
      this.sendControl(attempt, {
        type: 'desktop-accept',
        version: PAIRING_PROTOCOL_VERSION,
        pairingId: connection.bootstrap.pairingId,
        mobileDeviceId: init.mobileDeviceId,
        encryptedProof,
      })
      this.setState({ status: 'paired' })
      await this.sendSnapshot(attempt)
      if (!this.isCurrentAttempt(attempt)) return
      this.poll = setInterval(() => { void this.refreshSnapshot(attempt) }, POLL_INTERVAL_MS)
    } catch {
      if (this.isCurrentAttempt(attempt)) this.reset('failed')
    } finally {
      if (this.acceptingMobile === attempt) this.acceptingMobile = undefined
    }
  }

  private async handlePrompt(attempt: TransportAttempt, handle: string, requestId: string, text: string): Promise<void> {
    const session = this.selectedSession
    if (!this.isCurrentAttempt(attempt) || session === undefined) return
    try {
      this.projection.validatePrompt(handle, text)
    } catch {
      this.sendError(attempt, handle, requestId, 'TURN_REJECTED', 'This mobile request was rejected.')
      return
    }
    const allowed = await (this.approval.approvePrompt?.(text) ?? Promise.resolve(false))
    // A native dialog can complete after this pairing is closed or replaced.
    // Never let that stale result act on, or reset, a newer desktop pairing.
    if (!this.isCurrentAttempt(attempt)) return
    if (!allowed) {
      this.sendError(attempt, handle, requestId, 'TURN_REJECTED', 'This mobile request was rejected.')
      return
    }
    try {
      await this.localSessions.queueText(session, text)
      if (!this.isCurrentAttempt(attempt)) return
      await this.sendSnapshot(attempt)
    } catch {
      if (this.isCurrentAttempt(attempt)) {
        this.sendError(attempt, handle, requestId, 'TURN_FAILED', 'The desktop could not start that turn.')
      }
    }
  }

  private handleCancel(attempt: TransportAttempt, handle: string, requestId: string, turnId: string): void {
    // The generic protocol parser still recognizes the historical command,
    // but this desktop release deliberately never maps it to session.cancel.
    // Local DSH exposes only session-wide cancellation, not a mobile-owned
    // turn identity, so accepting it would be unsafe.
    void turnId
    this.sendError(attempt, handle, requestId, 'TURN_REJECTED', 'Mobile cancellation is unavailable in this release.')
  }

  private async refreshSnapshot(attempt: TransportAttempt): Promise<void> {
    if (!this.isCurrentAttempt(attempt) || this.currentState.status !== 'paired' || this.refreshInFlight === attempt) return
    this.refreshInFlight = attempt
    try {
      await this.sendSnapshot(attempt)
    } catch {
      if (this.isCurrentAttempt(attempt)) this.reset('failed')
    } finally {
      if (this.refreshInFlight === attempt) this.refreshInFlight = undefined
    }
  }

  private async sendSnapshot(attempt: TransportAttempt): Promise<void> {
    if (!this.isCurrentAttempt(attempt)) return
    const session = this.selectedSession
    if (session === undefined || this.cipher === undefined) throw new Error('DSH Desktop mobile pairing is unavailable.')
    const history = await this.localSessions.history(session)
    if (!this.isCurrentAttempt(attempt)) return
    const view = this.projection.project([{ sessionKey: session.key, history }])[0]
    if (this.selectedView === undefined || view.handle !== this.selectedView.handle) {
      throw new Error('DSH Desktop selected session became unavailable.')
    }
    if (!this.isCurrentAttempt(attempt)) return
    this.selectedView = view
    this.sendEncrypted(attempt, {
      type: 'session-snapshot',
      sessionHandle: view.handle,
      requestId: opaqueId('snapshot'),
      title: 'DSH session',
      messages: view.messages.map((message, index) => ({
        id: stableMessageId(index),
        role: message.role,
        text: message.text,
      })),
      // History polling cannot safely attribute a server turn to a mobile
      // request, so it never blocks the phone composer with a running marker.
      activeTurn: null,
    })
  }

  private sendError(attempt: TransportAttempt, handle: string, requestId: string, code: 'TURN_REJECTED' | 'TURN_FAILED', message: string): void {
    if (!this.isCurrentAttempt(attempt)) return
    try {
      this.projection.validateSelectedHandle(handle)
      if (!this.isCurrentAttempt(attempt)) return
      this.sendEncrypted(attempt, { type: 'error', sessionHandle: handle, requestId, code, message })
    } catch {
      if (this.isCurrentAttempt(attempt)) this.reset('failed')
    }
  }

  private sendControl(attempt: TransportAttempt, value: unknown): void {
    if (!this.isCurrentAttempt(attempt)) throw new Error('DSH Desktop mobile relay is unavailable.')
    attempt.socket.send(JSON.stringify(value))
  }

  private sendEncrypted(attempt: TransportAttempt, value: unknown): void {
    if (!this.isCurrentAttempt(attempt) || this.cipher === undefined) throw new Error('DSH Desktop mobile encryption is unavailable.')
    this.sendControl(attempt, JSON.parse(serializeRelayFrame(this.cipher.seal(value))))
  }

  /** Capture the exact foreground relay attempt before awaiting a native dialog. */
  private currentAttempt(): TransportAttempt | undefined {
    if (this.closed || this.activeGeneration === undefined || this.socket === undefined || this.connection === undefined) return undefined
    return { generation: this.generation, socket: this.socket, connection: this.connection }
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.closed && this.activeGeneration === generation && this.generation === generation
  }

  /** A previous dialog must not affect a later socket, connection, or generation. */
  private isCurrentAttempt(attempt: TransportAttempt): boolean {
    return !this.closed
      && this.activeGeneration === attempt.generation
      && this.generation === attempt.generation
      && this.socket === attempt.socket
      && this.connection === attempt.connection
  }

  private reset(reason: 'denied' | 'failed' | 'revoked', publish = true): void {
    this.generation += 1
    this.activeGeneration = undefined
    if (this.closed && this.currentState.status === 'closed') return
    this.closed = true
    if (this.poll !== undefined) clearInterval(this.poll)
    this.poll = undefined
    if (this.expiry !== undefined) clearTimeout(this.expiry)
    this.expiry = undefined
    this.cipher?.erase()
    this.cipher = undefined
    this.socket?.close(4403, 'desktop-closed')
    this.socket = undefined
    this.connection = undefined
    this.pairing.close()
    this.projection.close()
    this.selectedSession = undefined
    this.selectedView = undefined
    this.refreshInFlight = undefined
    this.acceptingMobile = undefined
    if (publish) this.setState({ status: 'closed', reason })
    else this.currentState = { status: 'idle' }
  }

  private setState(state: DesktopMobileTransportState): void {
    this.currentState = state
    this.onStateChange({ ...state })
  }
}

function opaqueId(prefix: string): string {
  return `${prefix}_${Buffer.from(randomBytes(16)).toString('base64url')}`
}

function stableMessageId(index: number): string {
  return `message_${String(index).padStart(16, '0')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
