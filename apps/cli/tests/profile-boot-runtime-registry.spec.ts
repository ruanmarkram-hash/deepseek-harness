import { FiberState, type Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  publishBoundWebRuntimeRegistry,
  type WebRuntimeRegistryLifecycle,
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
  ctx: Context
  effect: ReturnType<typeof vi.fn>
  warning: ReturnType<typeof vi.fn>
  dispose: () => Promise<void>
} {
  let dispose = async (): Promise<void> => {}
  const effect = vi.fn((factory: () => () => Promise<void>) => { dispose = factory() })
  const warning = vi.fn()
  const ctx = {
    fiber: { state: FiberState.ACTIVE },
    effect,
    logger: { warn: warning },
  } as unknown as Context
  return { ctx, effect, warning, dispose: async () => { await dispose() } }
}

describe('Web runtime registry profile lifecycle', () => {
  it('removes a record when disposal begins while publication is pending', async () => {
    const root = fakeRoot()
    let resolvePublish!: (record: WebRuntimeRegistryRecord) => void
    const registry: WebRuntimeRegistryLifecycle = {
      publish: vi.fn<() => Promise<WebRuntimeRegistryRecord>>(() => new Promise<WebRuntimeRegistryRecord>(resolve => { resolvePublish = resolve })),
      remove: vi.fn(async () => true),
    }

    const pending = publishBoundWebRuntimeRegistry(root.ctx, owner.url, registry)
    ;(root.ctx.fiber as { state: FiberState }).state = FiberState.DISPOSED
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
})
