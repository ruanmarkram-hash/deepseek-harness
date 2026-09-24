import { describe, expect, it, vi } from 'vitest'
import { CurrentWebFd199Lifecycle, CurrentWebFd199LifecycleError } from '../src/lifecycle.ts'
import type { Fd199ExportFile, Fd199SameStoreTransition } from '../src/types.ts'

async function* emptyExport(_signal: AbortSignal): AsyncIterable<Fd199ExportFile> {}

function native(): Fd199SameStoreTransition {
  return {
    kind: 'native-attested-fd199-same-store-transition-v2',
    prepareReleasedStore: vi.fn<Fd199SameStoreTransition['prepareReleasedStore']>(async ({ exportStoppedState }) => {
      const files: Fd199ExportFile[] = []
      for await (const file of exportStoppedState(new AbortController().signal)) files.push(file)
      expect(files).toEqual([])
    }),
  }
}

describe('desktop ownership fence', () => {
  it('refuses hosted admission while work admitted through a reentrant exporter remains active', async () => {
    const fence = new CurrentWebFd199Lifecycle()
    const blocked = Promise.withResolvers<undefined>()
    let desktop = Promise.resolve<undefined>(undefined)
    let innerFailure = Promise.resolve()
    try {
      await fence.releaseForNative((signal) => {
        // The outer release has entered quiescing but has not yet assigned
        // its transition promise. A reentrant release therefore fails closed
        // synchronously, placing the fence in released before this returns.
        innerFailure = expect(fence.releaseForNative(emptyExport, native())).rejects.toThrow(CurrentWebFd199LifecycleError)
        fence.admitHostedService()
        desktop = fence.runDesktopOperation(() => blocked.promise)
        return emptyExport(signal)
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
    const exporter = vi.fn(emptyExport)
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
    await expect(fence.releaseForNative(() => { throw new Error('export') }, native())).rejects.toThrow(CurrentWebFd199LifecycleError)
    await expect(fence.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
    const released = new CurrentWebFd199Lifecycle('released')
    await expect(released.releaseForNative(emptyExport, native())).rejects.toThrow(CurrentWebFd199LifecycleError)
  })

  it('hands the untouched lazy producer to native only after draining and preserves its transaction signal', async () => {
    const fence = new CurrentWebFd199Lifecycle()
    const work = Promise.withResolvers<undefined>()
    const desktop = fence.runDesktopOperation(() => work.promise)
    const complete = Promise.withResolvers<undefined>()
    const authorityAbort = new AbortController()
    const exporter = vi.fn(emptyExport)
    const prepare = vi.fn<Fd199SameStoreTransition['prepareReleasedStore']>(async ({ exportStoppedState }) => {
      expect(exportStoppedState).toBe(exporter)
      expect(exporter).not.toHaveBeenCalled()
      const stream = exportStoppedState(authorityAbort.signal)
      expect(exporter).toHaveBeenCalledExactlyOnceWith(authorityAbort.signal)
      expect(await stream[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
      await complete.promise
    })
    const authority: Fd199SameStoreTransition = {
      kind: 'native-attested-fd199-same-store-transition-v2',
      prepareReleasedStore: prepare,
    }
    const transition = fence.releaseForNative(exporter, authority)
    expect(prepare).not.toHaveBeenCalled()
    expect(exporter).not.toHaveBeenCalled()
    work.resolve(undefined)
    await desktop
    await expect.poll(() => exporter.mock.calls.length).toBe(1)
    await expect(fence.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
    complete.resolve(undefined)
    await transition
  })

  it('keeps ownership fenced when native rejects before consuming the producer', async () => {
    const fence = new CurrentWebFd199Lifecycle()
    const exporter = vi.fn(emptyExport)
    const authority: Fd199SameStoreTransition = {
      kind: 'native-attested-fd199-same-store-transition-v2',
      prepareReleasedStore: vi.fn(async () => { throw new Error('native unavailable') }),
    }
    await expect(fence.releaseForNative(exporter, authority)).rejects.toThrow(CurrentWebFd199LifecycleError)
    expect(exporter).not.toHaveBeenCalled()
    await expect(fence.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
  })

  it('keeps ownership fenced when lazy enumeration fails after native starts consuming', async () => {
    const fence = new CurrentWebFd199Lifecycle()
    const exporter = vi.fn(async function* (_signal: AbortSignal): AsyncIterable<Fd199ExportFile> {
      throw new Error('enumeration failed')
    })
    await expect(fence.releaseForNative(exporter, native())).rejects.toThrow(CurrentWebFd199LifecycleError)
    expect(exporter).toHaveBeenCalledOnce()
    await expect(fence.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
  })
})
