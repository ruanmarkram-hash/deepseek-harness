/**
 * Native-Keychain persistence for one accepted DSH Mobile invitation.
 *
 * The record is written only after invitation validation or an authenticated
 * Host receipt. It never manufactures an epoch, a route, or a cursor.
 */

import { MAX_REMOTE_WIRE_SEQUENCE, type RemoteWireEventEnvelope } from '@deepseek-ai/dsh-remote-wire'
import type { ImportedMobileEnrollment } from './enrollment'
import { MobileRemoteReEnrollmentRequiredError } from './remote'
import type {
  MobileRemoteConnectionConfig,
  MobileRemoteEpochProvider,
  RemoteEventCursorStore,
} from './remote'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const TOKEN = /^[A-Za-z0-9_-]{24,128}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

/** One non-rendered Keychain record returned only by the signed native module. */
export interface StoredMobileRemoteState {
  readonly config: MobileRemoteConnectionConfig
  readonly eventCursor: number
  readonly expiresAt: string
  readonly nextConnectionEpoch: number
}

/** Narrow native Keychain record interface. It is intentionally unavailable in Expo Go. */
export interface DshMobileRemoteStateNativeModule {
  clearRemoteState(): Promise<void>
  loadRemoteState(): Promise<string | null>
  saveRemoteState(record: string): Promise<void>
}

interface PersistedState extends StoredMobileRemoteState {
  readonly version: 1
}

/**
 * Persist exact Host-issued connection state and received event cursors.
 *
 * Every mutation is serialized so an event acknowledgement cannot overwrite a
 * receipt-authenticated epoch advance.
 */
export class NativeMobileRemoteStateStore implements MobileRemoteEpochProvider, RemoteEventCursorStore {
  private cached: PersistedState | undefined
  private loaded = false
  private tail: Promise<void> = Promise.resolve()

  /** @param nativeModule - The signed iOS Keychain module. */
  constructor(private readonly nativeModule: DshMobileRemoteStateNativeModule | null) {}

  /** Restore the durable Host route without opening a connection. Transfer expiry never revokes a route. */
  async restore(): Promise<StoredMobileRemoteState | undefined> {
    return this.serialized(async () => this.snapshot(await this.load()))
  }

  /**
   * Reset delivery acknowledgement on a fresh app projection.
   *
   * The app deliberately does not persist rendered session content, so a fresh
   * process must request replay from cursor zero rather than suppressing events
   * whose projection no longer exists.
   */
  async resetCursorForFreshProjection(): Promise<StoredMobileRemoteState | undefined> {
    return this.serialized(async () => {
      const state = await this.load()
      if (state !== undefined && state.eventCursor !== 0) await this.save({ ...state, eventCursor: 0 })
      return this.snapshot(this.cached)
    })
  }

  /** Store a verified physical Host invitation before an explicit connect action. */
  async saveInvitation(invitation: ImportedMobileEnrollment): Promise<void> {
    await this.serialized(async () => {
      const state: PersistedState = {
        version: 1,
        config: invitation.config,
        eventCursor: 0,
        expiresAt: invitation.expiresAt,
        nextConnectionEpoch: invitation.config.connectionEpoch,
      }
      await this.save(state)
    })
  }

  /** Remove the local route credential and all replay state. Host revocation remains a Host action. */
  async clear(): Promise<void> {
    await this.serialized(async () => {
      const native = this.requiredNativeModule()
      await native.clearRemoteState()
      this.cached = undefined
      this.loaded = true
    })
  }

  /** Return only the already Host-issued exact next epoch for a reconnect. */
  async nextConnectionEpoch(config: MobileRemoteConnectionConfig, expectedEpoch: number, abortSignal: AbortSignal): Promise<number> {
    if (abortSignal.aborted) throw new Error('DSH Host connection was cancelled')
    return this.serialized(async () => {
      const state = await this.load()
      if (abortSignal.aborted) throw new Error('DSH Host connection was cancelled')
      if (state === undefined || !sameRoute(state.config, config) || state.nextConnectionEpoch !== expectedEpoch) {
        throw new MobileRemoteReEnrollmentRequiredError()
      }
      return expectedEpoch
    })
  }

  /** Persist the next epoch only after `MobileRemoteClient` authenticated the Host receipt. */
  async recordAuthenticatedConnection(
    config: MobileRemoteConnectionConfig, connectionEpoch: number, abortSignal: AbortSignal,
  ): Promise<void> {
    if (connectionEpoch >= MAX_REMOTE_WIRE_SEQUENCE) throw new Error('The Host connection reached its supported epoch limit')
    if (abortSignal.aborted) throw new Error('DSH Host connection was cancelled')
    await this.serialized(async () => {
      const state = await this.load()
      if (abortSignal.aborted) throw new Error('DSH Host connection was cancelled')
      if (state === undefined || !sameRoute(state.config, config) || state.nextConnectionEpoch !== connectionEpoch) {
        throw new Error('The signed Host did not confirm the expected connection epoch')
      }
      await this.save({
        ...state,
        config: { ...state.config, connectionEpoch: connectionEpoch + 1 },
        nextConnectionEpoch: connectionEpoch + 1,
      })
    })
  }

  /** Read the last durably projected Host event cursor. */
  async read(): Promise<number> {
    return this.serialized(async () => (await this.load())?.eventCursor ?? 0)
  }

  /** Record one contiguous Host event before its encrypted acknowledgement is sent. */
  async apply(event: RemoteWireEventEnvelope): Promise<void> {
    await this.serialized(async () => {
      const state = await this.load()
      if (state === undefined || event.cursor !== state.eventCursor + 1) {
        throw new Error('The Host event cursor is not contiguous')
      }
      await this.save({ ...state, eventCursor: event.cursor })
    })
  }

  /** Commit the Host snapshot baseline before accepting any event after a Host restart. */
  async replace(cursor: number): Promise<void> {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > MAX_REMOTE_WIRE_SEQUENCE) throw new Error('The Host snapshot cursor is invalid')
    await this.serialized(async () => {
      const state = await this.load()
      if (state === undefined) throw new Error('The local DSH Host route is unavailable')
      await this.save({ ...state, eventCursor: cursor })
    })
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: (() => void) | undefined
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }

  private async load(): Promise<PersistedState | undefined> {
    if (this.loaded) return this.cached
    const native = this.requiredNativeModule()
    const encoded = await native.loadRemoteState()
    this.loaded = true
    if (encoded === null) return undefined
    try {
      const state = parsePersistedState(JSON.parse(encoded))
      this.cached = state
      return state
    } catch {
      await native.clearRemoteState()
      return undefined
    }
  }

  private async save(state: PersistedState): Promise<void> {
    const native = this.requiredNativeModule()
    await native.saveRemoteState(JSON.stringify(state))
    this.cached = state
    this.loaded = true
  }

  private snapshot(state: PersistedState | undefined): StoredMobileRemoteState | undefined {
    return state === undefined ? undefined : {
      config: state.config,
      eventCursor: state.eventCursor,
      expiresAt: state.expiresAt,
      nextConnectionEpoch: state.nextConnectionEpoch,
    }
  }

  private requiredNativeModule(): DshMobileRemoteStateNativeModule {
    if (this.nativeModule === null) throw new Error('DSH Mobile requires its signed native identity module. Expo Go cannot restore this Host invitation.')
    return this.nativeModule
  }
}

function parsePersistedState(value: unknown): PersistedState {
  if (!record(value) || !exactKeys(value, ['version', 'config', 'eventCursor', 'expiresAt', 'nextConnectionEpoch']) || value.version !== 1) {
    throw new Error('The local DSH Host record is malformed')
  }
  if (!record(value.config) || !exactKeys(value.config, [
    'clientAuthToken', 'connectionEpoch', 'deviceEnrollmentId', 'hostDeviceId', 'hostEnrollmentId',
    'hostStaticAgreementPublicKey', 'routeGeneration', 'routeId',
  ])) throw new Error('The local DSH Host configuration is malformed')
  const config: MobileRemoteConnectionConfig = {
    clientAuthToken: token(value.config.clientAuthToken),
    connectionEpoch: sequence(value.config.connectionEpoch),
    deviceEnrollmentId: identifier(value.config.deviceEnrollmentId),
    hostDeviceId: identifier(value.config.hostDeviceId),
    hostEnrollmentId: identifier(value.config.hostEnrollmentId),
    hostStaticAgreementPublicKey: publicKey(value.config.hostStaticAgreementPublicKey),
    routeGeneration: sequence(value.config.routeGeneration),
    routeId: identifier(value.config.routeId),
  }
  const nextConnectionEpoch = sequence(value.nextConnectionEpoch)
  if (config.connectionEpoch !== nextConnectionEpoch) throw new Error('The local DSH Host epoch is inconsistent')
  return {
    version: 1,
    config,
    eventCursor: cursor(value.eventCursor),
    expiresAt: instant(value.expiresAt),
    nextConnectionEpoch,
  }
}

function sameRoute(left: MobileRemoteConnectionConfig, right: MobileRemoteConnectionConfig): boolean {
  return left.clientAuthToken === right.clientAuthToken
    && left.deviceEnrollmentId === right.deviceEnrollmentId
    && left.hostDeviceId === right.hostDeviceId
    && left.hostEnrollmentId === right.hostEnrollmentId
    && left.hostStaticAgreementPublicKey === right.hostStaticAgreementPublicKey
    && left.routeGeneration === right.routeGeneration
    && left.routeId === right.routeId
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error('The local DSH Host identifier is invalid')
  return value
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('The local DSH Host credential is invalid')
  return value
}

function publicKey(value: unknown): string {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length !== 43) throw new Error('The local DSH Host public key is invalid')
  return value
}

function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_REMOTE_WIRE_SEQUENCE) throw new Error('The local DSH Host epoch is invalid')
  return value
}

function cursor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_REMOTE_WIRE_SEQUENCE) throw new Error('The local DSH Host event cursor is invalid')
  return value
}

function instant(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The local DSH Host expiry is invalid')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error('The local DSH Host expiry is invalid')
  return value
}
