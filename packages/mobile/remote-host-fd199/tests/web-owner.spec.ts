import { mkdtemp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply as applyWebOwner } from '../src/web-owner.ts'
import { Fd199AuthorityError } from '../src/error.ts'

async function harness(): Promise<{ ctx: Context; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fd199-owner-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  applyWebOwner(ctx)
  return {
    ctx,
    cleanup: async () => {
      await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const TEXT = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })

describe('FD199 configured Web-owner adapter', () => {
  it('exports every durable session artifact with its exact digest', async () => {
    const { ctx, cleanup } = await harness()
    try {
      const session = ctx.sessions.create(undefined, { meta: { cwd: '/tmp/project' } })
      session.append('user/message', TEXT, { surfaceOp: 'append' })
      const owner = ctx.get('fd199WebOwner')
      expect(owner).toBeDefined()
      const files = await owner!.exportStoppedState()
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
      await expect(owner!.exportStoppedState()).rejects.toThrow(Fd199AuthorityError)
    } finally {
      await cleanup()
    }
  })

  it('fails closed when the backend exposes no per-session raw artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fd199-owner-'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/tmp/project' } })
    session.append('user/message', TEXT, { surfaceOp: 'append' })
    ;(ctx as unknown as Record<string, unknown>)['sessionPersistence'] = { supportsRawArtifacts: false }
    applyWebOwner(ctx)
    try {
      const owner = ctx.get('fd199WebOwner')
      await expect(owner!.exportStoppedState()).rejects.toThrow(Fd199AuthorityError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

})
