import { expect, it } from 'vitest'
import { bindMobileUnaryMethods } from '../src/api/unary.ts'

it('binds every unary API member to its released method name without invoking the carrier', () => {
  const bindings = new Map<unknown, string>()
  const api = bindMobileUnaryMethods((method) => {
    const handler = () => Promise.reject(new Error('carrier not invoked during binding'))
    bindings.set(handler, method)
    return handler
  })
  const domains: Record<string, string> = {
    sessions: 'session', subagents: 'subagent', host: 'host', workspace: 'workspace',
    skills: 'skill', plugins: 'plugins', agentPresets: 'agentPreset', goals: 'goal', settings: 'settings',
    credentials: 'credentials', llm: 'llm',
  }
  expect(Object.keys(api).sort()).toEqual(Object.keys(domains).sort())
  for (const [domain, methods] of Object.entries(api)) {
    for (const [method, handler] of Object.entries(methods)) {
      expect(bindings.get(handler)).toBe(`${domains[domain]}.${method}`)
    }
  }
  expect(bindings.size).toBe(54)
})
