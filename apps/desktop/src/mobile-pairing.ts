import { randomBytes } from 'node:crypto'
import {
  MOBILE_PAIRING_CAPABILITIES,
  PAIRING_PROTOCOL_VERSION,
} from '@deepseek-ai/dsh-pairing-protocol'

const PAIRING_TTL_MS = 4 * 60 * 1_000
const PAIRING_SECRET_BYTES = 32

/** Non-secret pairing state available to the Electron main process. */
export type DesktopPairingState =
  | { readonly status: 'idle' }
  | { readonly status: 'creating' }
  | { readonly status: 'ready'; readonly pairingId: string; readonly desktopDeviceId: string; readonly expiresAt: number }
  | { readonly status: 'failed'; readonly reason: PairingFailureReason }

/** Failure categories that never include relay credentials or response content. */
export type PairingFailureReason = 'relay-rejected' | 'relay-request-failed' | 'relay-response-invalid'

/** The one QR value that a native presentation may render immediately after pairing creation. */
export interface DesktopPairingBootstrap {
  readonly desktopDeviceId: string
  readonly expiresAt: number
  readonly pairingId: string
  readonly qrValue: string
}

/** Options owned by the Electron main process, never a renderer. */
export interface DesktopPairingBridgeOptions {
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly randomBytes?: (size: number) => Uint8Array
  readonly relayBaseUrl: string
}

interface RelayUrls {
  readonly createUrl: URL
  readonly qrRelayUrl: string
}

interface ActiveDesktopPairing {
  readonly desktopRelayToken: string
  readonly desktopDeviceId: string
  readonly expiresAt: number
  readonly pairingId: string
}

interface PairingCandidate extends ActiveDesktopPairing {
  readonly mobileRelayToken: string
}

/**
 * Validate the configured HTTPS relay origin and derive its creation and QR endpoints.
 *
 * @param value - The host-owned relay base URL.
 * @returns Relay URLs for the HTTPS creation request and the WSS QR bootstrap.
 */
export function desktopPairingRelayUrls(value: string): RelayUrls {
  let relayBaseUrl: URL
  try {
    relayBaseUrl = new URL(value)
  } catch {
    throw new Error('DSH Desktop mobile pairing requires an HTTPS relay origin.')
  }
  if (relayBaseUrl.protocol !== 'https:'
    || relayBaseUrl.username !== ''
    || relayBaseUrl.password !== ''
    || relayBaseUrl.search !== ''
    || relayBaseUrl.hash !== ''
    || relayBaseUrl.pathname !== '/') {
    throw new Error('DSH Desktop mobile pairing requires an HTTPS relay origin.')
  }
  const qrRelayUrl = new URL(relayBaseUrl)
  qrRelayUrl.protocol = 'wss:'
  return {
    createUrl: new URL('v1/pairings/', relayBaseUrl),
    qrRelayUrl: qrRelayUrl.href,
  }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function generatedValue(nextBytes: (size: number) => Uint8Array): string {
  const bytes = nextBytes(PAIRING_SECRET_BYTES)
  if (bytes.byteLength !== PAIRING_SECRET_BYTES) throw new Error('DSH Desktop pairing randomness was unavailable.')
  return base64Url(bytes)
}

function createCandidate(now: number, nextBytes: (size: number) => Uint8Array): PairingCandidate {
  const pairingId = generatedValue(nextBytes)
  const desktopDeviceId = generatedValue(nextBytes)
  const desktopRelayToken = generatedValue(nextBytes)
  const mobileRelayToken = generatedValue(nextBytes)
  if (new Set([pairingId, desktopDeviceId, desktopRelayToken, mobileRelayToken]).size !== 4) {
    throw new Error('DSH Desktop pairing randomness produced duplicate values.')
  }
  return {
    pairingId,
    desktopDeviceId,
    desktopRelayToken,
    mobileRelayToken,
    expiresAt: now + PAIRING_TTL_MS,
  }
}

function qrValue(candidate: PairingCandidate, relayUrl: string): string {
  const payload = JSON.stringify({
    version: PAIRING_PROTOCOL_VERSION,
    relayUrl,
    pairingId: candidate.pairingId,
    desktopDeviceId: candidate.desktopDeviceId,
    relayToken: candidate.mobileRelayToken,
    expiresAt: candidate.expiresAt,
    capabilities: MOBILE_PAIRING_CAPABILITIES,
  })
  return `dsh-pairing:v${PAIRING_PROTOCOL_VERSION}:${Buffer.from(payload, 'utf8').toString('base64url')}`
}

function relayResponseMatchesExpiry(value: unknown, expiresAt: number): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  return Object.keys(response).length === 1 && response.expiresAt === expiresAt
}

/**
 * Electron-main-process pairing creator. It owns the desktop relay credential
 * in memory and returns only a QR bootstrap carrying the separate mobile credential.
 * It opens no WebSocket and supplies no session, tool, file, or computer-use path.
 */
export class DesktopPairingBridge {
  private readonly relayUrls: RelayUrls
  private readonly request: typeof fetch
  private readonly clock: () => number
  private readonly nextBytes: (size: number) => Uint8Array
  private active: ActiveDesktopPairing | undefined
  private currentState: DesktopPairingState = { status: 'idle' }
  private attempt = 0

  /**
   * Create the host-owned bridge without exposing a renderer-configurable relay URL.
   *
   * @param options - Fixed relay and injectable platform primitives for deterministic tests.
   */
  constructor(options: DesktopPairingBridgeOptions) {
    this.relayUrls = desktopPairingRelayUrls(options.relayBaseUrl)
    this.request = options.fetch ?? globalThis.fetch
    this.clock = options.now ?? Date.now
    this.nextBytes = options.randomBytes ?? randomBytes
  }

  /**
   * Return a defensive snapshot that never includes either relay credential or QR value.
   *
   * @returns Current non-secret lifecycle state.
   */
  state(): DesktopPairingState {
    this.expireActivePairing()
    return { ...this.currentState }
  }

  /**
   * Create one short-lived relay rendezvous and return its mobile-only QR bootstrap.
   *
   * @returns The QR value for immediate native rendering.
   */
  async create(): Promise<DesktopPairingBootstrap> {
    this.expireActivePairing()
    if (this.currentState.status === 'creating') throw new Error('DSH Desktop mobile pairing is already being created.')
    if (this.currentState.status === 'ready') throw new Error('DSH Desktop mobile pairing is already active.')
    const candidate = createCandidate(this.clock(), this.nextBytes)
    const attempt = ++this.attempt
    this.currentState = { status: 'creating' }
    const endpoint = new URL(encodeURIComponent(candidate.pairingId), this.relayUrls.createUrl)
    let response: Response
    try {
      response = await this.request(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${candidate.desktopRelayToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          version: PAIRING_PROTOCOL_VERSION,
          desktopDeviceId: candidate.desktopDeviceId,
          mobileRelayToken: candidate.mobileRelayToken,
          expiresAt: candidate.expiresAt,
        }),
      })
    } catch {
      if (attempt !== this.attempt) throw new Error('DSH Desktop mobile pairing creation was closed.')
      this.currentState = { status: 'failed', reason: 'relay-request-failed' }
      throw new Error('DSH Desktop could not create a mobile pairing at the relay.')
    }
    if (attempt !== this.attempt) throw new Error('DSH Desktop mobile pairing creation was closed.')
    if (response.status !== 201) {
      this.currentState = { status: 'failed', reason: 'relay-rejected' }
      throw new Error('DSH Desktop mobile pairing was rejected by the relay.')
    }
    let relayBody: unknown
    try {
      relayBody = await response.json()
    } catch {
      if (attempt !== this.attempt) throw new Error('DSH Desktop mobile pairing creation was closed.')
      this.currentState = { status: 'failed', reason: 'relay-response-invalid' }
      throw new Error('DSH Desktop mobile pairing received an invalid relay response.')
    }
    if (attempt !== this.attempt) throw new Error('DSH Desktop mobile pairing creation was closed.')
    if (candidate.expiresAt <= this.clock()) {
      this.currentState = { status: 'failed', reason: 'relay-response-invalid' }
      throw new Error('DSH Desktop mobile pairing expired before the relay responded.')
    }
    if (!relayResponseMatchesExpiry(relayBody, candidate.expiresAt)) {
      this.currentState = { status: 'failed', reason: 'relay-response-invalid' }
      throw new Error('DSH Desktop mobile pairing received an invalid relay response.')
    }
    this.active = {
      pairingId: candidate.pairingId,
      desktopDeviceId: candidate.desktopDeviceId,
      desktopRelayToken: candidate.desktopRelayToken,
      expiresAt: candidate.expiresAt,
    }
    this.currentState = {
      status: 'ready',
      pairingId: candidate.pairingId,
      desktopDeviceId: candidate.desktopDeviceId,
      expiresAt: candidate.expiresAt,
    }
    return {
      pairingId: candidate.pairingId,
      desktopDeviceId: candidate.desktopDeviceId,
      expiresAt: candidate.expiresAt,
      qrValue: qrValue(candidate, this.relayUrls.qrRelayUrl),
    }
  }

  /** Clear the locally retained desktop credential without creating a relay control channel. */
  close(): void {
    this.attempt += 1
    this.active = undefined
    this.currentState = { status: 'idle' }
  }

  /** Discard an expired desktop credential before it can block a new pairing. */
  private expireActivePairing(): void {
    if (this.active === undefined || this.active.expiresAt > this.clock()) return
    this.active = undefined
    this.currentState = { status: 'idle' }
  }
}
