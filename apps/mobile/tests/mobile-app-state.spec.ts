import { describe, expect, it, vi } from 'vitest'
import { disconnectRemoteWhenBackgrounded } from '../mobile-app-state'

describe('mobile app state', () => {
  it.each(['inactive', 'active'] as const)('leaves the remote client inert on %s', (state) => {
    const disconnect = vi.fn()

    disconnectRemoteWhenBackgrounded(state, disconnect)

    expect(disconnect).not.toHaveBeenCalled()
  })

  it('disconnects the remote client after the app enters the background', () => {
    const disconnect = vi.fn()

    disconnectRemoteWhenBackgrounded('background', disconnect)

    expect(disconnect).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledWith('background')
  })
})
