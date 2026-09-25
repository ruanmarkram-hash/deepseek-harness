/** Adapter for the independently released mobile v3 command and event contract. */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApiProxy, RequestPayload, ResponseValue, RpcMethodMap, RpcRequest, RpcResponse } from './api/index.ts'
import { MobileEvents } from './events.ts'
import { bindMobileUnaryMethods } from './api/unary.ts'

const NEVER_ABORTED = new AbortController().signal

/**
 * Bind released wire operations to current business owners without reviving the old gateway.
 * @param ctx - Configured Host context containing current controllers and event owners.
 * @returns the released mobile API backed by the configured Host.
 */
export function createMobileApi(ctx: Context): ApiProxy {
  const events = new MobileEvents(ctx)
  const invoke = async (
    method: keyof RpcMethodMap, payload: Record<string, unknown>, rpcId: string, signal: AbortSignal,
  ): Promise<unknown> => {
    const call = (namespace: string, name: string, args: Record<string, unknown> = {}) =>
      ctx.typertGateway.invoke({ namespace, method: name, args, signal })
    if (method === 'host.describe') {
      const catalog = await ctx.sessionController.modelCatalog()
      return { version: '0.1.7', cwd: process.cwd(), home: homedir(), attachedSessions: ctx.sessions.list().length,
        provider: catalog.default.provider, model: catalog.default.model, canOpenPath: ctx.sessionController.canOpenWorkspacePath() }
    }
    if (method === 'workspace.list') {
      const source = ctx.workspaceController.follow(signal)[Symbol.asyncIterator]()
      try {
        const first = await source.next()
        if (first.done || first.value.type !== 'baseline') throw new Error('workspace baseline unavailable')
        return { items: first.value.value.items, archivedSessionIds: first.value.value.archivedSessionIds }
      } finally { await source.return?.() }
    }
    if (method === 'session.history' || method === 'subagent.history') {
      const { beforeSeq, maxMessages } = payload
      const sessionId = (method === 'session.history' ? payload.sessionId : payload.childSessionId) as SessionId
      const inspected = await ctx.sessionController.inspect(sessionId, signal)
      const address = method === 'session.history' ? { kind: 'session' as const, sessionId }
        : { kind: 'subagent' as const, parentSessionId: payload.parentSessionId as SessionId, childSessionId: sessionId, mode: payload.mode as 'one-shot' | 'continuable' }
      const page = await ctx.sessionController.page({ address, throughSeq: inspected.events.at(-1)?.seq ?? -1,
        ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}), ...(typeof maxMessages === 'number' ? { maxMessages } : {}) }, signal)
      const projections = beforeSeq === undefined ? await ctx.sessionController.projections({ sessionId }, signal) : undefined
      return { events: page.records.map(record => ({ event: record.event })), hasMore: page.hasMore,
        ...(projections == null ? {} : { projections }) }
    }
    if (method === 'session.models') {
      const catalog = await ctx.sessionController.modelCatalog()
      const projections = await ctx.sessionController.projections({ sessionId: payload.sessionId as SessionId }, signal)
      const current = projections?.values.modelSelection?.next ?? catalog.default
      return { current, routable: catalog.routableProviders.includes(current.provider), groups: catalog.groups, failures: catalog.failures }
    }
    if (method === 'session.list') return call('session', 'list', { _request: payload })
    if (method === 'session.prompt') return call('session', 'prompt', { request: { ...payload, requestId: rpcId } })
    if (method.startsWith('session.')) return call('session', method.slice(8), { request: payload })
    if (method.startsWith('workspace.')) return call('workspace', method.slice(10), { request: payload })
    switch (method) {
      case 'host.pickDirectory': return { path: await call('directoryPicker', 'pick') }
      case 'host.listDirectory': return call('directoryPicker', 'list', payload)
      case 'host.createDirectory': return { path: await call('directoryPicker', 'createDirectory', payload) }
      case 'host.openPath': return call('session', 'openWorkspacePath', { request: payload })
      case 'skill.list': return call('skills', 'list', { request: payload })
      case 'plugins.list': return call('hostPlugins', 'list')
      case 'plugins.setEnabled': return call('hostPlugins', 'setEnabled', payload)
      case 'settings.describe': return call('settings', 'describe')
      case 'settings.openDocument': return call('settings', 'openSettingsDocument')
      case 'settings.update': case 'settings.replace': case 'settings.mutate': return call('settings', method.slice(9), payload)
      case 'credentials.describe': return { credentials: await call('credentials', 'describe', payload) }
      case 'credentials.set': case 'credentials.unset': await call('credentials', method.slice(12), payload); return {}
      case 'agentPreset.list': {
        const roster = await call('agentPresets', 'list') as { presets: readonly object[] }
        return { presets: roster.presets.map(preset => ({ ...preset, trust: 'system' })), authorable: false, hasDocument: false }
      }
      case 'agentPreset.read': return { ...await call('agentPresets', 'read', payload) as object, trust: 'system' }
      case 'agentPreset.select': return { agentPreset: await call('agentPresets', 'select', { agent: payload.sessionId, agentPreset: payload.agentPreset }) }
      case 'llm.models': {
        const catalog = await ctx.sessionController.modelCatalog()
        return { groups: catalog.groups, failures: catalog.failures }
      }
      case 'llm.providers': {
        const directory = ctx.llm.listConfigurableProviders()
        const routes = ctx.llm.listProviders()
        const providers = directory.map(entry => ({ ...entry, active: routes.some(route => route.id === entry.provider) }))
        for (const route of routes) if (!providers.some(entry => entry.provider === route.id)) providers.push({ provider: route.id, displayName: route.name, settingsNs: '', settingsPath: [], active: true })
        return { providers }
      }
      case 'llm.discoverModels': {
        const { settingsNs, ...request } = payload
        return { models: await call('llm', 'discoverModels', { settingsNs, request }) }
      }
      case 'goal.create': {
        const { sessionId, ...request } = payload
        return call('goals', 'create', { agent: sessionId, request })
      }
      case 'goal.edit': {
        const { sessionId, ref, ...request } = payload
        const value = await call('goals', 'edit', { agent: sessionId, ref, request }) as { id: string; revision: number }
        return { ref: { id: value.id, revision: value.revision } }
      }
      case 'goal.pause': case 'goal.resume': case 'goal.complete': {
        const value = await call('goals', method.slice(5), { agent: payload.sessionId, ref: payload.ref }) as { id: string; revision: number }
        return { ref: { id: value.id, revision: value.revision } }
      }
      case 'goal.clear': await call('goals', 'clear', { agent: payload.sessionId, ref: payload.ref }); return { cleared: true }
      case 'subagent.list': return { entries: await ctx.subagents.listChildren(payload.parentSessionId as SessionId, signal), parentAvailable: ctx.agents.get(payload.parentSessionId as SessionId) !== undefined }
      case 'subagent.prompt': return call('subagents', 'prompt', { request: { ...payload, requestId: rpcId, delivery: 'queue' } })
      case 'subagent.interrupt': return call('subagents', 'interruptByParent', payload)
      default: throw new MobileCapabilityUnavailable(method)
    }
  }
  const unary = <K extends keyof RpcMethodMap>(method: K) => async (
    request: RpcRequest<RequestPayload<K>>, signal = NEVER_ABORTED,
  ): Promise<RpcResponse<ResponseValue<K>>> => {
    try {
      const value = await fenced(ctx, () => invoke(method, request.payload, request.rpcId, signal))
      return { rpcId: request.rpcId, result: { ok: true, value: value as ResponseValue<K> } }
    } catch (error) {
      return { rpcId: request.rpcId, result: { ok: false, error: { code: signal.aborted ? 'cancelled' : 'internal', message: error instanceof MobileCapabilityUnavailable ? error.message : 'The Host could not complete this mobile operation', details: {} } } }
    }
  }
  return {
    ...bindMobileUnaryMethods(unary),
    events: { mux: (_request, signal) => events.mux(signal), host: (_request, signal) => events.host(signal) },
    downloads: { sessionLog: () => Promise.resolve(new Response('Mobile session export is unavailable', { status: 404 })) },
    respond: message => fenced(ctx, () => events.respond(message)),
  }
}

class MobileCapabilityUnavailable extends Error {
  constructor(method: string) { super(`This Host version no longer supports mobile ${method}`) }
}

/** Resolve authority at dispatch time, including when the startup plugin mounted after this adapter. */
function fenced<T>(ctx: Context, operation: () => Promise<T>): Promise<T> {
  const fence = ctx.get('fd199DesktopWriteFence') as { runDesktopOperation<T>(operation: () => Promise<T>): Promise<T> } | undefined
  return fence === undefined ? operation() : fence.runDesktopOperation(operation)
}
