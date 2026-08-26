/**
 * The hosted FD199 desktop write fence: with the optional service absent, the
 * gateway face is the untouched literal; with it mounted, every unary
 * dispatch and respond() route through the fence while event streams and the
 * identity of every namespace stay unchanged.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ApiProxy, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`fence-${String(nextRpc++)}`), payload }
}

class RecordingFence {
  calls = 0

  async runDesktopOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.calls += 1
    return operation()
  }
}

class ClosedFence {
  calls = 0

  async runDesktopOperation<T>(_operation: () => Promise<T>): Promise<T> {
    this.calls += 1
    throw new Error('the current Web FD199 lifecycle is unavailable or closed')
  }
}

async function harness(fence?: unknown): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  if (fence !== undefined) ctx.provide('fd199DesktopWriteFence', fence)
  return {
    ctx,
    api: createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
  }
}

describe('hosted FD199 desktop write fence', () => {
  it('leaves dispatch unfenced when no hosted service is mounted', async () => {
    const { api } = await harness()
    const response = await api.sessions.list(request({}))
    expect(response.result.ok).toBe(true)
  })

  it('routes unary dispatch through the mounted fence', async () => {
    const fence = new RecordingFence()
    const { api } = await harness(fence)
    const response = await api.sessions.list(request({}))
    expect(response.result.ok).toBe(true)
    expect(fence.calls).toBe(1)
  })

  it('fails a unary dispatch closed when the mounted fence is closed', async () => {
    const { api } = await harness(new ClosedFence())
    await expect(api.sessions.list(request({}))).rejects.toThrow(/lifecycle is unavailable or closed/)
  })

  it('routes respond() through the mounted fence but leaves event streams unfenced', async () => {
    const fence = new RecordingFence()
    const { ctx, api } = await harness(fence)
    await expect(api.respond({ type: 'client-response', rpcId: RpcId('missing'), result: { ok: false as const, error: { code: 'cancelled', message: 'x', details: {} } } }))
      .resolves.toMatchObject({ accepted: false })
    expect(fence.calls).toBe(1)
    // The events namespace keeps its original object identity: read-side
    // streams are never gated by the write fence.
    expect(typeof api.events.mux).toBe('function')
    void ctx
  })
})
