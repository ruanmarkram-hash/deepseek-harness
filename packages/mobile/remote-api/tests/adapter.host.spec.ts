import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { WorkspaceFollowFrame } from '@deepseek-ai/dsh-api-workspace-controller'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { TypertRemoteEventDispatch, TypertRemoteEventOutcome } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { createMobileApi } from '../src/adapter.ts'
import { installDesktopDiscovery } from '../src/discovery.ts'
import { apply } from '../src/index.ts'
import { RpcId } from '../src/api/rpc.ts'
import type { MuxFrame, RpcRequest, RpcMethodMap } from '../src/api/index.ts'
import { invokeApiProxyMethod } from '../src/fetch/handler.ts'
import { z } from 'zod'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness(options: { realLlm?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService)
  if (options.realLlm === true) await ctx.plugin(Llm)
  cleanups.push(() => ctx.fiber.dispose())
  createSessionTestController(ctx, { cwd: '/tmp', defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }) })
  const api = createMobileApi(ctx)
  return { ctx, api }
}

describe('released mobile API over current Host owners', () => {
  it('mounts the compatibility service and lists children without activating the parent', async () => {
    const { ctx } = await harness()
    const listChildren = vi.fn(() => Promise.resolve([]))
    ctx.reflect.provide('subagents', { listChildren })
    apply(ctx)
    expect(await ctx.apiProxy.subagents.list({ rpcId: RpcId('children'), payload: { parentSessionId: SessionId('parent') } }, new AbortController().signal)).toEqual({ rpcId: 'children', result: { ok: true, value: { entries: [], parentAvailable: false } } })
    expect(listChildren).toHaveBeenCalledWith('parent', expect.any(AbortSignal))
  })
  it('describes the live Host and projects model catalogs without activating a session', async () => {
    const { ctx, api } = await harness({ realLlm: true })
    vi.spyOn(ctx.llm, 'listConfigurableProviders').mockReturnValue([
      { provider: 'active', displayName: 'Active', settingsNs: 'active', settingsPath: [] },
      { provider: 'inactive', displayName: 'Inactive', settingsNs: 'inactive', settingsPath: [] },
    ])
    vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([{ id: 'active', name: 'Active' }, { id: 'runtime', name: 'Runtime' }])
    const providers = await api.llm.providers({ rpcId: RpcId('providers'), payload: {} })
    expect(providers).toMatchObject({ result: { ok: true, value: { providers: [
      { provider: 'active', active: true }, { provider: 'inactive', active: false },
      { provider: 'runtime', displayName: 'Runtime', settingsNs: '', settingsPath: [], active: true },
    ] } } })
    const catalog = { default: { provider: 'fixture', model: 'fixture' }, routableProviders: ['fixture'], groups: [], failures: [] }
    vi.spyOn(ctx.sessionController, 'modelCatalog').mockResolvedValue(catalog)
    expect(await api.host.describe({ rpcId: RpcId('describe'), payload: {} })).toMatchObject({ result: { ok: true, value: { version: '0.1.7', cwd: process.cwd(), attachedSessions: 0, provider: 'fixture', model: 'fixture' } } })
    expect(await api.llm.models({ rpcId: RpcId('models'), payload: {} })).toMatchObject({ result: { ok: true, value: { groups: [], failures: [] } } })
    const projections = vi.spyOn(ctx.sessionController, 'projections').mockResolvedValue(null)
    expect(await api.sessions.models({ rpcId: RpcId('default'), payload: { sessionId: SessionId('s') } })).toMatchObject({ result: { ok: true, value: { current: catalog.default, routable: true } } })
    projections.mockResolvedValue({ asOfSeq: 0, values: { modelSelection: { lastUsed: null, next: { provider: 'other', model: 'other' } } } })
    expect(await api.sessions.models({ rpcId: RpcId('selected'), payload: { sessionId: SessionId('s') } })).toMatchObject({ result: { ok: true, value: { current: { provider: 'other', model: 'other' }, routable: false } } })
  })

  it('reads history through current paging and omits projections on earlier pages', async () => {
    const { ctx, api } = await harness()
    const session = ctx.sessions.create(SessionId('history'), {})
    const page = vi.spyOn(ctx.sessionController, 'page').mockResolvedValue({ records: [], hasMore: false })
    const projections = vi.spyOn(ctx.sessionController, 'projections').mockResolvedValue(null)
    const request = { rpcId: RpcId('history'), payload: { sessionId: session.id } }
    expect(await api.sessions.history(request)).toEqual({ rpcId: 'history', result: { ok: true, value: { events: [], hasMore: false } } })
    expect(page).toHaveBeenLastCalledWith({ address: { kind: 'session', sessionId: session.id }, throughSeq: -1 }, expect.any(AbortSignal))
    const event = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'history' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const wireEvent = { ...event, data: z.json().parse(event.data) }
    page.mockResolvedValue({ records: [{ type: 'event', event: wireEvent }], hasMore: true })
    projections.mockResolvedValue({ asOfSeq: event.seq, values: {} })
    expect(await api.sessions.history(request)).toMatchObject({
      result: { ok: true, value: { events: [{ event }], projections: { asOfSeq: event.seq } } },
    })
    projections.mockClear()
    expect(await api.subagents.history({ rpcId: RpcId('child-history'), payload: { parentSessionId: SessionId('parent'), childSessionId: session.id, mode: 'continuable', beforeSeq: 1, maxMessages: 2 } }, new AbortController().signal)).toMatchObject({ result: { ok: true, value: { events: [{ event }], hasMore: true } } })
    expect(page).toHaveBeenLastCalledWith({ address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: session.id, mode: 'continuable' }, throughSeq: event.seq, beforeSeq: 1, maxMessages: 2 }, expect.any(AbortSignal))
    expect(projections).not.toHaveBeenCalled()
  })

  it('requires a workspace baseline and releases its reader on every outcome', async () => {
    const { ctx, api } = await harness()
    let frames: WorkspaceFollowFrame[] = [{ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }]
    const closed = vi.fn()
    ctx.reflect.provide('workspaceController', { async *follow() { try { yield* frames } finally { closed() } } })
    expect(await api.workspace.list({ rpcId: RpcId('baseline'), payload: {} })).toMatchObject({ result: { ok: true, value: { items: [], archivedSessionIds: [] } } })
    frames = []
    expect(await api.workspace.list({ rpcId: RpcId('empty'), payload: {} })).toMatchObject({ result: { ok: false } })
    frames = [{ type: 'archived', archivedSessionIds: [] }]
    expect(await api.workspace.list({ rpcId: RpcId('wrong-first'), payload: {} })).toMatchObject({ result: { ok: false } })
    expect(closed).toHaveBeenCalledTimes(3)
    frames = [{ type: 'archived', archivedSessionIds: [SessionId('archived')] }]
    const lifetime = new AbortController()
    const reader = api.events.host({ rpcId: RpcId('host-events'), payload: {} }, lifetime.signal)[Symbol.asyncIterator]()
    const next = await reader.next()
    expect(next.done).toBe(false)
    if (!next.done) expect(next.value.payload).toEqual({ type: 'host/archived-sessions-changed', archivedSessionIds: ['archived'] })
    lifetime.abort()
    await reader.return?.(undefined)
  })
  it('maps each released controller command to its current namespace and arguments', async () => {
    const { ctx, api } = await harness()
    const call = vi.spyOn(ctx.typertGateway, 'invoke')
    const signal = new AbortController().signal
    const ref = { id: 'goal', revision: 1 }
    const address = { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }
    const rows: Array<[keyof RpcMethodMap, object, string, string, object, unknown, unknown]> = [
      ['session.cancel', { sessionId: 's' }, 'session', 'cancel', { request: { sessionId: 's' } }, { accepted: true }, { accepted: true }],
      ['workspace.create', { path: '/tmp' }, 'workspace', 'create', { request: { path: '/tmp' } }, { created: true }, { created: true }],
      ['host.pickDirectory', {}, 'directoryPicker', 'pick', {}, '/tmp', { path: '/tmp' }],
      ['host.listDirectory', { path: '/tmp' }, 'directoryPicker', 'list', { path: '/tmp' }, { entries: [] }, { entries: [] }],
      ['host.createDirectory', { path: '/tmp', name: 'child' }, 'directoryPicker', 'createDirectory', { path: '/tmp', name: 'child' }, '/tmp/child', { path: '/tmp/child' }],
      ['host.openPath', { path: '/tmp' }, 'session', 'openWorkspacePath', { request: { path: '/tmp' } }, { opened: true }, { opened: true }],
      ['skill.list', { sessionId: 's' }, 'skills', 'list', { request: { sessionId: 's' } }, { skills: [] }, { skills: [] }],
      ['plugins.list', {}, 'hostPlugins', 'list', {}, { plugins: [] }, { plugins: [] }],
      ['plugins.setEnabled', { id: 'computer-use', enabled: false }, 'hostPlugins', 'setEnabled', { id: 'computer-use', enabled: false }, { plugin: { id: 'computer-use', name: 'Computer use', source: 'bundled', enabled: false, required: false } }, { plugin: { id: 'computer-use', name: 'Computer use', source: 'bundled', enabled: false, required: false } }],
      ['settings.describe', {}, 'settings', 'describe', {}, { namespaces: [] }, { namespaces: [] }],
      ['settings.openDocument', {}, 'settings', 'openSettingsDocument', {}, { opened: true }, { opened: true }],
      ['settings.update', { ns: 'fixture', patch: {} }, 'settings', 'update', { ns: 'fixture', patch: {} }, { revision: 1 }, { revision: 1 }],
      ['settings.replace', { ns: 'fixture', section: {} }, 'settings', 'replace', { ns: 'fixture', section: {} }, { revision: 2 }, { revision: 2 }],
      ['settings.mutate', { ns: 'fixture', ops: [] }, 'settings', 'mutate', { ns: 'fixture', ops: [] }, { revision: 3 }, { revision: 3 }],
      ['credentials.describe', { refs: ['FIXTURE'] }, 'credentials', 'describe', { refs: ['FIXTURE'] }, {}, { credentials: {} }],
      ['credentials.set', { ref: 'FIXTURE', value: 'synthetic' }, 'credentials', 'set', { ref: 'FIXTURE', value: 'synthetic' }, undefined, {}],
      ['credentials.unset', { ref: 'FIXTURE' }, 'credentials', 'unset', { ref: 'FIXTURE' }, undefined, {}],
      ['agentPreset.list', {}, 'agentPresets', 'list', {}, { presets: [{ id: 'fixture', isDefault: true }] }, { presets: [{ id: 'fixture', isDefault: true, trust: 'system' }], authorable: false, hasDocument: false }],
      ['agentPreset.read', { agentPreset: 'fixture' }, 'agentPresets', 'read', { agentPreset: 'fixture' }, { content: 'fixture' }, { content: 'fixture', trust: 'system' }],
      ['agentPreset.select', { sessionId: 's', agentPreset: 'fixture' }, 'agentPresets', 'select', { agent: 's', agentPreset: 'fixture' }, 'fixture', { agentPreset: 'fixture' }],
      ['llm.discoverModels', { settingsNs: 'fixture', baseURL: 'https://fixture.invalid' }, 'llm', 'discoverModels', { settingsNs: 'fixture', request: { baseURL: 'https://fixture.invalid' } }, [], { models: [] }],
      ['goal.create', { sessionId: 's', objective: 'fixture' }, 'goals', 'create', { agent: 's', request: { objective: 'fixture' } }, { ref }, { ref }],
      ['goal.edit', { sessionId: 's', ref, objective: 'next' }, 'goals', 'edit', { agent: 's', ref, request: { objective: 'next' } }, ref, { ref }],
      ...(['pause', 'resume', 'complete'] as const).map((method): [keyof RpcMethodMap, object, string, string, object, unknown, unknown] => [`goal.${method}`, { sessionId: 's', ref }, 'goals', method, { agent: 's', ref }, ref, { ref }]),
      ['goal.clear', { sessionId: 's', ref }, 'goals', 'clear', { agent: 's', ref }, undefined, { cleared: true }],
      ['subagent.prompt', { ...address, content: [] }, 'subagents', 'prompt', { request: { ...address, content: [], requestId: 'command', delivery: 'queue' } }, { messageId: 'message' }, { messageId: 'message' }],
      ['subagent.interrupt', address, 'subagents', 'interruptByParent', address, { accepted: true }, { accepted: true }],
    ]
    for (const [method, payload, namespace, name, args, result, expected] of rows) {
      call.mockResolvedValueOnce(result)
      expect(await invokeApiProxyMethod(api, method, { rpcId: RpcId('command'), payload }, signal), method).toEqual({ rpcId: 'command', result: { ok: true, value: expected } })
      const invocation = call.mock.calls.at(-1)?.[0]
      expect(invocation).toMatchObject({ namespace, method: name, args })
      expect(invocation?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('reports unavailable legacy capabilities, cancellation and unavailable exports explicitly', async () => {
    const { ctx, api } = await harness()
    const response = await api.agentPresets.copy({ rpcId: RpcId('copy'), payload: { from: 'source', agentPreset: 'target' } })
    expect(response).toMatchObject({ result: { ok: false, error: { code: 'internal', message: 'This Host version no longer supports mobile agentPreset.copy' } } })
    vi.spyOn(ctx.typertGateway, 'invoke').mockRejectedValue(new Error('fixture failure'))
    expect(await api.subagents.prompt({ rpcId: RpcId('cancelled'), payload: { parentSessionId: SessionId('parent'), childSessionId: SessionId('child'), mode: 'continuable', content: [] } }, AbortSignal.abort())).toMatchObject({ result: { ok: false, error: { code: 'cancelled' } } })
    expect((await api.downloads.sessionLog({ sessionId: SessionId('s') }, new AbortController().signal)).status).toBe(404)
  })
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
    expect((await fetch(url)).status).toBe(405)
    expect((await fetch(url, { ...init, body: 'x'.repeat(8193) })).status).toBe(413)
    expect((await fetch(url, { method: 'POST' })).status).toBe(415)
    expect((await fetch(url, { ...init, body: '{' })).status).toBe(400)
    expect((await fetch(url.replace('host.describe', 'session.create'), init)).status).toBe(404)
  })
  it('handles decoded request chunks and transport write failures without retrying committed headers', async () => {
    const { ctx, api } = await harness()
    vi.spyOn(api.host, 'describe').mockResolvedValue({ rpcId: RpcId('discovery'), result: { ok: true, value: { version: 'fixture', cwd: '/tmp', home: '/tmp', attachedSessions: 0, canOpenPath: false } } })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const register = ctx.webServer.register.bind(ctx.webServer)
    let failure: 'none' | 'headers' | 'body' = 'none'
    const headerWrites: number[] = []
    vi.spyOn(ctx.webServer, 'register').mockImplementation(route => register({ ...route, async handler(request, response) {
      request.setEncoding('utf8')
      const writes = vi.spyOn(response, 'writeHead')
      if (failure === 'headers') writes.mockImplementationOnce(() => { throw new Error('transport header failure') })
      if (failure === 'body') vi.spyOn(response, 'end').mockImplementationOnce(() => { throw new Error('transport body failure') })
      await route.handler(request, response)
      headerWrites.push(writes.mock.calls.length)
    } }))
    installDesktopDiscovery(ctx, api)
    const url = `http://127.0.0.1:${ctx.webServer.port}/api/host.describe`
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'discovery', method: 'host.describe', payload: {} }) }
    expect((await fetch(url, init)).status).toBe(200)
    failure = 'headers'
    const headersFailed = await fetch(url, init)
    expect(headersFailed.status).toBe(500)
    expect(await headersFailed.text()).toBe('')
    failure = 'body'
    const bodyFailed = await fetch(url, init)
    expect(bodyFailed.status).toBe(200)
    expect(await bodyFailed.text()).toBe('')
    expect(headerWrites).toEqual([1, 2, 1])
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
