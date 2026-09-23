import { describe, expect, it, vi } from 'vitest'
import { connectStoredHost } from '../mobile-connection-action'
import { NativeMobileRemoteStateStore, type DshMobileRemoteStateNativeModule } from '../mobile-remote-state'

const config = {
  clientAuthToken: 'a'.repeat(32),
  connectionEpoch: 1,
  deviceEnrollmentId: 'device_enrollment_identifier_123',
  hostDeviceId: 'host_device_identifier_123456',
  hostEnrollmentId: 'host_enrollment_identifier_123',
  hostStaticAgreementPublicKey: 'b'.repeat(43),
  routeGeneration: 1,
  routeId: 'remote_route_identifier_123',
}

class MemoryNativeStore implements DshMobileRemoteStateNativeModule {
  record: string | null = null
  async clearRemoteState(): Promise<void> { this.record = null }
  async loadRemoteState(): Promise<string | null> { return this.record }
  async saveRemoteState(record: string): Promise<void> { this.record = record }
}

function store(native: MemoryNativeStore): NativeMobileRemoteStateStore {
  return new NativeMobileRemoteStateStore(native)
}

async function pairedStore(native: MemoryNativeStore): Promise<NativeMobileRemoteStateStore> {
  const value = store(native)
  await value.saveInvitation({
    config,
    expiresAt: '2026-09-01T00:00:00.000Z',
    identityProvider: { clearUserPresence: () => undefined, deviceIdentity: async () => { throw new Error('unused') }, requireUserPresence: async () => undefined },
  })
  return value
}

describe('connectStoredHost', () => {
  it('queues an explicit replacement behind a cancelled native read without letting the old action release its lock', async () => {
    const native = new MemoryNativeStore()
    await pairedStore(native)
    let releaseRead: ((record: string | null) => void) | undefined
    native.loadRemoteState = async () => new Promise<string | null>((resolve) => { releaseRead = resolve })
    const persisted = store(native)
    let releaseConnect: (() => void) | undefined
    const client = { connect: vi.fn(async () => new Promise<void>((resolve) => { releaseConnect = resolve })), reconnect: vi.fn() }
    const controller = new AbortController()
    const first = connectStoredHost(client as never, { kind: 'disconnected' }, persisted, vi.fn(), controller.signal)
    await vi.waitFor(() => { expect(releaseRead).toBeDefined() })
    controller.abort()
    const replacement = connectStoredHost(client as never, { kind: 'disconnected' }, persisted, vi.fn(), new AbortController().signal)
    releaseRead?.(native.record)
    await first
    await vi.waitFor(() => { expect(client.connect).toHaveBeenCalledOnce() })
    await connectStoredHost(client as never, { kind: 'disconnected' }, persisted, vi.fn())
    expect(client.connect).toHaveBeenCalledOnce()
    releaseConnect?.()
    await replacement
  })
  it('does not authenticate or open pairing when backgrounding cancels a pending native read', async () => {
    let release: ((value: null) => void) | undefined
    const native = new MemoryNativeStore()
    native.loadRemoteState = async () => new Promise<null>((resolve) => { release = resolve })
    const persisted = store(native)
    const client = { connect: vi.fn(), reconnect: vi.fn() }
    const openPairing = vi.fn()
    const controller = new AbortController()
    const pending = connectStoredHost(client as never, { kind: 'disconnected' }, persisted, openPairing, controller.signal)
    await vi.waitFor(() => { expect(release).toBeDefined() })
    controller.abort()
    release?.(null)
    await pending
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.reconnect).not.toHaveBeenCalled()
    expect(openPairing).not.toHaveBeenCalled()
  })
  it('serializes duplicate taps even before React publishes connecting, then permits explicit retry', async () => {
    let release: (() => void) | undefined
    let entered: (() => void) | undefined
    const started = new Promise<void>((resolve) => { entered = resolve })
    const client = {
      connect: vi.fn(async () => new Promise<void>((resolve) => { release = resolve; entered?.() })),
      reconnect: vi.fn(async () => undefined) }
    const persisted = await pairedStore(new MemoryNativeStore())
    const first = connectStoredHost(client as never, { kind: 'disconnected' }, persisted, vi.fn())
    const second = connectStoredHost(client as never, { kind: 'disconnected' }, persisted, vi.fn())
    await second
    await started
    expect(client.connect).toHaveBeenCalledOnce()
    release?.()
    await first
    await connectStoredHost(client as never, { kind: 'error', message: 'timed out' }, persisted, vi.fn())
    expect(client.reconnect).toHaveBeenCalledOnce()
  })

  it('opens local pairing rather than opening a socket without a stored invitation', async () => {
    const client = { connect: vi.fn(), reconnect: vi.fn() }
    const openPairing = vi.fn()
    await connectStoredHost(client as never, { kind: 'unconfigured' }, store(new MemoryNativeStore()), openPairing)
    expect(openPairing).toHaveBeenCalledOnce()
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.reconnect).not.toHaveBeenCalled()
  })

  it('uses the durable Host-issued configuration only from an explicit connect action', async () => {
    const client = { connect: vi.fn(), reconnect: vi.fn() }
    await connectStoredHost(client as never, { kind: 'disconnected' }, await pairedStore(new MemoryNativeStore()), vi.fn())
    expect(client.connect).toHaveBeenCalledWith(config)
    expect(client.reconnect).not.toHaveBeenCalled()
  })

  it('retries a retired connection without replacing its Host-issued epoch', async () => {
    const client = { connect: vi.fn(), reconnect: vi.fn() }
    await connectStoredHost(client as never, { kind: 'error', message: 'relay closed' }, await pairedStore(new MemoryNativeStore()), vi.fn())
    expect(client.reconnect).toHaveBeenCalledOnce()
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('returns to physical pairing when the Host cannot confirm the next epoch', async () => {
    const client = { connect: vi.fn(), reconnect: vi.fn() }
    const openPairing = vi.fn()
    await connectStoredHost(client as never, { kind: 're-pair-required' }, await pairedStore(new MemoryNativeStore()), openPairing)
    expect(openPairing).toHaveBeenCalledOnce()
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.reconnect).not.toHaveBeenCalled()
  })

  it('does nothing while an existing connection is active or opening', async () => {
    const client = { connect: vi.fn(), reconnect: vi.fn() }
    const persisted = await pairedStore(new MemoryNativeStore())
    await connectStoredHost(client as never, { kind: 'connected', connectionEpoch: 1 }, persisted, vi.fn())
    await connectStoredHost(client as never, { kind: 'connecting' }, persisted, vi.fn())
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.reconnect).not.toHaveBeenCalled()
  })
})
