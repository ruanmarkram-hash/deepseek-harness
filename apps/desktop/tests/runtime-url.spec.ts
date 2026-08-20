import { describe, expect, it } from 'vitest'
import { localHarnessUrl, trustedRuntimeNavigation } from '../src/runtime-url.ts'
import { desktopWebPreferences } from '../src/window-security.ts'

describe('localHarnessUrl', () => {
  it('accepts loopback HTTP URLs published by the local runtime', () => {
    expect(localHarnessUrl('http://127.0.0.1:3080/').origin).toBe('http://127.0.0.1:3080')
  })

  it.each(['https://127.0.0.1:3080/', 'http://example.com/', 'file:///tmp/index.html'])('rejects %s', (value) => {
    expect(() => localHarnessUrl(value)).toThrow('DSH Desktop rejected non-local Harness URL')
  })

  it('blocks a server redirect to another origin', () => {
    expect(trustedRuntimeNavigation('http://127.0.0.1:3080/session/1', 'http://127.0.0.1:3080')).toBe(true)
    expect(trustedRuntimeNavigation('https://example.com/', 'http://127.0.0.1:3080')).toBe(false)
  })

  it('does not give the rendered DSH page Node privileges', () => {
    expect(desktopWebPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true })
  })
})
