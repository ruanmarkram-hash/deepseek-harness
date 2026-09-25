import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/invariant.ts'
import { CurrentWebFd199Lifecycle } from '../src/lifecycle.ts'

describe('FD199 invariant companion', () => {
  it('requires a fence for a mounted hosted lifecycle', async () => {
    const ctx = new Context()
    const registry = await ctx.plugin(Invariants)
    const register = vi.spyOn(ctx.invariants, 'register').mockImplementation(() => () => {})
    await apply(ctx)
    const installer = register.mock.calls[0]?.[1]
    expect(installer).toBeDefined()
    const fail = vi.fn((message: string): never => { throw new Error(message) })
    await expect(async () => { await installer?.(ctx, fail) }).rejects.toThrow('without its desktop write fence')
    expect(fail).toHaveBeenCalledOnce()
    ctx.provide('fd199DesktopWriteFence', new CurrentWebFd199Lifecycle())
    fail.mockClear()
    await installer?.(ctx, fail)
    expect(fail).not.toHaveBeenCalled()
    await registry.dispose()
  })
})
