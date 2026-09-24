/**
 * Configured Web-graph adapter for the FD199 same-store transition. Mounted
 * only beside the hosted startup plugin: it exports the durable session
 * artifacts as digest-verified FD199 entries and hands ownership of the
 * remaining store handles to this process's own ordered teardown, which the
 * signed Host launcher triggers immediately after a settled transaction.
 * @module @deepseek-ai/dsh-remote-host-fd199/web-owner
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { snapshotSessionFormatJson, type SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { REMOTE_HOST_FD199_MAX_CHUNK_BYTES, REMOTE_HOST_FD199_MAX_FILES, REMOTE_HOST_FD199_MAX_TOTAL_BYTES } from './protocol.ts'
import { Fd199AuthorityError } from './error.ts'
import type { Fd199ExportFile, Fd199WebOwner } from './types.ts'

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
 * bounded: a store that exceeds the journal limits cannot enter the v2
 * transition and must stay desktop-owned.
 * @param ctx - Host context carrying the durable session services.
 */
export function apply(ctx: Context): void {
  const owner: Fd199WebOwner = {
    exportStoppedState: signal => exportStoppedState(ctx, signal),
  }
  ctx.provide('fd199WebOwner', owner)
}

/**
 * Exports every durable session artifact as one canonical FD199 entry.
 * @param ctx - Host context carrying the durable session services.
 * @param signal - Transaction cancellation propagated into persistence reads.
 * @returns the complete logical artifacts with lazily encoded byte chunks.
 */
async function* exportStoppedState(ctx: Context, signal: AbortSignal): AsyncGenerator<Fd199ExportFile> {
  let count = 0
  let total = 0
  signal.throwIfAborted()
  for (const session of ctx.sessions.list()) {
    await ctx.sessions.flush(session)
    signal.throwIfAborted()
  }
  await ctx.sessionPersistence.flush()
  signal.throwIfAborted()
  for (const snapshot of await ctx.sessionPersistence.list()) {
    signal.throwIfAborted()
    if (count >= REMOTE_HOST_FD199_MAX_FILES) throw new Fd199AuthorityError()
    await using handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read')
    signal.throwIfAborted()
    const consumption = { completed: false }
    yield {
      name: artifactName(handle.id),
      bytes: (async function* (): AsyncGenerator<Uint8Array> {
        const header = sessionFormatCatalog.encodeCurrentHeader(
          { ...handle.header, delegationDepth: handle.header.delegationDepth ?? 0 }, handle.inheritedEventCount,
        )
        yield* encodeRecord(header)
        // The backend currently caches a whole parsed log. Paging bounds this
        // adapter's returned slices, not the persistence backend's memory.
        for (let offset = 0; ; offset += 64) {
          signal.throwIfAborted()
          const { events } = await handle.read(offset, 64, { signal })
          signal.throwIfAborted()
          for (const event of events) {
            yield* encodeRecord(sessionFormatCatalog.encodeCurrentEvent(snapshotSessionFormatJson(event) as SessionFormatEvent))
          }
          if (events.length < 64) break
        }
        consumption.completed = true
      })(),
    }
    // Advancing the artifact iterator before consuming its bytes would close
    // its handle and falsely attest an incomplete store.
    if (!consumption.completed) throw new Fd199AuthorityError()
    count += 1
  }
  // The shared FD199 grammar requires a non-empty export: a hosted runtime
  // adopted with zero durable sessions has nothing to attest.
  if (count === 0) throw new Fd199AuthorityError()

  function* encodeRecord(record: unknown): Generator<Uint8Array> {
    signal.throwIfAborted()
    const bytes = UTF8.encode(JSON.stringify(record) + '\n')
    if (bytes.byteLength > REMOTE_HOST_FD199_MAX_TOTAL_BYTES - total) throw new Fd199AuthorityError()
    total += bytes.byteLength
    for (let offset = 0; offset < bytes.byteLength; offset += REMOTE_HOST_FD199_MAX_CHUNK_BYTES) {
      signal.throwIfAborted()
      yield bytes.subarray(offset, offset + REMOTE_HOST_FD199_MAX_CHUNK_BYTES)
    }
  }
}

/** @param id - Durable session identifier. @returns its canonical FD199 artifact name. */
function artifactName(id: SessionId): string {
  return `sessions/${String(id)}.jsonl`
}
