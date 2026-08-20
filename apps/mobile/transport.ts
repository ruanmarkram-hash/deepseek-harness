/**
 * Foreground-only mobile client for the fixed DSH pairing relay.
 *
 * The transport keeps the QR bootstrap, relay bearer, pairing secret, and
 * directional cipher in memory only. A close, expiry, relay rejection, or
 * background transition erases those values and requires a new desktop QR.
 */

import {
  PAIRING_PROTOCOL_VERSION,
  confirmPairingKey,
  createMobilePairingProof,
  createMobileSessionCipher,
  createPairingEphemeralKeyPair,
  destroyPairingEphemeralKeyPair,
  isPairingProtocolError,
  parseDesktopPairingAccept,
  parsePairingBootstrap,
  verifyDesktopPairingProof,
  type DesktopToMobileSessionMessage,
  type MobilePairingCapability,
  type MobilePairingInit,
  type MobileSessionCipher,
  type PairingBootstrap,
  type PairingEphemeralKeyPair,
  type PairingRandomSource,
} from '@deepseek-ai/dsh-pairing-protocol'
import * as Crypto from 'expo-crypto'

/** The only relay origin accepted by the compiled mobile app. */
export const MOBILE_RELAY_ORIGIN = 'wss://dsh-mobile-relay.sonke-referrals.workers.dev'

/** The fixed production relay is deployed with the version-two mobile protocol. */
export const MOBILE_RELAY_V2_DEPLOYED = true

const RELAY_PROTOCOL = 'dsh-pairing-v2'
const MOBILE_TOKEN_PREFIX = 'dsh-mobile.'
const DEVICE_ID_BYTES = 32

/** Foreground capabilities that do not require a durable desktop run identity. */
export const MOBILE_FOREGROUND_CAPABILITIES = [
  'session:read',
  'session:subscribe',
  'turn:send',
] as const satisfies readonly MobilePairingCapability[]

/** A non-secret summary that may be rendered after parsing a QR bootstrap. */
export interface MobilePairingSummary {
  readonly relayHost: string
  readonly pairingSuffix: string
  readonly expiresAt: number
  readonly capabilities: readonly MobilePairingCapability[]
}

/** Safe lifecycle states reported to the mobile UI. */
export type MobileTransportState =
  | { readonly kind: 'connecting'; readonly summary: MobilePairingSummary }
  | { readonly kind: 'awaiting-desktop-approval'; readonly summary: MobilePairingSummary }
  | { readonly kind: 'connected'; readonly summary: MobilePairingSummary }
  | { readonly kind: 'ended'; readonly reason: MobileTransportEndReason }

/** Reasons intentionally omit tokens, QR payloads, and relay response bodies. */
export type MobileTransportEndReason =
  | 'backgrounded'
  | 'closed'
  | 'desktop-unavailable'
  | 'expired'
  | 'network-unavailable'
  | 'pairing-rejected'
  | 'protocol-invalid'
  | 'relay-v2-unavailable'

/** Small WebSocket face that keeps the transport testable without browser globals. */
export interface MobileRelaySocket {
  onclose: ((event: { readonly code: number }) => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onopen: (() => void) | null
  close(code?: number, reason?: string): void
  send(data: string): void
}

/** Platform inputs injected by Expo at the app edge or by a focused test. */
export interface MobilePairingTransportOptions {
  readonly createSocket?: (url: string, protocols: readonly string[]) => MobileRelaySocket
  readonly now?: () => number
  readonly onDesktopMessage: (message: DesktopToMobileSessionMessage) => void
  readonly onState: (state: MobileTransportState) => void
  readonly random?: PairingRandomSource
  readonly relayV2Deployed?: boolean
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly unschedule?: (timer: ReturnType<typeof setTimeout>) => void
}

interface ActivePairing {
  bootstrap: PairingBootstrap | undefined
  init: MobilePairingInit | undefined
  keyPair: PairingEphemeralKeyPair | undefined
  readonly summary: MobilePairingSummary
  cipher: MobileSessionCipher | undefined
  socket: MobileRelaySocket | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

class MobileTransportError extends Error {
  readonly reason: MobileTransportEndReason

  constructor(reason: MobileTransportEndReason) {
    super(reason)
    this.reason = reason
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function base64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * Build the pairing random source from Expo's native crypto module. This never
 * consults a browser or React Native global and never falls back to Math.random.
 *
 * @param source - Expo-compatible cryptographic random implementation.
 * @returns Pairing random source with bounded, copied random bytes.
 */
export function createExpoRandomSource(
  source: Pick<typeof Crypto, 'getRandomValues'> = Crypto,
): PairingRandomSource {
  return {
    randomBytes(length: number): Uint8Array {
      if (!Number.isSafeInteger(length) || length <= 0 || length > 1_024) {
        throw new MobileTransportError('protocol-invalid')
      }
      try {
        return new Uint8Array(source.getRandomValues(new Uint8Array(length)))
      } catch {
        throw new MobileTransportError('protocol-invalid')
      }
    },
  }
}

function socketFactory(url: string, protocols: readonly string[]): MobileRelaySocket {
  // React Native and the DOM expose compatible event slots with platform-specific event types.
  return new WebSocket(url, [...protocols]) as unknown as MobileRelaySocket
}

function summaryFor(bootstrap: PairingBootstrap): MobilePairingSummary {
  return {
    relayHost: new URL(bootstrap.relayUrl).host,
    pairingSuffix: bootstrap.pairingId.slice(-6),
    expiresAt: bootstrap.expiresAt,
    capabilities: MOBILE_FOREGROUND_CAPABILITIES,
  }
}

function control(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && typeof value.type === 'string' ? value : undefined
}

/**
 * Derive the only WebSocket endpoint mobile is allowed to contact.
 *
 * @param bootstrap - Validated desktop QR data.
 * @returns Fixed-origin pairing connection URL.
 */
export function mobileRelayConnectionUrl(bootstrap: PairingBootstrap): string {
  const relay = new URL(bootstrap.relayUrl)
  const allowed = new URL(MOBILE_RELAY_ORIGIN)
  if (
    relay.origin !== allowed.origin
    || relay.protocol !== allowed.protocol
    || relay.pathname !== '/'
    || relay.search !== ''
    || relay.hash !== ''
  ) {
    throw new MobileTransportError('pairing-rejected')
  }
  return new URL(`v1/pairings/${encodeURIComponent(bootstrap.pairingId)}/connect`, relay).href
}

/**
 * Create one public, opaque mobile device id from CSPRNG bytes.
 *
 * @param random - Platform random source.
 * @returns A 32-byte base64url public identifier.
 */
export function createMobileDeviceId(random: PairingRandomSource): string {
  const bytes = random.randomBytes(DEVICE_ID_BYTES)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== DEVICE_ID_BYTES) {
    throw new MobileTransportError('protocol-invalid')
  }
  try {
    return base64Url(bytes)
  } finally {
    bytes.fill(0)
  }
}

/**
 * Own one mobile pairing attempt. Instances cannot reconnect or persist a
 * completed pairing because every ending erases the active bootstrap and keys.
 */
export class MobilePairingTransport {
  private readonly createSocket: (url: string, protocols: readonly string[]) => MobileRelaySocket
  private readonly clock: () => number
  private readonly onDesktopMessage: (message: DesktopToMobileSessionMessage) => void
  private readonly onState: (state: MobileTransportState) => void
  private readonly random: PairingRandomSource
  private readonly relayV2Deployed: boolean
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly unschedule: (timer: ReturnType<typeof setTimeout>) => void
  private active: ActivePairing | undefined

  /** Create a memory-only transport with platform functions supplied at the app edge. */
  constructor(options: MobilePairingTransportOptions) {
    this.createSocket = options.createSocket ?? socketFactory
    this.clock = options.now ?? Date.now
    this.onDesktopMessage = options.onDesktopMessage
    this.onState = options.onState
    this.random = options.random ?? createExpoRandomSource()
    this.relayV2Deployed = options.relayV2Deployed ?? MOBILE_RELAY_V2_DEPLOYED
    this.schedule = options.schedule ?? setTimeout
    this.unschedule = options.unschedule ?? clearTimeout
  }

  /**
   * Parse a freshly pasted desktop QR and start its single foreground pairing.
   * The caller owns clearing the raw QR string immediately after this call.
   *
   * @param rawBootstrap - Fresh QR text; this transport never stores it.
   */
  start(rawBootstrap: string): void {
    this.end('closed', false)
    if (!this.relayV2Deployed) {
      this.end('relay-v2-unavailable', true)
      return
    }
    let keyPair: PairingEphemeralKeyPair | undefined
    let bootstrap: PairingBootstrap
    try {
      bootstrap = parsePairingBootstrap(rawBootstrap, this.clock())
      const summary = summaryFor(bootstrap)
      const url = mobileRelayConnectionUrl(bootstrap)
      keyPair = createPairingEphemeralKeyPair(this.random)
      const mobileDeviceId = createMobileDeviceId(this.random)
      const proof = createMobilePairingProof({
        bootstrap,
        mobileDeviceId: mobileDeviceId as MobilePairingInit['mobileDeviceId'],
        capabilities: MOBILE_FOREGROUND_CAPABILITIES,
        mobileKeyPair: keyPair,
        random: this.random,
      })
      const init: MobilePairingInit = {
        type: 'mobile-init',
        version: PAIRING_PROTOCOL_VERSION,
        pairingId: bootstrap.pairingId,
        mobileDeviceId: mobileDeviceId as MobilePairingInit['mobileDeviceId'],
        mobileEphemeralPublicKey: proof.mobileEphemeralPublicKey,
        capabilities: MOBILE_FOREGROUND_CAPABILITIES,
        encryptedProof: proof.encryptedProof,
      }
      const socket = this.createSocket(url, [RELAY_PROTOCOL, `${MOBILE_TOKEN_PREFIX}${bootstrap.relayToken}`])
      const active: ActivePairing = { bootstrap, init, keyPair, cipher: undefined, socket, summary, timer: undefined }
      this.active = active
      keyPair = undefined
      active.timer = this.schedule(() => this.endIfActive(active, 'expired'), Math.max(0, bootstrap.expiresAt - this.clock()))
      socket.onopen = () => this.open(active)
      socket.onmessage = event => this.receive(active, event.data)
      socket.onerror = () => this.endIfActive(active, 'network-unavailable')
      socket.onclose = () => this.endIfActive(active, 'network-unavailable')
      this.onState({ kind: 'connecting', summary })
    } catch (error) {
      keyPair?.secretKey.fill(0)
      this.end(this.reasonFor(error), true)
    }
  }

  /** Return whether this foreground transport has locally verified desktop acceptance. */
  connected(): boolean {
    return this.active?.cipher !== undefined
  }

  /** Encrypt and submit one text-only request for the desktop-selected session. */
  sendText(sessionHandle: string, text: string): void {
    this.send({ type: 'send-text', sessionHandle, requestId: createMobileDeviceId(this.random), text })
  }

  /** Close a foreground transport and erase its QR credential and all key material. */
  close(reason: MobileTransportEndReason = 'closed'): void {
    this.end(reason, true)
  }

  private open(active: ActivePairing): void {
    const { bootstrap, init, socket } = active
    if (this.active !== active || bootstrap === undefined || init === undefined || socket === undefined) return
    if (bootstrap.expiresAt <= this.clock()) {
      this.endIfActive(active, 'expired')
      return
    }
    try {
      socket.send(JSON.stringify(init))
      this.onState({ kind: 'awaiting-desktop-approval', summary: active.summary })
    } catch {
      this.endIfActive(active, 'network-unavailable')
    }
  }

  private receive(active: ActivePairing, raw: unknown): void {
    if (this.active !== active || typeof raw !== 'string' || raw.length > 96 * 1_024) {
      this.endIfActive(active, 'protocol-invalid')
      return
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      this.endIfActive(active, 'protocol-invalid')
      return
    }
    const messageControl = control(value)
    if (messageControl !== undefined) {
      this.receiveControl(active, value, messageControl)
      return
    }
    if (active.cipher === undefined) {
      this.endIfActive(active, 'protocol-invalid')
      return
    }
    try {
      this.onDesktopMessage(active.cipher.open(value) as DesktopToMobileSessionMessage)
    } catch {
      this.endIfActive(active, 'protocol-invalid')
    }
  }

  private receiveControl(active: ActivePairing, value: unknown, message: Record<string, unknown>): void {
    if (message.type === 'desktop-accept' && active.cipher === undefined) {
      const { bootstrap, init, keyPair } = active
      if (bootstrap === undefined || init === undefined || keyPair === undefined) {
        this.endIfActive(active, 'protocol-invalid')
        return
      }
      try {
        const accept = parseDesktopPairingAccept(value)
        verifyDesktopPairingProof({
          bootstrap,
          init,
          accept,
          mobileSecretKey: keyPair.secretKey,
        })
        const confirmation = confirmPairingKey()
        active.cipher = createMobileSessionCipher({
          bootstrap,
          init,
          endpoint: 'mobile',
          localSecretKey: keyPair.secretKey,
          confirmation,
          random: this.random,
        })
        destroyPairingEphemeralKeyPair(keyPair)
        active.keyPair = undefined
        this.onState({ kind: 'connected', summary: active.summary })
      } catch {
        this.endIfActive(active, 'pairing-rejected')
      }
      return
    }
    if (message.type === 'relay-error') {
      this.endIfActive(active, message.code === 'desktop-offline' ? 'desktop-unavailable' : 'pairing-rejected')
      return
    }
    if (message.type === 'pairing-revoked') {
      this.endIfActive(active, 'pairing-rejected')
      return
    }
    this.endIfActive(active, 'protocol-invalid')
  }

  private send(message: unknown): void {
    const active = this.active
    if (active?.cipher === undefined || active.socket === undefined) {
      throw new MobileTransportError('desktop-unavailable')
    }
    try {
      active.socket.send(JSON.stringify(active.cipher.seal(message)))
    } catch {
      this.endIfActive(active, 'network-unavailable')
      throw new MobileTransportError('network-unavailable')
    }
  }

  private endIfActive(active: ActivePairing, reason: MobileTransportEndReason): void {
    if (this.active === active) this.end(reason, true)
  }

  private end(reason: MobileTransportEndReason, report: boolean): void {
    const active = this.active
    this.active = undefined
    if (active === undefined) {
      if (report) this.onState({ kind: 'ended', reason })
      return
    }
    if (active.timer !== undefined) this.unschedule(active.timer)
    active.timer = undefined
    active.cipher?.erase()
    active.cipher = undefined
    active.keyPair?.secretKey.fill(0)
    active.keyPair = undefined
    active.bootstrap = undefined
    active.init = undefined
    const socket = active.socket
    active.socket = undefined
    if (socket !== undefined) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
    }
    socket?.close(1000, 'mobile-pairing-ended')
    if (report) this.onState({ kind: 'ended', reason })
  }

  private reasonFor(error: unknown): MobileTransportEndReason {
    if (error instanceof MobileTransportError) return error.reason
    if (isPairingProtocolError(error) && error.code === 'PAIRING_QR_EXPIRED') return 'expired'
    return 'pairing-rejected'
  }
}
