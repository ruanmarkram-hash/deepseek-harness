import { realpathSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
})

it('imports the public CLI without native-only resources but hosted lookup still fails closed', async () => {
  vi.resetModules()
  const unavailable = vi.fn(() => { throw Object.assign(new Error('missing hosted-root.yml'), { code: 'ENOENT' }) })
  vi.doMock('node:fs', async () => ({
    ...await vi.importActual<typeof import('node:fs')>('node:fs'),
    realpathSync: Object.assign(vi.fn(realpathSync), { native: unavailable }),
  }))
  const boot = await import('../src/profile-boot.ts')
  expect(unavailable).not.toHaveBeenCalled()
  expect(typeof boot.prepareProfile).toBe('function')
  expect(() => boot.hostedBootConfiguration()).toThrow('missing hosted-root.yml')
  expect(() => boot.sealedHostedProfile()).toThrow('missing hosted-root.yml')
})
