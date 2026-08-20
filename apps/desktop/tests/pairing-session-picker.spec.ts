import { describe, expect, it } from 'vitest'
import { PairingSessionPicker, type PairingSessionSource } from '../src/pairing-session-picker.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve: value => resolve?.(value) }
}

describe('PairingSessionPicker', () => {
  it('does not repopulate a reopened picker from a late old session listing', async () => {
    const picker = new PairingSessionPicker()
    const firstWindow = {}
    const secondWindow = {}
    const oldListing = deferred<readonly { readonly key: string }[]>()
    const oldTransport: PairingSessionSource = { listSelectableSessions: () => oldListing.promise }
    const newTransport: PairingSessionSource = { listSelectableSessions: async () => [{ key: 'new-session' }] }
    let nextId = 0
    const createId = (): string => `picker-${String(++nextId)}`

    picker.open(firstWindow, oldTransport)
    const oldList = picker.list(firstWindow, oldTransport, createId)
    picker.close(firstWindow)
    picker.open(secondWindow, newTransport)
    const newList = await picker.list(secondWindow, newTransport, createId)
    oldListing.resolve([{ key: 'old-session' }])

    await expect(oldList).rejects.toThrow('pairing is unavailable')
    expect(newList).toEqual([{ id: 'picker-1', label: 'Desktop session 1' }])
    expect(picker.take(secondWindow, newTransport, newList[0]?.id)).toEqual({ key: 'new-session' })
    expect(picker.take(secondWindow, newTransport, 'picker-2')).toBeUndefined()
  })
})
