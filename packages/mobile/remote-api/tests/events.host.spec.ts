import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileEvents } from '../src/events.ts'
import { RpcId } from '../src/api/rpc.ts'
import type { ClientResponse, HostFrame, MuxFrame, RpcRequest } from '../src/api/index.ts'
import type { WorkspaceFollowFrame } from '@deepseek-ai/dsh-api-workspace-controller'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { 'test/mobile-count': number }
  interface SessionProjectionMap { 'test/mobile-count': number }
}

class Source<T> {
  private readonly items: T[] = []
  private wake: (() => void) | undefined
  push(item: T): void { this.items.push(item); this.wake?.(); this.wake = undefined }
  async *read(signal: AbortSignal): AsyncGenerator<T> {
    const abort = (): void => { this.wake?.(); this.wake = undefined }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        const item = this.items.shift()
        if (item !== undefined) yield item
        else await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally { signal.removeEventListener('abort', abort) }
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness(options: { ready?: boolean; beforeMux?: (ctx: Context) => void } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService)
  options.beforeMux?.(ctx)
  cleanups.push(() => ctx.fiber.dispose())
  const source = new Source<unknown>()
  vi.spyOn(ctx.typertGateway.wireStream, 'open').mockImplementation((_channel, _request, _input, _metadata, signal) => Promise.resolve(source.read(signal)))
  const results = vi.spyOn(ctx.typertGateway, 'wireRpc').mockResolvedValue({ ok: true, value: {} })
  const events = new MobileEvents(ctx)
  const lifetime = new AbortController()
  const frames: Array<RpcRequest<MuxFrame>> = []
  const pumping = (async () => { for await (const frame of events.mux(lifetime.signal)) frames.push(frame) })()
  cleanups.push(async () => { lifetime.abort(); await pumping })
  if (options.ready !== false) source.push({ type: 'ready', clientId: 'phone' })
  return { ctx, source, results, events, frames, lifetime, pumping }
}

function interaction(event: string, eventId: string, request: object): object {
  return { type: 'waterfall', event, eventId, agentId: 'session', request }
}

function answer(rpcId: string, value: unknown): ClientResponse {
  return { type: 'client-response', rpcId: RpcId(rpcId), result: { ok: true, value } }
}

it('delegates unrelated waterfalls and refuses invalid approval responses without settling ownership', async () => {
  const { source, events, frames, results } = await harness()
  source.push({ type: 'unrelated' })
  source.push({ type: 'cancel', eventId: 'absent' })
  source.push(interaction('other/request', 'other', {}))
  source.push(interaction('approval/request', 'approval', { toolName: 'shell', reason: 'fixture' }))
  await vi.waitFor(() => { expect(frames).toHaveLength(1) })
  expect(results).toHaveBeenCalledWith('$events/result', { args: { clientId: 'phone', eventId: 'other', outcome: { kind: 'next' } } }, expect.any(AbortSignal))
  expect(frames[0]?.payload).toMatchObject({ type: 'approval/requested', reason: 'fixture' })
  for (const response of [
    answer('approval', {}), answer('approval', { sessionId: 'session', approvalId: 'wrong', outcome: 'allowed-once' }),
    { type: 'client-response' as const, rpcId: RpcId('approval'), result: { ok: false as const, error: { code: 'cancelled' as const, message: 'cancelled', details: {} } } },
  ]) expect(await events.respond(response)).toEqual({ accepted: false, reason: 'bad-response' })
  results.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'expired', details: {} } })
  expect(await events.respond(answer('approval', { sessionId: 'session', approvalId: 'approval', outcome: 'allowed-once' }))).toEqual({ accepted: false, reason: 'not-pending' })
  source.push({ type: 'cancel', eventId: 'approval' })
  await vi.waitFor(() => { expect(frames).toHaveLength(2) })
  expect(frames[1]?.payload).toMatchObject({ type: 'approval/resolved', outcome: 'cancelled' })
})

it('subscribes existing sessions and preserves committed assistant, user and lifecycle events', async () => {
  const { ctx, frames } = await harness({ beforeMux(context) {
    context.sessions.create(SessionId('existing'), {})
    context.sessionProjections.register({ key: 'test/mobile-count', stateSchema: z.number(), init: () => 0, apply: state => state + 1, stateVersion: 1, wire: { viewSchema: z.number(), view: state => state } })
  } })
  const session = ctx.sessions.create(SessionId('messages'), {})
  const lifecycle = session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'answer' }] }) }, { surfaceOp: 'append' })
  await vi.waitFor(() => { expect(frames.filter(frame => frame.payload.type === 'session/event')).toHaveLength(3) })
  expect(frames.map(frame => frame.payload)).toEqual(expect.arrayContaining([
    { type: 'session/subscribed', sessionId: 'existing', lastSeq: -1 },
    expect.objectContaining({ type: 'session/projection', sessionId: 'messages', key: 'test/mobile-count', value: 3 }),
  ]))
  const assistant = frames.find(frame => frame.payload.type === 'session/event' && frame.payload.event.type === 'assistant/message')
  expect(assistant?.payload).toMatchObject({ type: 'session/event', event: { data: { text: 'answer', role: 'assistant' } } })
  const notification = frames.find(frame => frame.payload.type === 'session/event' && frame.payload.event.type === 'turn/start')
  expect(notification?.payload.type === 'session/event' && notification.payload.event).toBe(lifecycle)
})

it('retains independent deliveries when one of two phone connections leaves', async () => {
  const { ctx, source, events, frames, lifetime, pumping } = await harness()
  const second = new Source<unknown>()
  vi.spyOn(ctx.typertGateway.wireStream, 'open').mockImplementationOnce((_channel, _request, _input, _metadata, signal) => Promise.resolve(second.read(signal)))
  const secondLifetime = new AbortController()
  const secondFrames: Array<RpcRequest<MuxFrame>> = []
  const secondPump = (async () => { for await (const frame of events.mux(secondLifetime.signal)) secondFrames.push(frame) })()
  cleanups.push(async () => { secondLifetime.abort(); await secondPump })
  second.push({ type: 'ready', clientId: 'second-phone' })
  const request = interaction('approval/request', 'shared', { toolName: 'shell' })
  source.push(request)
  second.push(request)
  await vi.waitFor(() => { expect(frames).toHaveLength(1); expect(secondFrames).toHaveLength(1) })
  lifetime.abort()
  await pumping
  expect(await events.respond(answer('shared', { sessionId: 'session', approvalId: 'shared', outcome: 'allowed-once' }))).toEqual({ accepted: true })
  await vi.waitFor(() => { expect(secondFrames).toHaveLength(2) })
  expect(secondFrames[1]?.payload).toMatchObject({ type: 'approval/resolved', outcome: 'allowed-once' })
})

it('ignores cancellation before ready and cleans a failed pre-ready stream', async () => {
  const { source, frames } = await harness({ ready: false })
  source.push({ type: 'cancel', eventId: 'not-delivered' })
  source.push(interaction('approval/request', 'before-ready', { toolName: 'shell' }))
  await vi.waitFor(() => { expect(frames).toHaveLength(1) })
  expect(frames[0]?.payload.type).toBe('stream/error')
})

it('does not publish a transport failure after its phone connection has closed', async () => {
  const { ctx, events } = await harness()
  const lifetime = new AbortController()
  vi.spyOn(ctx.typertGateway.wireStream, 'open').mockImplementationOnce(() => {
    lifetime.abort()
    return Promise.reject(new Error('transport closed'))
  })
  const reader = events.mux(lifetime.signal)[Symbol.asyncIterator]()
  expect(await reader.next()).toEqual({ done: true, value: undefined })
})

it('drops a late response frame when the receiving phone disconnects during settlement', async () => {
  const { source, events, frames, results, lifetime, pumping } = await harness()
  source.push(interaction('approval/request', 'late', { toolName: 'shell' }))
  await vi.waitFor(() => { expect(frames).toHaveLength(1) })
  const settlement = Promise.withResolvers<Awaited<ReturnType<typeof results>>>()
  results.mockReturnValueOnce(settlement.promise)
  const response = events.respond(answer('late', { sessionId: 'session', approvalId: 'late', outcome: 'allowed-once' }))
  lifetime.abort()
  await pumping
  settlement.resolve({ ok: true, value: {} })
  expect(await response).toEqual({ accepted: true })
  expect(frames).toHaveLength(1)
})

it.each([false, true])('reports workspace failures only while connected (aborted=%s)', async (aborted) => {
  const { ctx, events } = await harness()
  const lifetime = new AbortController()
  ctx.reflect.provide('workspaceController', { async *follow() {
    if (aborted) lifetime.abort()
    throw new Error('workspace unavailable')
  } })
  const reader = events.host(lifetime.signal)[Symbol.asyncIterator]()
  const result = await reader.next()
  if (aborted) expect(result.done).toBe(true)
  else {
    expect(result.done).toBe(false)
    if (!result.done) expect(result.value.payload).toMatchObject({ type: 'stream/error', error: { message: 'Workspace event stream unavailable' } })
  }
  lifetime.abort()
  await reader.return?.(undefined)
})

it('validates question answers and distinguishes phone cancellation from upstream cancellation', async () => {
  const { source, events, frames, results } = await harness()
  source.push(interaction('user-questions/request', 'question', { questions: [] }))
  await vi.waitFor(() => { expect(frames).toHaveLength(1) })
  const reject = (code: 'cancelled' | 'internal'): ClientResponse => ({ type: 'client-response', rpcId: RpcId('question'), result: { ok: false, error: { code, message: 'fixture', details: {} } } })
  expect(await events.respond(reject('internal'))).toEqual({ accepted: false, reason: 'bad-response' })
  expect(await events.respond(answer('question', {}))).toEqual({ accepted: false, reason: 'bad-response' })
  expect(await events.respond(answer('question', { sessionId: 'wrong', answer: { answers: [] } }))).toEqual({ accepted: false, reason: 'bad-response' })
  expect(await events.respond(reject('cancelled'))).toEqual({ accepted: true })
  expect(results).toHaveBeenLastCalledWith('$events/result', { args: { clientId: 'phone', eventId: 'question', outcome: { kind: 'rejected', error: { name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' } } } }, expect.any(AbortSignal))
  source.push(interaction('user-questions/request', 'second', { questions: [] }))
  await vi.waitFor(() => { expect(frames.some(frame => frame.rpcId === 'second')).toBe(true) })
  expect(await events.respond(answer('second', { sessionId: 'session', answer: { answers: [] } }))).toEqual({ accepted: true })
  source.push(interaction('user-questions/request', 'third', { questions: [] }))
  source.push({ type: 'cancel', eventId: 'third' })
  await vi.waitFor(() => { expect(frames.some(frame => frame.payload.type === 'question/resolved' && frame.payload.questionRpcId === 'third')).toBe(true) })
})

it.each([
  null, [], 'invalid',
  { type: 'waterfall' },
  interaction('approval/request', 'invalid-tool', {}),
  interaction('user-questions/request', 'invalid-questions', {}),
])('reports malformed Host interaction input as a stream failure', async (invalid) => {
  const { source, frames, events } = await harness()
  source.push(invalid)
  await vi.waitFor(() => { expect(frames).toHaveLength(1) })
  expect(frames[0]?.payload).toMatchObject({ type: 'stream/error', error: { message: 'Host interaction stream unavailable' } })
  expect(await events.respond(answer('invalid-tool', {}))).toEqual({ accepted: false, reason: 'not-pending' })
})

it('forwards workspace notifications and disposes the stream on abort', async () => {
  const { ctx, events } = await harness()
  const source = new Source<WorkspaceFollowFrame>()
  ctx.reflect.provide('workspaceController', { follow: (signal: AbortSignal) => source.read(signal) })
  const lifetime = new AbortController()
  const frames: Array<RpcRequest<HostFrame>> = []
  const pumping = (async () => { for await (const frame of events.host(lifetime.signal)) frames.push(frame) })()
  cleanups.push(async () => { lifetime.abort(); await pumping })
  const workspaceId = WorkspaceId('workspace')
  source.push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  source.push({ type: 'upsert', workspace: { workspaceId, path: '/tmp', title: 'fixture', sessionIds: [], createdAt: '0', updatedAt: '0' } })
  source.push({ type: 'remove', workspaceId })
  source.push({ type: 'order', workspaceIds: [workspaceId] })
  source.push({ type: 'archived', archivedSessionIds: [SessionId('archived')] })
  source.push({ type: 'pinned', pinnedSessionIds: [] })
  ctx.emit('api-session/added', { sessionId: SessionId('short'), blank: true, agentAvailable: false, updatedAt: 0, running: false })
  ctx.emit('api-session/added', { sessionId: SessionId('full'), blank: false, agentAvailable: false, updatedAt: 0, running: false, cwd: '/tmp', parentSessionId: SessionId('parent'), origin: 'subagent' })
  ctx.emit('api-session/removed', SessionId('removed'))
  ctx.emit('api-session/status', SessionId('status'), true)
  ctx.emit('api-session/error', SessionId('error'), 'fixture')
  await vi.waitFor(() => { expect(frames).toHaveLength(9) })
  expect(frames.map(frame => frame.payload.type)).toEqual(expect.arrayContaining(['host/session-added', 'host/session-removed', 'host/session-status', 'host/agent-error', 'host/workspace-changed', 'host/workspace-removed', 'host/workspace-order-changed', 'host/archived-sessions-changed']))
  lifetime.abort()
  await pumping
  ctx.emit('api-session/removed', SessionId('after-close'))
  expect(frames).toHaveLength(9)
})
