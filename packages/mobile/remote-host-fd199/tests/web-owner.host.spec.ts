import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionHandleClosedError, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { apply as applyWebOwner } from '../src/web-owner.ts'
import { Fd199AuthorityError } from '../src/error.ts'
import type { Fd199WebOwner } from '../src/types.ts'

async function collect(
  owner: Fd199WebOwner,
  signal = new AbortController().signal,
): Promise<Array<{ name: string; bytes: Buffer; sha256: string; chunkSizes: number[] }>> {
  const files = []
  for await (const file of owner.exportStoppedState(signal)) {
    const chunks = []
    for await (const chunk of file.bytes) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    files.push({ name: file.name, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), chunkSizes: chunks.map(chunk => chunk.byteLength) })
  }
  return files
}

async function harness(): Promise<{ ctx: Context; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fd199-owner-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  applyWebOwner(ctx)
  return {
    ctx,
    dir,
    cleanup: async () => {
      await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const TEXT = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })

async function storedSession(ctx: Context, count = 1) {
  const session = ctx.sessions.create(undefined, { meta: { cwd: '/tmp/project' } })
  for (let index = 0; index < count; index += 1) {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `message ${index} 🙂` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }
  await using writer = await ctx.sessionPersistence.create(session.header)
  await writer.append(session.snapshotEvents())
  return session
}

describe('FD199 configured Web-owner adapter', () => {
  it.each(['before-export', 'session-flush', 'store-flush', 'list', 'open', 'read'] as const)
  ('honors cancellation at %s and closes any acquired handle', async (stage) => {
    const { ctx, cleanup } = await harness()
    const handles: SessionHandle[] = []
    const control = new AbortController()
    const reason = new Error('export cancelled')
    try {
      await storedSession(ctx)
      const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      const opened = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        handles.push(handle)
        if (stage === 'open') control.abort(reason)
        if (stage === 'read') {
          const read = handle.read.bind(handle)
          vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
            expect(readArgs[2]?.signal).toBe(control.signal)
            const result = await read(...readArgs)
            control.abort(reason)
            return result
          })
        }
        return handle
      })
      if (stage === 'before-export') control.abort(reason)
      if (stage === 'session-flush') {
        const flush = ctx.sessions.flush.bind(ctx.sessions)
        vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (...args) => {
          const flushed = await flush(...args)
          control.abort(reason)
          return flushed
        })
      }
      if (stage === 'store-flush') {
        const flush = ctx.sessionPersistence.flush.bind(ctx.sessionPersistence)
        vi.spyOn(ctx.sessionPersistence, 'flush').mockImplementation(async (...args) => { await flush(...args); control.abort(reason) })
      }
      if (stage === 'list') {
        const list = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
        vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async (...args) => {
          const result = await list(...args)
          control.abort(reason)
          return result
        })
      }
      await expect(collect(ctx.get('fd199WebOwner')!, control.signal)).rejects.toBe(reason)
      if (stage === 'open' || stage === 'read') expect(opened).toHaveBeenCalledOnce()
      else expect(opened).not.toHaveBeenCalled()
      vi.restoreAllMocks()
      for (const handle of handles) await expect(handle.read()).rejects.toThrow(SessionHandleClosedError)
    } finally {
      vi.restoreAllMocks()
      await cleanup()
    }
  })

  it('propagates cancellation into an outstanding backend read and closes its handle', async () => {
    const { ctx, cleanup } = await harness()
    const control = new AbortController()
    const reason = new Error('cancel blocked read')
    const started = Promise.withResolvers<undefined>()
    let opened: SessionHandle | undefined
    try {
      await storedSession(ctx)
      const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        opened = handle
        vi.spyOn(handle, 'read').mockImplementation((_offset, _length, options) => {
          const signal = options?.signal
          if (signal === undefined) throw new Error('export omitted the read abort signal')
          expect(signal).toBe(control.signal)
          started.resolve(undefined)
          return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(reason) }, { once: true }) })
        })
        return handle
      })
      const exporting = collect(ctx.get('fd199WebOwner')!, control.signal)
      const rejected = expect(exporting).rejects.toBe(reason)
      await started.promise
      control.abort(reason)
      await rejected
      vi.restoreAllMocks()
      if (opened === undefined) throw new Error('read handle was not opened')
      await expect(opened.read()).rejects.toThrow(SessionHandleClosedError)
    } finally {
      control.abort(reason)
      vi.restoreAllMocks()
      await cleanup()
    }
  })

  it.each(['advance', 'return', 'cancel-before-read'] as const)('closes an incompletely consumed artifact on %s', async (action) => {
    const { ctx, cleanup } = await harness()
    const control = new AbortController()
    let opened: SessionHandle | undefined
    try {
      await storedSession(ctx)
      const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => { opened = await open(...args); return opened })
      const artifacts = ctx.get('fd199WebOwner')!.exportStoppedState(control.signal)[Symbol.asyncIterator]()
      const first = await artifacts.next()
      if (first.done) throw new Error('missing export artifact')
      const chunks = first.value.bytes[Symbol.asyncIterator]()
      expect((await chunks.next()).done).toBe(false)
      if (action === 'advance') await expect(artifacts.next()).rejects.toThrow(Fd199AuthorityError)
      else {
        if (action === 'cancel-before-read') {
          control.abort(new Error('cancel before read'))
          await expect(chunks.next()).rejects.toThrow('cancel before read')
        }
        await artifacts.return?.()
      }
      await chunks.return?.()
      vi.restoreAllMocks()
      if (opened === undefined) throw new Error('read handle was not opened')
      await expect(opened.read()).rejects.toThrow(SessionHandleClosedError)
    } finally {
      vi.restoreAllMocks()
      await cleanup()
    }
  })

  it.each([64, 130])('exports %i events in bounded pages with byte-identical canonical JSONL', async (count) => {
    const { ctx, dir, cleanup } = await harness()
    const control = new AbortController()
    const offsets = new Map<string, number[]>()
    try {
      const session = await storedSession(ctx, count)
      const other = await storedSession(ctx, 2)
      const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        const read = handle.read.bind(handle)
        const calls: number[] = []
        offsets.set(String(handle.id), calls)
        vi.spyOn(handle, 'read').mockImplementation((offset, length, options) => {
          calls.push(offset ?? 0)
          expect(length).toBe(64)
          expect(options?.signal).toBe(control.signal)
          return read(offset, length, options)
        })
        return handle
      })
      const files = await collect(ctx.get('fd199WebOwner')!, control.signal)
      expect(files.map(file => file.name).sort()).toEqual([session.id, other.id].map(id => `sessions/${String(id)}.jsonl`).sort())
      expect(offsets.get(String(session.id))).toEqual(Array.from({ length: Math.floor(count / 64) + 1 }, (_, page) => page * 64))
      const paths = (await readdir(dir, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const durable = await Promise.all(paths.map(path => readFile(join(dir, path))))
      expect(durable).toHaveLength(2)
      for (const file of files) {
        expect(durable.some(bytes => bytes.equals(file.bytes))).toBe(true)
        expect(file.bytes.at(-1)).toBe(10)
        expect(file.sha256).toBe(createHash('sha256').update(file.bytes).digest('hex'))
      }
    } finally {
      vi.restoreAllMocks()
      await cleanup()
    }
  })

  it('exports a complete canonical session above 8 MiB without losing history', async () => {
    const { ctx, dir, cleanup } = await harness()
    try {
      const session = ctx.sessions.create(undefined, { meta: { cwd: '/tmp/project' } })
      const text = '🙂'.repeat(2_700_000)
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      await using writer = await ctx.sessionPersistence.create(session.header)
      await writer.append(session.snapshotEvents())
      const files = await collect(ctx.get('fd199WebOwner')!)
      expect(files).toHaveLength(1)
      expect(files[0]!.bytes.byteLength).toBeGreaterThan(10 * 1024 * 1024)
      expect(new TextDecoder().decode(files[0]!.bytes)).toContain(text)
      expect(files[0]!.chunkSizes.every(size => size > 0 && size <= 262144)).toBe(true)
      const logs = (await readdir(dir, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      expect(logs).toHaveLength(1)
      const path = logs[0]
      if (path === undefined) throw new Error('missing durable canonical log')
      expect(files[0]?.bytes.equals(await readFile(join(dir, path)))).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('normalizes absent legacy delegation depth without changing the stored header', async () => {
    const { ctx, cleanup } = await harness()
    try {
      const session = ctx.sessions.create(undefined, { meta: { cwd: '/tmp/project' } })
      await using writer = await ctx.sessionPersistence.create(session.header)
      await writer.append(session.snapshotEvents())
      const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        const { delegationDepth: _depth, ...header } = handle.header
        Object.defineProperty(handle, 'header', { value: header })
        return handle
      })
      const files = await collect(ctx.get('fd199WebOwner')!)
      expect(new TextDecoder().decode(files[0]?.bytes)).toContain('"delegationDepth":0')
    } finally {
      vi.restoreAllMocks()
      await cleanup()
    }
  })

  it.each(['file-count', 'total-bytes'] as const)('refuses an export exceeding %s limits', async (limit) => {
    const { ctx, cleanup } = await harness()
    try {
      const session = ctx.sessions.create(undefined, { meta: { cwd: '/tmp/project' } })
      await using writer = await ctx.sessionPersistence.create(session.header)
      await writer.append(session.snapshotEvents())
      const snapshots = await ctx.sessionPersistence.list()
      const snapshot = snapshots[0]
      if (snapshot === undefined) throw new Error('missing fixture snapshot')
      const count = limit === 'file-count' ? 8193 : limit === 'total-bytes' ? 17 : 1
      vi.spyOn(ctx.sessionPersistence, 'list').mockResolvedValue(Array.from({ length: count }, () => snapshot))
      if (limit !== 'file-count') {
        const size = 8 * 1024 * 1024
        vi.spyOn(TextEncoder.prototype, 'encode').mockReturnValue(new Uint8Array(size))
      }
      await expect(collect(ctx.get('fd199WebOwner')!)).rejects.toThrow(Fd199AuthorityError)
    } finally {
      vi.restoreAllMocks()
      await cleanup()
    }
  })

  it('exports every durable session artifact with its exact digest', async () => {
    const { ctx, cleanup } = await harness()
    try {
      const session = ctx.sessions.create(undefined, { meta: { cwd: '/tmp/project' } })
      session.append('user/message', TEXT, { surfaceOp: 'append' })
      await using writer = await ctx.sessionPersistence.create(session.header)
      await writer.append(session.snapshotEvents())
      const owner = ctx.get('fd199WebOwner')
      expect(owner).toBeDefined()
      const files = await collect(owner!)
      expect(files).toHaveLength(1)
      expect(files[0]?.name).toBe(`sessions/${String(session.id)}.jsonl`)
      expect(files[0]?.sha256).toBe(createHash('sha256').update(files[0]?.bytes ?? new Uint8Array()).digest('hex'))
      expect(new TextDecoder().decode(files[0]?.bytes)).toContain('"user/message"')
    } finally {
      await cleanup()
    }
  })

  it('fails closed on an empty store', async () => {
    const { ctx, cleanup } = await harness()
    try {
      const owner = ctx.get('fd199WebOwner')
      await expect(collect(owner!)).rejects.toThrow(Fd199AuthorityError)
    } finally {
      await cleanup()
    }
  })

  it('fails closed when the backend cannot flush durable state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fd199-owner-'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/tmp/project' } })
    session.append('user/message', TEXT, { surfaceOp: 'append' })
    ctx.reflect.provide('sessionPersistence', { flush: async () => { throw new Fd199AuthorityError() } })
    applyWebOwner(ctx)
    try {
      const owner = ctx.get('fd199WebOwner')
      await expect(collect(owner!)).rejects.toThrow(Fd199AuthorityError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

})
