/**
 * Optional per-call approval and single-Agent ownership for the native provider.
 * @module @deepseek-ai/dsh-experimental-computer-use-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import * as NativeProvider from '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'
import type {} from '@deepseek-ai/dsh-user-approval'

/** Cordis plugin identity. */
export const name = 'experimental-computer-use-policy'

/** Required services; missing approval fails individual calls closed. */
export const inject = ['computerUse', 'tools', 'systemPrompt']

/** Every native call requires one approval; no desktop-wide grant exists. */
export const Config = Schema.object({})

const PREFIX = 'cua_driver_native__'
const APPROVAL_REASON = 'Computer Use requires approval before this call can observe or control the live desktop.'
const LEASE_CONFLICT = 'Computer Use is already owned by another live Agent. Close that Agent before using the desktop here.'

interface Lease {
  agent: Agent
  lifetime: AbortController
  calls: Map<ToolExecution, PromiseWithResolvers<void>>
  admitted: boolean
}

/**
 * Mount the unchanged native provider under approval and an Agent lease.
 * A lease survives idle turns and ends on Agent or Session disposal. Retiring
 * leases abort and drain all pending calls before another Agent can acquire one.
 * Unload removes native tools and waits for native shutdown before removing policy.
 * @param ctx - context receiving the protected provider and execution policy.
 * @returns after the native provider has discovered and registered its tools.
 */
export async function apply(ctx: Context): Promise<void> {
  const lifetime = new AbortController()
  const retired = new WeakSet<Agent>()
  const approved = new WeakSet<ToolExecution>()
  let lease: Lease | undefined
  let stopNative: (() => Promise<void>) | undefined
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis disposal dispatch contains async listener failures.
  ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) {
      lifetime.abort()
      // Discovery may still be awaited by apply(); abort the child immediately.
      return stopNative?.()
    }
  }, { global: true })

  const releaseIfDrained = (current: Lease): void => {
    if (lease === current && current.calls.size === 0
      && (current.lifetime.signal.aborted || !current.admitted)) lease = undefined
  }
  const retire = (agent: Agent): void => {
    retired.add(agent)
    if (lease?.agent !== agent) return
    lease.lifetime.abort()
    releaseIfDrained(lease)
  }
  const denial = (exec: ToolExecution): string | undefined => {
    if (!exec.name.startsWith(PREFIX)) return undefined
    if (lifetime.signal.aborted) return 'Computer Use is shutting down.'
    if (exec.agent === undefined) return 'Computer Use requires an Agent-owned Session.'
    if (retired.has(exec.agent)) return 'Computer Use ownership ended for this Agent.'
    if (lease !== undefined && (lease.agent !== exec.agent || lease.lifetime.signal.aborted)) return LEASE_CONFLICT
    if (!approved.has(exec)) return APPROVAL_REASON
    return undefined
  }

  let ready: Promise<void> = Promise.resolve()
  const dispose = ctx.effect(function* () {
    yield ctx.on('agent/disposed', ({ agent }) => { retire(agent) })
    yield ctx.on('session/disposed', (session) => {
      if (lease?.agent.session === session) retire(lease.agent)
    })
    yield ctx.on('tools/pre-execute', async (exec, next) => {
      if (!exec.name.startsWith(PREFIX)) return next()
      const agent = exec.agent
      if (agent === undefined) return { kind: 'deny', reason: 'Computer Use requires an Agent-owned Session.' }
      if (retired.has(agent)) return { kind: 'deny', reason: 'Computer Use ownership ended for this Agent.' }
      if (lifetime.signal.aborted) return { kind: 'deny', reason: 'Computer Use is shutting down.' }
      if (lease !== undefined && (lease.agent !== agent || lease.lifetime.signal.aborted)) {
        return { kind: 'deny', reason: LEASE_CONFLICT }
      }
      const current = lease ??= { agent, lifetime: new AbortController(), calls: new Map(), admitted: false }
      current.calls.set(exec, Promise.withResolvers<void>())
      const approval = ctx.get('approval')
      if (approval === undefined) return { kind: 'deny', reason: APPROVAL_REASON }
      const signal = AbortSignal.any([exec.signal, lifetime.signal, current.lifetime.signal])
      const outcome = await approval.request({ agent, toolName: exec.name, callId: exec.callId, reason: APPROVAL_REASON, signal })
      if (signal.aborted || outcome === 'cancelled') return { kind: 'cancel' }
      if (outcome !== 'allowed-once') return { kind: 'deny', reason: `Computer Use approval was ${outcome}.` }
      approved.add(exec)
      return next()
    })
    // Registry guards still run when another pre-execute listener returns allow.
    yield ctx.tools.guard(denial)
    yield ctx.on('tools/execute', async (exec, next) => {
      if (!exec.name.startsWith(PREFIX)) return next()
      const reason = denial(exec)
      if (reason !== undefined) throw new Error(reason)
      const current = lease
      /* v8 ignore next -- approval evidence retains its lease until tools/result; denial rejects calls without evidence */
      if (current === undefined) throw new Error('Computer Use lease is unavailable.')
      approved.delete(exec)
      current.admitted = true
      const original = exec.signal
      exec.signal = AbortSignal.any([original, lifetime.signal, current.lifetime.signal])
      try {
        exec.signal.throwIfAborted()
        return await next()
      } finally {
        exec.signal = original
      }
    })
    yield ctx.on('tools/result', (exec) => {
      if (!exec.name.startsWith(PREFIX)) return
      approved.delete(exec)
      const current = lease
      if (current === undefined) return
      current.calls.get(exec)?.resolve()
      current.calls.delete(exec)
      releaseIfDrained(current)
    })
    // Drain while result listeners remain registered, after child shutdown.
    yield async () => {
      lifetime.abort()
      if (lease === undefined) return
      lease.lifetime.abort()
      await Promise.allSettled([...lease.calls.values()].map(call => call.promise))
      lease = undefined
    }
    const provider = ctx.plugin(NativeProvider)
    stopNative = provider.dispose
    yield provider.dispose
    yield () => { lifetime.abort() }
    ready = Promise.resolve(provider).then(() => {})
  }, 'computerUsePolicy.runtime()')
  try {
    await ready
  } catch (error) {
    await dispose()
    throw error
  }
}
