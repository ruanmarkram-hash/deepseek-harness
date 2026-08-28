import { describe, expect, it, vi } from 'vitest'
import { disconnectRemoteWhenBackgrounded } from '../mobile-app-state'

describe('mobile app state', () => {
  it('preserves the remote client during an iOS inactive interruption', () => {
    const disconnect = vi.fn()

    disconnectRemoteWhenBackgrounded('inactive', disconnect)

    expect(disconnect).not.toHaveBeenCalled()
  })

  it('disconnects the remote client after the app enters the background', () => {
    const disconnect = vi.fn()

    disconnectRemoteWhenBackgrounded('background', disconnect)

    expect(disconnect).toHaveBeenCalledOnce()
  })
})
