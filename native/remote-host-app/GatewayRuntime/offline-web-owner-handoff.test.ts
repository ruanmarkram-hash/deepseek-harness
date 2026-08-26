/** FD199 state-machine tests over an opaque native-journal fake. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  OfflineWebOwnerHandoff, OfflineWebOwnerHandoffError,
  type Fd199WebOwnerActivationOffer, type Fd199WebOwnerHandoffOffer,
  type NativeFd199HandoffAuthority, type NativeFd199PrivateJournal, type OfflineWebOwnerHandoffState, type QuiescedWebOwnerExportFile, type VerifiedWebOwnerExport,
} from './offline-web-owner-handoff.ts'

const ID = 'handoff_export_0001'; const STOPPED = '2026-08-21T08:00:00.000Z'
const proof = (byte: number) => new Uint8Array(64).fill(byte)
const offer = (): Fd199WebOwnerHandoffOffer => ({ proof: { bytes: proof(7) } })
const activate = (byte = 9): Fd199WebOwnerActivationOffer => ({ proof: { bytes: proof(byte) } })

function exported(): VerifiedWebOwnerExport {
  const bytes = new TextEncoder().encode('{"version":0}\n')
  return { carrier: 'FD199', ownerState: 'web-owner-stopped', exportId: ID, stoppedAt: STOPPED, files: [{ name: 'sessions/session_00000001.jsonl', bytes, sha256: createHash('sha256').update(bytes).digest('hex') }] }
}

class Journal implements NativeFd199PrivateJournal {
  indexed: Uint8Array | undefined; staged: Uint8Array | undefined; files: readonly QuiescedWebOwnerExportFile[] = []
  async recoverVerified(): Promise<Uint8Array | undefined> { const state = this.indexed ?? this.staged; if (state === undefined) return undefined; const manifest = JSON.parse(new TextDecoder().decode(state)) as { files: Array<{ sha256: string }> }; if (manifest.files.some((file, index) => createHash('sha256').update(this.files[index]?.bytes ?? new Uint8Array()).digest('hex') !== file.sha256)) throw new Error('staged bytes changed'); if (this.indexed === undefined) this.indexed = state.slice(); return state }
  async stagePrepared(state: Uint8Array, files: readonly QuiescedWebOwnerExportFile[]): Promise<void> { this.staged = state.slice(); this.indexed = state.slice(); this.files = files.map(file => ({ ...file, bytes: file.bytes.slice() })) }
  async transitionPrepared(expected: Uint8Array, next: Uint8Array): Promise<boolean> { if (Buffer.compare(Buffer.from(this.indexed), Buffer.from(expected)) !== 0) return false; this.indexed = next.slice(); return true }
  discardIndexForCrash(): void { this.indexed = undefined }
  tamper(mutator: (state: Record<string, unknown>) => void): void { const state = JSON.parse(new TextDecoder().decode(this.indexed)) as Record<string, unknown>; mutator(state); this.indexed = new TextEncoder().encode(JSON.stringify(state)) }
}

function authority(journal: Journal, value: VerifiedWebOwnerExport): NativeFd199HandoffAuthority {
  const key = (input: Uint8Array) => Buffer.from(input).toString('base64url')
  return {
    async openPrivateJournal() { return journal },
    async verifyExport(input) { if (key(input.proof.bytes) !== key(proof(7))) throw new Error('invalid export proof'); return value },
    async verifyRecoveredExport(input, state) { if (key(input.bytes) !== key(proof(7)) || state.exportId !== ID || state.files[0]?.sha256 !== value.files[0]?.sha256) throw new Error('invalid recovered export') },
    async verifyActivation(input, exportId, manifestDigest, generation) { if (key(input.proof.bytes) !== key(proof(9)) || exportId !== ID || manifestDigest.length !== 64 || generation !== 1) throw new Error('invalid activation proof') },
    async verifyRecoveredActivation(input, exportId, manifestDigest, generation) { if (key(input.bytes) !== key(proof(9)) || exportId !== ID || manifestDigest.length !== 64 || generation !== 1) throw new Error('invalid recovered activation') },
  }
}

test('FD199 handoff is crash recoverable but inert until a signed activation transition', async () => {
  const journal = new Journal(); const owner = await OfflineWebOwnerHandoff.open(authority(journal, exported()))
  const prepared = await owner.prepare(offer()); assert.equal(prepared.status, 'prepared')
  journal.discardIndexForCrash()
  assert.deepEqual(await (await OfflineWebOwnerHandoff.open(authority(journal, exported()))).recover(), prepared)
  await assert.rejects(owner.activate(activate(3)), OfflineWebOwnerHandoffError)
  assert.equal((await owner.activate(activate())).status, 'activated')
  assert.equal((await (await OfflineWebOwnerHandoff.open(authority(journal, exported()))).recover())?.status, 'activated')
})

test('FD199 recovery rejects fabricated active status and malformed stopped exports', async () => {
  const journal = new Journal(); const value = exported(); const owner = await OfflineWebOwnerHandoff.open(authority(journal, value))
  await assert.rejects(owner.prepare({ proof: { bytes: new Uint8Array(63) } }), OfflineWebOwnerHandoffError)
  const malformed = { ...value, files: [{ ...value.files[0]!, name: '../sessions/session_00000001.jsonl' }] } as VerifiedWebOwnerExport
  await assert.rejects((await OfflineWebOwnerHandoff.open(authority(new Journal(), malformed))).prepare(offer()), OfflineWebOwnerHandoffError)
  await owner.prepare(offer())
  journal.tamper(state => { state.status = 'activated'; delete state.activationProof })
  await assert.rejects((await OfflineWebOwnerHandoff.open(authority(journal, value))).recover(), OfflineWebOwnerHandoffError)
})

test('FD199 state never receives a caller root, so a root-replacement race cannot redirect later I/O', async () => {
  const journal = new Journal(); const owner = await OfflineWebOwnerHandoff.open(authority(journal, exported()))
  await owner.prepare(offer())
  assert.equal(journal.files.length, 1)
  assert.equal((await owner.recover())?.exportId, ID)
})

test('FD199 journal rejects changed staged bytes and permits only one atomic activation transition', async () => {
  const journal = new Journal(); const value = exported(); const first = await OfflineWebOwnerHandoff.open(authority(journal, value)); const second = await OfflineWebOwnerHandoff.open(authority(journal, value))
  await first.prepare(offer())
  journal.files = [{ ...journal.files[0]!, bytes: new Uint8Array([1]) }]
  await assert.rejects(first.recover(), OfflineWebOwnerHandoffError)
  await first.prepare(offer()).catch(() => {})
  journal.files = value.files
  const outcomes = await Promise.allSettled([first.activate(activate()), second.activate(activate())])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1)
})
