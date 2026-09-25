import { FiberState } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  publishBoundWebRuntimeRegistry,
  webRuntimeRegistryForPlatform,
  type WebRuntimeRegistryLifecycle,
  type WebRuntimeRegistryOwner,
} from '../src/profile-boot.ts'
import type { WebRuntimeRegistryRecord } from '../src/web-runtime-registry.ts'

const owner: WebRuntimeRegistryRecord = {
  version: 1,
  profile: 'web',
  url: 'http://127.0.0.1:43123',
  pid: 451,
  startedAt: '2026-08-20T09:00:00.000Z',
}

function fakeRoot(): {
  ctx: WebRuntimeRegistryOwner
  effect: ReturnType<typeof vi.fn>
  warning: ReturnType<typeof vi.fn>
  dispose: () => Promise<void>
  beginDisposal: () => void
} {
  let dispose = async (): Promise<void> => {}
  const effect = vi.fn((factory: () => () => Promise<void>) => { dispose = factory() })
  const warning = vi.fn()
  const fiber = { state: FiberState.ACTIVE }
  const ctx = {
    fiber,
    effect,
    logger: { warn: warning },
  }
  return { ctx, effect, warning, dispose: async () => { await dispose() }, beginDisposal: () => { fiber.state = FiberState.DISPOSED } }
}

describe('Web runtime registry profile lifecycle', () => {
  it('keeps ordinary Windows discovery without attempting a POSIX private bootstrap', async () => {
    const root = fakeRoot()
    const registry: WebRuntimeRegistryLifecycle = {
      publish: vi.fn(async () => owner),
      remove: vi.fn(async () => true),
      publishBootstrap: vi.fn(async () => { throw new Error('POSIX ownership unavailable') }),
      removeBootstrap: vi.fn(async () => true),
    }
    await expect(publishBoundWebRuntimeRegistry(root.ctx, owner.url,
      webRuntimeRegistryForPlatform(registry, false, 'win32'))).resolves.toBe(true)
    expect(registry.publish).toHaveBeenCalledExactlyOnceWith(owner.url)
    expect(registry.publishBootstrap).not.toHaveBeenCalled()
    expect(registry.remove).not.toHaveBeenCalled()
    expect(root.warning).not.toHaveBeenCalled()
    await root.dispose()
    expect(registry.remove).toHaveBeenCalledExactlyOnceWith(owner)
    expect(registry.removeBootstrap).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux', 'win32'] as const)('never omits required hosted bootstrap on %s', async (platform) => {
    const root = fakeRoot()
    const registry: WebRuntimeRegistryLifecycle = {
      publish: async () => owner,
      remove: vi.fn(async () => true),
      publishBootstrap: vi.fn(async () => { throw new Error('private bootstrap unavailable') }),
      removeBootstrap: vi.fn(async () => true),
    }
    await expect(publishBoundWebRuntimeRegistry(root.ctx, owner.url,
      webRuntimeRegistryForPlatform(registry, true, platform))).resolves.toBe(false)
    expect(registry.publishBootstrap).toHaveBeenCalledExactlyOnceWith(owner)
    expect(registry.removeBootstrap).toHaveBeenCalledExactlyOnceWith(owner)
    expect(registry.remove).toHaveBeenCalledExactlyOnceWith(owner)
    expect(root.effect).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'] as const)('preserves ordinary POSIX bootstrap on %s', (platform) => {
    const registry: WebRuntimeRegistryLifecycle = {
      publish: async () => owner, remove: async () => true,
      publishBootstrap: async () => {}, removeBootstrap: async () => true,
    }
    expect(webRuntimeRegistryForPlatform(registry, false, platform)).toBe(registry)
  })

  it('removes a record when disposal begins while publication is pending', async () => {
    const root = fakeRoot()
    let resolvePublish!: (record: WebRuntimeRegistryRecord) => void
    const registry: WebRuntimeRegistryLifecycle = {
      publish: vi.fn<() => Promise<WebRuntimeRegistryRecord>>(() => new Promise<WebRuntimeRegistryRecord>((resolve) => {
        resolvePublish = resolve
      })),
      remove: vi.fn(async () => true),
    }

    const pending = publishBoundWebRuntimeRegistry(root.ctx, owner.url, registry)
    root.beginDisposal()
    resolvePublish(owner)
    await expect(pending).resolves.toBe(false)

    expect(root.effect).not.toHaveBeenCalled()
    expect(registry.remove).toHaveBeenCalledExactlyOnceWith(owner)
    expect(root.warning).not.toHaveBeenCalled()
  })

  it('removes the record when effect registration fails after publication', async () => {
    const root = fakeRoot()
    root.effect.mockImplementation(() => { throw new Error('disposing') })
    const registry: WebRuntimeRegistryLifecycle = {
      publish: vi.fn(async () => owner),
      remove: vi.fn(async () => true),
    }

    await expect(publishBoundWebRuntimeRegistry(root.ctx, owner.url, registry)).resolves.toBe(false)

    expect(registry.remove).toHaveBeenCalledExactlyOnceWith(owner)
    expect(root.warning).toHaveBeenCalledOnce()
  })

  it('removes the record through the registered root disposer', async () => {
    const root = fakeRoot()
    const registry: WebRuntimeRegistryLifecycle = {
      publish: vi.fn(async () => owner),
      remove: vi.fn(async () => true),
    }

    await expect(publishBoundWebRuntimeRegistry(root.ctx, owner.url, registry)).resolves.toBe(true)
    await root.dispose()

    expect(root.effect).toHaveBeenCalledOnce()
    expect(registry.remove).toHaveBeenCalledExactlyOnceWith(owner)
  })

  it('waits for private bootstrap publication and removes it before the public registry', async () => {
    const root = fakeRoot()
    const order: string[] = []
    const registry: WebRuntimeRegistryLifecycle = {
      publish: async () => owner,
      publishBootstrap: async () => { order.push('bootstrap-published') },
      removeBootstrap: async () => { order.push('bootstrap-removed'); return true },
      remove: async () => { order.push('registry-removed'); return true },
    }
    await expect(publishBoundWebRuntimeRegistry(root.ctx, owner.url, registry)).resolves.toBe(true)
    expect(order).toEqual(['bootstrap-published'])
    await root.dispose()
    expect(order).toEqual(['bootstrap-published', 'bootstrap-removed', 'registry-removed'])
  })

  it('refuses readiness and removes discovery if private bootstrap publication fails', async () => {
    const root = fakeRoot()
    const registry: WebRuntimeRegistryLifecycle = {
      publish: async () => owner,
      publishBootstrap: async () => { throw new Error('private bootstrap unavailable') },
      removeBootstrap: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    }
    await expect(publishBoundWebRuntimeRegistry(root.ctx, owner.url, registry)).resolves.toBe(false)
    expect(root.effect).not.toHaveBeenCalled()
    expect(registry.removeBootstrap).toHaveBeenCalledExactlyOnceWith(owner)
    expect(registry.remove).toHaveBeenCalledExactlyOnceWith(owner)
  })
})
