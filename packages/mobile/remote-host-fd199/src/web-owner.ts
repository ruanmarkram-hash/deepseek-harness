/**
 * Configured Web-graph adapter for the FD199 same-store transition. Mounted
 * only beside the hosted startup plugin: it exports the durable session
 * artifacts as digest-verified FD199 entries and hands ownership of the
 * remaining store handles to this process's own ordered teardown, which the
 * signed Host launcher triggers immediately after a settled transaction.
 * @module @deepseek-ai/dsh-remote-host-fd199/web-owner
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { REMOTE_HOST_FD199_MAX_BODY_BYTES, REMOTE_HOST_FD199_MAX_FILES } from './protocol.ts'
import { Fd199AuthorityError } from './error.ts'
import type { Fd199ExportFile, Fd199WebOwner } from './types.ts'

/** Maximum total exported bytes, matching the sealed journal bound. */
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

/** Cordis plugin name. */
export const name = 'remote-host-fd199-web-owner'

/** The durable session stack owns the artifacts this adapter exports. */
export const inject = ['sessionPersistence', 'sessions'] as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Mounted by this plugin; the hosted startup plugin consumes it lazily. */
    fd199WebOwner?: Fd199WebOwner
  }
}

/** Canonical FD199 artifact text encoding. */
const UTF8 = new TextEncoder()

/**
 * Mounts the Web-owner face of the handoff. Export failures are loud and
 * bounded: a store that exceeds the journal limits cannot enter the v1
 * transition and must stay desktop-owned.
 * @param ctx - Host context carrying the durable session services.
 */
export function apply(ctx: Context): void {
  const owner: Fd199WebOwner = {
    exportStoppedState: () => exportStoppedState(ctx),
  }
  ctx.provide('fd199WebOwner', owner)
}

/**
 * Exports every durable session artifact as one canonical FD199 entry.
 * @param ctx - Host context carrying the durable session services.
 * @returns the digest-verified immutable export files.
 */
async function exportStoppedState(ctx: Context): Promise<readonly Fd199ExportFile[]> {
  if (!ctx.sessionPersistence.supportsRawArtifacts) throw new Fd199AuthorityError()
  const files: Fd199ExportFile[] = []
  let total = 0
  for (const session of ctx.sessions.list()) {
    if (files.length >= REMOTE_HOST_FD199_MAX_FILES) throw new Fd199AuthorityError()
    // The authoritative durability barrier: identical to the one the log
    // export uses immediately before its raw artifact read.
    await ctx.sessions.flush(session)
    const raw = await ctx.sessionPersistence.readRaw(session.id)
    if (raw === undefined) continue
    const bytes = UTF8.encode(raw.content)
    if (bytes.byteLength === 0 || bytes.byteLength > REMOTE_HOST_FD199_MAX_BODY_BYTES - 512) throw new Fd199AuthorityError()
    total += bytes.byteLength
    if (total > MAX_TOTAL_BYTES) throw new Fd199AuthorityError()
    files.push({
      name: artifactName(session.id),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    })
  }
  // The shared FD199 grammar requires a non-empty export: a hosted runtime
  // adopted with zero durable sessions has nothing to attest.
  if (files.length === 0) throw new Fd199AuthorityError()
  return files
}

/** @param id - Durable session identifier. @returns its canonical FD199 artifact name. */
function artifactName(id: SessionId): string {
  return `sessions/${String(id)}.jsonl`
}
