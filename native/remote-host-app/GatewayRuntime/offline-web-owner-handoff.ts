/** Offline-only FD199 Web-owner handoff state machine. */
import { createHash } from 'node:crypto'

const VERSION = 2; const MAX_FILES = 8_192; const MAX_BYTES = 128 * 1024 * 1024; const MAX_FILE_BYTES = 8 * 1024 * 1024
const HEX = /^[a-f0-9]{64}$/; const FILE = /^(?:sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.jsonl|attachments\/[a-f0-9]{64})$/

/** Exact FD199 requirements. FD198 never supplies this authority. */
export const FD199_WEB_OWNER_HANDOFF_REQUIREMENTS = Object.freeze({
  carrier: 'FD199', ownerState: 'web-owner-stopped', export: 'complete-immutable-verified', activation: 'explicit-native-host-gate',
  prohibited: Object.freeze(['pid-discovery', 'signals', 'socket-discovery', 'live-store-read', 'live-store-copy', 'node-pathname-journal-io']),
} as const)

/** One immutable stopped-owner export file. */
export interface QuiescedWebOwnerExportFile { readonly name: string; readonly bytes: Uint8Array; readonly sha256: string }
/** Native-verified export facts. */
export interface VerifiedWebOwnerExport { readonly carrier: 'FD199'; readonly ownerState: 'web-owner-stopped'; readonly exportId: string; readonly stoppedAt: string; readonly files: readonly QuiescedWebOwnerExportFile[] }
/** Signed FD199 proof. */
export interface Fd199SignedProof { readonly bytes: Uint8Array }
/** Unverified export offer. */
export interface Fd199WebOwnerHandoffOffer { readonly proof: Fd199SignedProof }
/** Unverified activation offer. */
export interface Fd199WebOwnerActivationOffer { readonly proof: Fd199SignedProof }
/** Crash-recoverable state. Activated state always has a signed transition proof. */
export interface OfflineWebOwnerHandoffState { readonly version: typeof VERSION; readonly exportId: string; readonly stoppedAt: string; readonly generation: number; readonly manifestDigest: string; readonly status: 'prepared' | 'activated'; readonly exportProof: string; readonly activationProof?: string; readonly files: readonly { readonly name: string; readonly sha256: string; readonly bytes: number }[] }

/**
 * Opaque native journal. Every method retains a verified dirfd and uses
 * no-follow relative operations after owner, mode, and ACL checks. Node gets
 * no path, preventing root replacement between state transitions.
 */
export interface NativeFd199PrivateJournal { recoverVerified(): Promise<Uint8Array | undefined>; stagePrepared(state: Uint8Array, files: readonly QuiescedWebOwnerExportFile[]): Promise<void>; transitionPrepared(expected: Uint8Array, next: Uint8Array): Promise<boolean> }
/** Native-only proof verifier and private journal owner. */
export interface NativeFd199HandoffAuthority {
  openPrivateJournal(): Promise<NativeFd199PrivateJournal>
  verifyExport(offer: Fd199WebOwnerHandoffOffer): Promise<VerifiedWebOwnerExport>
  verifyRecoveredExport(proof: Fd199SignedProof, state: Pick<OfflineWebOwnerHandoffState, 'exportId' | 'stoppedAt' | 'files'>): Promise<void>
  verifyActivation(offer: Fd199WebOwnerActivationOffer, exportId: string, manifestDigest: string, generation: number): Promise<void>
  verifyRecoveredActivation(proof: Fd199SignedProof, exportId: string, manifestDigest: string, generation: number): Promise<void>
}
/** Fail-closed handoff error. */
export class OfflineWebOwnerHandoffError extends Error { constructor() { super('the offline Web-owner handoff is unavailable or invalid'); this.name = 'OfflineWebOwnerHandoffError' } }

/** Offline owner with no filesystem pathname access. */
export class OfflineWebOwnerHandoff {
  private writes = Promise.resolve()
  private constructor(private readonly journal: NativeFd199PrivateJournal, private readonly authority: NativeFd199HandoffAuthority) {}
  /** Opens one native-owned private journal. Production remains inert until FD199 is linked. */
  static async open(authority: NativeFd199HandoffAuthority): Promise<OfflineWebOwnerHandoff> { try { return new OfflineWebOwnerHandoff(await authority.openPrivateJournal(), authority) } catch { throw new OfflineWebOwnerHandoffError() } }
  /** Recovers only a re-verified export and, if active, a re-verified signed transition. */
  async recover(): Promise<OfflineWebOwnerHandoffState | undefined> {
    try {
      const saved = await this.journal.recoverVerified(); if (saved === undefined) return undefined
      if (saved.byteLength > 2 * 1024 * 1024) throw new OfflineWebOwnerHandoffError()
      const state = parse(new TextDecoder().decode(saved))
      await this.authority.verifyRecoveredExport({ bytes: Buffer.from(state.exportProof, 'base64url') }, state)
      if (state.status === 'activated') await this.authority.verifyRecoveredActivation({ bytes: Buffer.from(state.activationProof!, 'base64url') }, state.exportId, state.manifestDigest, state.generation)
      return state
    } catch { throw new OfflineWebOwnerHandoffError() }
  }
  /** Stages a native-verified stopped-owner export. Prepared state is inert. */
  async prepare(offer: Fd199WebOwnerHandoffOffer): Promise<OfflineWebOwnerHandoffState> {
    return this.serial(async () => {
      const exported = await verified(() => this.authority.verifyExport(offer)); const files = validate(exported)
      if (!proof(offer.proof.bytes)) throw new OfflineWebOwnerHandoffError()
      const prior = await this.recover(); if (prior !== undefined && prior.exportId === exported.exportId) return prior; if (prior !== undefined) throw new OfflineWebOwnerHandoffError()
      const manifest = files.map(file => ({ name: file.name, sha256: file.sha256, bytes: file.bytes.byteLength }))
      const state: OfflineWebOwnerHandoffState = { version: VERSION, exportId: exported.exportId, stoppedAt: exported.stoppedAt, generation: 0, manifestDigest: hash(new TextEncoder().encode(JSON.stringify(manifest))), status: 'prepared', exportProof: Buffer.from(offer.proof.bytes).toString('base64url'), files: manifest }
      await this.journal.stagePrepared(encoded(state), files); return state
    })
  }
  /** Commits a native-signed export-to-active transition for restart verification. */
  async activate(offer: Fd199WebOwnerActivationOffer): Promise<OfflineWebOwnerHandoffState> {
    return this.serial(async () => {
      const current = await this.recover(); if (current === undefined || current.status !== 'prepared' || !proof(offer.proof.bytes)) throw new OfflineWebOwnerHandoffError()
      const next: OfflineWebOwnerHandoffState = { ...current, generation: current.generation + 1, status: 'activated', activationProof: Buffer.from(offer.proof.bytes).toString('base64url') }
      await verified(() => this.authority.verifyActivation(offer, current.exportId, current.manifestDigest, next.generation))
      if (!await this.journal.transitionPrepared(encoded(current), encoded(next))) throw new OfflineWebOwnerHandoffError()
      return next
    })
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.writes.then(operation); this.writes = result.then(() => undefined, () => undefined); return result }
}

function validate(value: VerifiedWebOwnerExport): readonly QuiescedWebOwnerExportFile[] {
  if (value.carrier !== 'FD199' || value.ownerState !== 'web-owner-stopped' || !id(value.exportId) || !time(value.stoppedAt) || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES) throw new OfflineWebOwnerHandoffError()
  let total = 0; const names = new Set<string>()
  for (const file of value.files) { if (!FILE.test(file.name) || names.has(file.name) || !HEX.test(file.sha256) || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_FILE_BYTES) throw new OfflineWebOwnerHandoffError(); total += file.bytes.byteLength; if (total > MAX_BYTES || hash(file.bytes) !== file.sha256) throw new OfflineWebOwnerHandoffError(); names.add(file.name) }
  return value.files
}
function parse(input: string): OfflineWebOwnerHandoffState {
  let value: unknown; try { value = JSON.parse(input) } catch { throw new OfflineWebOwnerHandoffError() }; if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OfflineWebOwnerHandoffError()
  const state = value as Partial<OfflineWebOwnerHandoffState>
  if (state.version !== VERSION || !id(state.exportId ?? '') || !time(state.stoppedAt ?? '') || !Number.isSafeInteger(state.generation) || state.generation! < 0 || !HEX.test(state.manifestDigest ?? '') || (state.status !== 'prepared' && state.status !== 'activated') || !proofText(state.exportProof) || (state.status === 'activated' ? !proofText(state.activationProof) : state.activationProof !== undefined) || !Array.isArray(state.files) || state.files.length === 0 || state.files.length > MAX_FILES) throw new OfflineWebOwnerHandoffError()
  let total = 0; const names = new Set<string>(); for (const file of state.files) { if (file === null || typeof file !== 'object' || !FILE.test(file.name ?? '') || names.has(file.name ?? '') || !HEX.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_FILE_BYTES) throw new OfflineWebOwnerHandoffError(); total += file.bytes; if (total > MAX_BYTES) throw new OfflineWebOwnerHandoffError(); names.add(file.name) }
  if (state.manifestDigest !== hash(new TextEncoder().encode(JSON.stringify(state.files)))) throw new OfflineWebOwnerHandoffError()
  return state as OfflineWebOwnerHandoffState
}
function encoded(state: OfflineWebOwnerHandoffState): Uint8Array { return new TextEncoder().encode(`${JSON.stringify(state)}\n`) }
async function verified<T>(operation: () => Promise<T>): Promise<T> { try { return await operation() } catch { throw new OfflineWebOwnerHandoffError() } }
function id(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/.test(value) }
function time(value: string): boolean { try { return new Date(value).toISOString() === value } catch { return false } }
function proof(value: unknown): value is Uint8Array { return value instanceof Uint8Array && value.byteLength >= 64 && value.byteLength <= 8_192 }
function proofText(value: string | undefined): boolean { try { return value !== undefined && proof(Buffer.from(value, 'base64url')) && Buffer.from(value, 'base64url').toString('base64url') === value } catch { return false } }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
