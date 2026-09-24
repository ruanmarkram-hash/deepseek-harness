import { describe, expect, it, vi } from 'vitest'
import { CurrentWebFd199Lifecycle, CurrentWebFd199LifecycleError } from '../src/lifecycle.ts'
import type { Fd199SameStoreTransition } from '../src/types.ts'

function native(): Fd199SameStoreTransition {
  return { kind: 'native-attested-fd199-same-store-transition-v1', prepareReleasedStore: vi.fn(async () => {}) }
}

describe('desktop ownership fence', () => {
  it('refuses hosted admission while work admitted through a reentrant exporter remains active', async () => {
    const fence = new CurrentWebFd199Lifecycle()
    const blocked = Promise.withResolvers<undefined>()
    let desktop = Promise.resolve<undefined>(undefined)
    let innerFailure = Promise.resolve()
    try {
      await fence.releaseForNative(async () => {
        // The outer release has entered quiescing but has not yet assigned
        // its transition promise. A reentrant release therefore fails closed
        // synchronously, placing the fence in released before this returns.
        innerFailure = expect(fence.releaseForNative(async () => [], native())).rejects.toThrow(CurrentWebFd199LifecycleError)
        fence.admitHostedService()
        desktop = fence.runDesktopOperation(() => blocked.promise)
        return []
      }, native())
      await innerFailure
      // The outer release completed while that reentrantly admitted operation
      // is still active. The independent active-operation guard must remain.
      expect(() => { fence.admitHostedService() }).toThrow(CurrentWebFd199LifecycleError)
      await expect(fence.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
    } finally {
      blocked.resolve(undefined)
      await desktop
    }
  })

  it('drains all active work once before exporting and supports a later hosted generation', async () => {
    const fence = new CurrentWebFd199Lifecycle()
    const first = Promise.withResolvers<undefined>()
    const second = Promise.withResolvers<undefined>()
    const a = fence.runDesktopOperation(() => first.promise)
    const b = fence.runDesktopOperation(() => second.promise)
    const exporter = vi.fn(async () => [])
    const authority = native()
    const transition = fence.releaseForNative(exporter, authority)
    expect(fence.releaseForNative(exporter, authority)).toBe(transition)
    expect(() => { fence.admitHostedService() }).toThrow(CurrentWebFd199LifecycleError)
    await expect(fence.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
    first.resolve(undefined)
    await a
    expect(exporter).not.toHaveBeenCalled()
    second.resolve(undefined)
    await b
    await transition
    expect(exporter).toHaveBeenCalledOnce()
    fence.admitHostedService()
    expect(() => { fence.admitHostedService() }).toThrow(CurrentWebFd199LifecycleError)
    await expect(fence.runDesktopOperation(async () => 42)).resolves.toBe(42)
    await fence.releaseForNative(exporter, authority)
    expect(exporter).toHaveBeenCalledTimes(2)
  })

  it('keeps failed export and initially released ownership closed', async () => {
    const fence = new CurrentWebFd199Lifecycle()
    await expect(fence.runDesktopOperation(async () => { throw new Error('operation') })).rejects.toThrow('operation')
    await expect(fence.releaseForNative(async () => { throw new Error('export') }, native())).rejects.toThrow(CurrentWebFd199LifecycleError)
    await expect(fence.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
    const released = new CurrentWebFd199Lifecycle('released')
    await expect(released.releaseForNative(async () => [], native())).rejects.toThrow(CurrentWebFd199LifecycleError)
  })
})
