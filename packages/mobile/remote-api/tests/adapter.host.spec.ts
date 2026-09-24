import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { TypertRemoteEventDispatch, TypertRemoteEventOutcome } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { createMobileApi } from '../src/adapter.ts'
import { installDesktopDiscovery } from '../src/discovery.ts'
import { RpcId } from '../src/api/rpc.ts'
import type { MuxFrame, RpcRequest } from '../src/api/index.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService)
  cleanups.push(() => ctx.fiber.dispose())
  createSessionTestController(ctx, { cwd: '/tmp', defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }) })
  const api = createMobileApi(ctx)
  return { ctx, api }
}

describe('released mobile API over current Host owners', () => {
  it('serves the thin Desktop discovery envelope only to local non-browser requests', async () => {
    const { ctx, api } = await harness()
    vi.spyOn(api.host, 'describe').mockResolvedValue({ rpcId: RpcId('desktop-discovery'), result: { ok: true, value: { version: '0.1.7', cwd: '/tmp', home: '/tmp', attachedSessions: 0, canOpenPath: true } } })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    installDesktopDiscovery(ctx, api)
    const url = `http://127.0.0.1:${ctx.webServer.port}/api/host.describe`
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-discovery', method: 'host.describe', payload: {} }) }
    const response = await fetch(url, init)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ type: 'server-response', rpcId: 'desktop-discovery', result: { ok: true, value: { version: '0.1.7', cwd: '/tmp' } } })
    expect((await fetch(url, { ...init, headers: { ...init.headers, origin: 'https://example.invalid' } })).status).toBe(403)
    expect((await fetch(url.replace('host.describe', 'session.create'), init)).status).toBe(404)
  })
  it('lists actual current Sessions through the named Typert contract', async () => {
    const { ctx, api } = await harness()
    const session = ctx.sessions.create(SessionId('mobile-list'), { meta: { cwd: '/tmp' } })
    const result = await api.sessions.list({ rpcId: RpcId('mobile-list-request'), payload: {} })
    expect(result).toMatchObject({ rpcId: 'mobile-list-request', result: { ok: true, value: { items: [{ sessionId: session.id, running: false, blank: true }] } } })
  })

  it('supplies the stable mobile correlation as the current prompt request identity', async () => {
    const { ctx, api } = await harness()
    const prompt = vi.spyOn(ctx.sessionController, 'prompt').mockResolvedValue({ accepted: true })
    const payload = { sessionId: SessionId('mobile-prompt'), mode: 'steer' as const, content: [{ type: 'text' as const, text: 'hello' }] }
    expect(await api.sessions.prompt({ rpcId: RpcId('mobile-prompt-request'), payload })).toMatchObject({ result: { ok: true, value: { accepted: true } } })
    expect(prompt).toHaveBeenCalledWith({ ...payload, requestId: 'mobile-prompt-request' }, expect.any(AbortSignal))
  })

  it('fences direct mobile operations after late hosted authority installation', async () => {
    const { ctx, api } = await harness()
    const list = vi.spyOn(ctx.sessionController, 'list')
    ctx.reflect.provide('fd199DesktopWriteFence', { runDesktopOperation: async () => { throw new Error('closed') } })
    expect(await api.sessions.list({ rpcId: RpcId('fenced-list'), payload: {} })).toMatchObject({ result: { ok: false } })
    expect(list).not.toHaveBeenCalled()
  })

  it('projects committed user messages for the installed build32 renderer', async () => {
    const { ctx, api } = await harness()
    const source = new EventSource()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.read, { home: '/tmp' })
    cleanups.push(unregister)
    const lifetime = new AbortController()
    const frames: Array<RpcRequest<MuxFrame>> = []
    const pumping = (async () => { for await (const frame of api.events.mux({ rpcId: RpcId('events'), payload: {} }, lifetime.signal)) frames.push(frame) })()
    cleanups.push(async () => { lifetime.abort(); await pumping })
    const session = ctx.sessions.create(SessionId('mobile-message'), { meta: { cwd: '/tmp' } })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hello from phone' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await vi.waitFor(() => {
      const message = frames.find(frame => frame.payload.type === 'session/event')?.payload
      expect(message).toMatchObject({ type: 'session/event', event: { data: { text: 'hello from phone', role: 'user' } } })
    })
  })

  it('uses the shared Gateway pending approval and refuses mismatched audit correlation', async () => {
    const { ctx, api } = await harness()
    const source = new EventSource()
    cleanups.push(ctx.typertGateway.registerRemoteEvents(source.read, { home: '/tmp' }))
    const lifetime = new AbortController()
    const frames: Array<RpcRequest<MuxFrame>> = []
    const pumping = (async () => { for await (const frame of api.events.mux({ rpcId: RpcId('events'), payload: {} }, lifetime.signal)) frames.push(frame) })()
    cleanups.push(async () => { lifetime.abort(); await pumping })
    const subject = { ctx }
    const settled = Promise.withResolvers<TypertRemoteEventOutcome>()
    source.push({ event: 'approval/request', request: { agent: subject, toolName: 'shell' }, context: { value: ctx, subject, agentId: 'mobile-approval-session' }, resolve: settled.resolve, reject: settled.reject })
    await vi.waitFor(() =>{  expect(frames.some(frame => frame.payload.type === 'approval/requested')).toBe(true) })
    const requested = frames.find(frame => frame.payload.type === 'approval/requested')!
    expect(await api.respond({ type: 'client-response', rpcId: requested.rpcId, result: { ok: true, value: { sessionId: 'wrong-session', approvalId: requested.rpcId, outcome: 'allowed-once' } } })).toEqual({ accepted: false, reason: 'bad-response' })
    expect(await api.respond({ type: 'client-response', rpcId: requested.rpcId, result: { ok: true, value: { sessionId: 'mobile-approval-session', approvalId: requested.rpcId, outcome: 'allowed-once' } } })).toEqual({ accepted: true })
    expect(await settled.promise).toEqual({ kind: 'result', value: 'allowed-once' })
    await vi.waitFor(() =>{  expect(frames.some(frame => frame.payload.type === 'approval/resolved')).toBe(true) })
    expect(await api.respond({ type: 'client-response', rpcId: requested.rpcId, result: { ok: true, value: {} } })).toEqual({ accepted: false, reason: 'not-pending' })
  })
})

class EventSource {
  private readonly pending: TypertRemoteEventDispatch[] = []
  private wake: (() => void) | undefined
  push(value: TypertRemoteEventDispatch): void { this.pending.push(value); this.wake?.(); this.wake = undefined }
  readonly read = async function* (this: EventSource, signal: AbortSignal): AsyncGenerator<TypertRemoteEventDispatch> {
    const abort = () => { this.wake?.(); this.wake = undefined }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        if (this.pending.length > 0) { yield this.pending.shift()!; continue }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally { signal.removeEventListener('abort', abort) }
  }.bind(this)
}
