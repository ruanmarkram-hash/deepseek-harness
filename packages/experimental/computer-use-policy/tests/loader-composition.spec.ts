/** Loader, registry, approval audit, and native lifetime use production code. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import * as ProgressNarration from '@deepseek-ai/dsh-progress-narration'
import * as Policy from '../src/index.ts'
import { native } from './fixtures/native.ts'

vi.mock('@trycua/cua-driver', async () => import('./fixtures/native.ts'))

let ctx: Context
let root: string
beforeEach(() => {
  native.creates = 0
  native.calls = []
  native.shutdowns = 0
  native.destroys = 0
  native.call = undefined
  native.listError = undefined
  native.list = undefined
})
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

async function boot(withApproval = true) {
  root = await mkdtemp(join(tmpdir(), 'dsh-native-policy-'))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-computer-use', ComputerUseRegistry],
    ...withApproval ? [['@deepseek-ai/dsh-user-approval', ApprovalService] as const] : [],
    ['@deepseek-ai/dsh-progress-narration', ProgressNarration],
    ['@deepseek-ai/dsh-experimental-computer-use-policy', Policy],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...modules.keys()].map(name => `- name: '${name}'\n`).join(''))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture import: ${specifier}`)
      return modules.get(specifier)
    },
    loadCache: new Map(),
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  // Refuse to exercise calls unless the external native mock was used.
  expect(native.creates).toBe(1)
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['cua_driver_native__fixture_only_action'])
  const policy = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-experimental-computer-use-policy')?.fiber
  if (policy === undefined) throw new Error('Policy did not load')
  return policy
}

async function agent(id = 'owner') {
  const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'fixture', model: 'fixture' } })
  handle.agent.session.append('turn/start', { turn: 1 })
  return handle
}

function click(subject?: Agent, signal = new AbortController().signal) {
  return ctx.tools.execute({ ...subject !== undefined ? { agent: subject } : {}, signal, callId: ToolCallId(`click-${native.calls.length}`), name: 'cua_driver_native__fixture_only_action', arguments: {} })
}

it.each<ApprovalOutcome>(['rejected', 'unavailable', 'cancelled'])('fails closed on %s and frees an unadmitted lease', async (outcome) => {
  await boot()
  const first = await agent()
  const second = await agent('second')
  const answerer = ctx.on('approval/request', () => Promise.resolve(outcome))
  expect((await click(first.agent)).isError).toBe(true)
  expect(native.calls).toHaveLength(0)
  answerer()
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  expect((await click(second.agent)).isError).toBe(false)
})

it.each([true, false])('denies missing answerer or missing approval service (service=%s)', async (withApproval) => {
  await boot(withApproval)
  expect((await click((await agent()).agent)).isError).toBe(true)
  expect(native.calls).toHaveLength(0)
})

it('contains answerer rejection and denies calls with no Agent', async () => {
  await boot()
  ctx.on('approval/request', () => Promise.reject(new Error('answerer failed')))
  expect((await click((await agent()).agent)).isError).toBe(true)
  expect((await click()).isError).toBe(true)
  expect(native.calls).toHaveLength(0)
})

it('delegates unrelated tools without asking for desktop approval', async () => {
  await boot()
  ctx.tools.register(defineContentToolFixture({ name: 'unrelated', description: 'Local test operation.', parameters: {}, async execute() { return [] } }))
  const result = await ctx.tools.execute({ name: 'unrelated', arguments: {}, callId: ToolCallId('unrelated'), signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(native.calls).toHaveLength(0)
})

it('keeps Agent identity, ownership, and retirement checks monotonic', async () => {
  await boot()
  const first = await agent()
  const second = await agent('second')
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  expect((await click(first.agent)).isError).toBe(false)
  ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
  expect((await click()).isError).toBe(true)
  expect((await click(second.agent)).isError).toBe(true)
  await first.dispose()
  expect((await click(first.agent)).isError).toBe(true)
  expect(native.calls).toHaveLength(1)
})

it('rechecks retirement after an intervening dispatch wrapper', async () => {
  await boot()
  const first = await agent()
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  ctx.on('tools/execute', async (_exec, next) => {
    await first.dispose()
    return next()
  }, { prepend: true })
  expect((await click(first.agent)).isError).toBe(true)
  expect(native.calls).toHaveLength(0)
})

it('rolls back native startup failure and releases the provider registration', async () => {
  native.listError = new Error('fixture catalog unavailable')
  await expect(boot()).rejects.toThrow()
  expect(native.shutdowns).toBe(1)
  expect(native.destroys).toBe(1)
  expect(ctx.computerUse.providerName).toBeUndefined()
  expect(ctx.tools.schemas()).toEqual([])
})

it('aborts native startup when the policy is disposed before discovery finishes', async () => {
  const started: PromiseWithResolvers<AbortSignal> = Promise.withResolvers()
  const catalog: PromiseWithResolvers<string> = Promise.withResolvers()
  native.list = async (signal) => {
    if (signal === undefined) throw new Error('Native discovery must receive cancellation')
    started.resolve(signal)
    const abort = () => { catalog.reject(new Error('Fixture discovery aborted')) }
    signal.addEventListener('abort', abort, { once: true })
    try { return await catalog.promise } finally { signal.removeEventListener('abort', abort) }
  }
  const loading = boot().catch(() => undefined)
  const signal = await started.promise
  const policy = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-experimental-computer-use-policy')?.fiber
  if (policy === undefined) throw new Error('Policy startup was not registered')
  const disposal = policy.dispose()
  try {
    await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
  } finally {
    catalog.reject(new Error('Fixture discovery cleanup'))
    await loading
    await disposal
  }
  expect(native.shutdowns).toBe(1)
  expect(native.destroys).toBe(1)
  expect(ctx.computerUse.providerName).toBeUndefined()
  expect(ctx.tools.schemas()).toEqual([])
})

it('requires a fresh approval for every call and rejects a prepended allow bypass', async () => {
  await boot()
  const owner = await agent()
  let requests = 0
  ctx.on('approval/request', () => { requests += 1; return Promise.resolve('allowed-once') })
  const first = await click(owner.agent)
  expect(first.isError, JSON.stringify(first)).toBe(false)
  expect(await click(owner.agent)).toMatchObject({ isError: false })
  expect(requests).toBe(2)
  ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
  expect((await click(owner.agent)).isError).toBe(true)
  expect(native.calls).toHaveLength(2)
})

it('cancels pending approval, discards a late grant, and frees the reservation', async () => {
  await boot()
  const first = await agent()
  const second = await agent('second')
  const asked: PromiseWithResolvers<void> = Promise.withResolvers()
  const answer = Promise.withResolvers<ApprovalOutcome>()
  const off = ctx.on('approval/request', () => { asked.resolve(); return answer.promise })
  const controller = new AbortController()
  const pending = click(first.agent, controller.signal)
  await asked.promise
  expect((await click(second.agent)).isError).toBe(true)
  controller.abort()
  expect((await pending).isError).toBe(true)
  answer.resolve('allowed-once')
  off()
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  expect((await click(second.agent)).isError).toBe(false)
  expect(native.calls).toHaveLength(1)
})

it('keeps the lease through idle and releases it on Agent disposal', async () => {
  await boot()
  const first = await agent()
  const second = await agent('second')
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  expect((await click(first.agent)).isError).toBe(false)
  expect(first.agent.status).toBe('idle')
  expect((await click(second.agent)).isError).toBe(true)
  await first.dispose()
  expect((await click(first.agent)).isError).toBe(true)
  expect((await click(second.agent)).isError).toBe(false)
})

it('retires a pending approval with its Agent and never admits its late grant', async () => {
  await boot()
  const first = await agent()
  const second = await agent('second')
  const asked: PromiseWithResolvers<void> = Promise.withResolvers()
  const answer = Promise.withResolvers<ApprovalOutcome>()
  const stop = ctx.on('approval/request', () => { asked.resolve(); return answer.promise })
  const pending = click(first.agent)
  await asked.promise
  await first.dispose()
  expect((await pending).isError).toBe(true)
  answer.resolve('allowed-once')
  stop()
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  expect((await click(second.agent)).isError).toBe(false)
  expect(native.calls).toHaveLength(1)
})

it('drains pending approval when the whole Loader context unloads', async () => {
  await boot()
  const owner = await agent()
  const asked: PromiseWithResolvers<void> = Promise.withResolvers()
  const answer = Promise.withResolvers<ApprovalOutcome>()
  ctx.on('approval/request', () => { asked.resolve(); return answer.promise })
  const pending = click(owner.agent)
  await asked.promise
  await ctx.fiber.dispose()
  expect((await pending).isError).toBe(true)
  answer.resolve('allowed-once')
  expect(native.calls).toHaveLength(0)
  expect(native.shutdowns).toBe(1)
})

it('aborts all owner calls on disposal and holds the lease until native work drains', async () => {
  await boot()
  const first = await agent()
  const second = await agent('second')
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  const finish: PromiseWithResolvers<void> = Promise.withResolvers()
  native.call = () => finish.promise
  const calls = [click(first.agent), click(first.agent)]
  await vi.waitFor(() => { expect(native.calls).toHaveLength(2) })
  await first.dispose()
  expect(native.calls.every(call => call.signal?.aborted)).toBe(true)
  expect((await click(second.agent)).isError).toBe(true)
  finish.resolve()
  expect((await Promise.all(calls)).every(result => result.isError)).toBe(true)
  native.call = undefined
  expect((await click(second.agent)).isError).toBe(false)
})

it('unloads pending approval and removes native tools before policy can disappear', async () => {
  const policy = await boot()
  const owner = await agent()
  const asked: PromiseWithResolvers<void> = Promise.withResolvers()
  const answer = Promise.withResolvers<ApprovalOutcome>()
  ctx.on('approval/request', () => { asked.resolve(); return answer.promise })
  const pending = click(owner.agent)
  await asked.promise
  await policy.dispose()
  expect((await pending).isError).toBe(true)
  answer.resolve('allowed-once')
  expect(ctx.tools.schemas().some(tool => tool.name.startsWith('cua_driver_native__'))).toBe(false)
  expect(ctx.computerUse.providerName).toBeUndefined()
  expect(native.calls).toHaveLength(0)
  expect(native.shutdowns).toBe(1)
  expect(native.destroys).toBe(1)
})

it('awaits running native calls on policy unload and preserves the caller signal', async () => {
  const policy = await boot()
  const owner = await agent()
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  const finish: PromiseWithResolvers<void> = Promise.withResolvers()
  native.call = () => finish.promise
  const controller = new AbortController()
  const pending = click(owner.agent, controller.signal)
  await vi.waitFor(() => { expect(native.calls).toHaveLength(1) })
  let disposed = false
  const disposal = policy.dispose().then(() => { disposed = true })
  await vi.waitFor(() => { expect(native.calls[0]?.signal?.aborted).toBe(true) })
  expect(disposed).toBe(false)
  expect(controller.signal.aborted).toBe(false)
  finish.resolve()
  await disposal
  expect((await pending).isError).toBe(true)
  expect(native.shutdowns).toBe(1)
})

it('keeps policy installed while downstream admission drains during unload', async () => {
  const policy = await boot()
  const owner = await agent()
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish: PromiseWithResolvers<void> = Promise.withResolvers()
  ctx.on('tools/pre-execute', async (_exec, next) => {
    entered.resolve()
    await finish.promise
    return next()
  })
  const pending = click(owner.agent)
  await entered.promise
  let disposed = false
  const disposal = policy.dispose().then(() => { disposed = true })
  await vi.waitFor(() => { expect(native.shutdowns).toBe(1) })
  expect(disposed).toBe(false)
  expect((await click(owner.agent)).isError).toBe(true)
  ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
  expect((await click(owner.agent)).isError).toBe(true)
  finish.resolve()
  await disposal
  expect((await pending).isError).toBe(true)
  expect(native.calls).toHaveLength(0)
})

it('logs narration, approval, tools, and a single final answer in the same Session', async () => {
  await boot()
  class FixtureModel extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this.requests.length === 1 ? 'I am checking the fixture window.' : 'The fixture window was clicked.' } }
      if (this.requests.length === 1) {
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('narrated-click'), name: 'cua_driver_native__fixture_only_action', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const model = new FixtureModel()
  ctx.llm.registerAdapter(['fixture'], model)
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  const handle = await ctx.agents.create({ sessionId: SessionId('narration'), agentOptions: { provider: 'fixture', model: 'fixture' } })
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Click the fixture window.' }], source: { kind: 'user' } }))
  await handle.agent.whenIdle()
  expect(model.requests).toHaveLength(2)
  expect(JSON.stringify(model.requests[0])).toContain(ProgressNarration.PROGRESS_NARRATION_POLICY.replaceAll('\n', '\\n'))
  const events = handle.agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'approval/asked')).toHaveLength(1)
  expect(events.filter(event => event.type === 'approval/decided')).toHaveLength(1)
  expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
  expect(native.calls).toHaveLength(1)
  expect(events.find(event => event.type === 'tool/result')?.data.message.isError).not.toBe(true)
  const messages = handle.agent.session.deriveMessages().filter(message => message.role === 'assistant')
  expect(messages).toHaveLength(2)
  expect(messages.map(message => message.content.filter(block => block.type === 'text').map(block => block.text))).toEqual([
    ['I am checking the fixture window.'], ['The fixture window was clicked.'],
  ])
  expect(ctx.agents.list()).toHaveLength(1)
})
