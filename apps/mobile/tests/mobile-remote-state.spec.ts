import { describe, expect, it } from 'vitest'
import type { ImportedMobileEnrollment } from '../enrollment'
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

const invitation: ImportedMobileEnrollment = {
  config,
  expiresAt: '2026-09-01T00:00:00.000Z',
  identityProvider: {
    clearUserPresence: () => undefined,
    deviceIdentity: async () => { throw new Error('The state store must not read the mobile identity') },
    requireUserPresence: async () => undefined,
  },
}

class MemoryNativeStore implements DshMobileRemoteStateNativeModule {
  clearCalls = 0
  record: string | null = null

  async clearRemoteState(): Promise<void> {
    this.clearCalls += 1
    this.record = null
  }

  async loadRemoteState(): Promise<string | null> {
    return this.record
  }

  async saveRemoteState(record: string): Promise<void> {
    this.record = record
  }
}

function event(cursor: number) {
  return {
    version: 3 as const,
    type: 'event' as const,
    connectionEpoch: 1,
    cursor,
    eventId: 'event_identifier_123456789' as never,
    requestId: 'request_identifier_123456' as never,
    event: 'host/session-added' as const,
    payload: { sessionId: 'session_identifier_123456' },
  }
}

describe('NativeMobileRemoteStateStore', () => {
  it('persists only the invitation epoch and advances it only after an authenticated receipt', async () => {
    const native = new MemoryNativeStore()
    const state = new NativeMobileRemoteStateStore(native)
    await state.saveInvitation(invitation)

    await expect(state.nextConnectionEpoch(config, 1, new AbortController().signal)).resolves.toBe(1)
    await expect(state.nextConnectionEpoch(config, 2, new AbortController().signal)).rejects.toThrow('fresh Host invitation')
    await state.recordAuthenticatedConnection(config, 1, new AbortController().signal)

    const restored = await new NativeMobileRemoteStateStore(native).restore()
    expect(restored).toMatchObject({ config: { connectionEpoch: 2 }, eventCursor: 0, nextConnectionEpoch: 2 })
    await expect(new NativeMobileRemoteStateStore(native).nextConnectionEpoch({ ...config, connectionEpoch: 2 }, 2, new AbortController().signal)).resolves.toBe(2)
  })

  it('serializes a durable event cursor with a receipt-confirmed epoch advance', async () => {
    const native = new MemoryNativeStore()
    const state = new NativeMobileRemoteStateStore(native)
    await state.saveInvitation(invitation)

    await Promise.all([
      state.apply(event(1)),
      state.recordAuthenticatedConnection(config, 1, new AbortController().signal),
    ])

    expect(await new NativeMobileRemoteStateStore(native).restore()).toMatchObject({ eventCursor: 1, nextConnectionEpoch: 2 })
  })

  it('does not acknowledge a skipped event cursor', async () => {
    const native = new MemoryNativeStore()
    const state = new NativeMobileRemoteStateStore(native)
    await state.saveInvitation(invitation)

    await expect(state.apply(event(2))).rejects.toThrow('not contiguous')
    expect(await state.read()).toBe(0)
  })

  it('resets a durable cursor when restarting without a rendered projection', async () => {
    const native = new MemoryNativeStore()
    const firstProcess = new NativeMobileRemoteStateStore(native)
    await firstProcess.saveInvitation(invitation)
    await firstProcess.apply(event(1))

    const secondProcess = new NativeMobileRemoteStateStore(native)
    await expect(secondProcess.resetCursorForFreshProjection()).resolves.toMatchObject({ eventCursor: 0 })
    expect(await new NativeMobileRemoteStateStore(native).read()).toBe(0)
  })

  it('replaces the durable cursor when a restarted Host returns a snapshot baseline', async () => {
    const native = new MemoryNativeStore()
    const state = new NativeMobileRemoteStateStore(native)
    await state.saveInvitation(invitation)
    await state.apply(event(1))
    await state.replace(0)
    expect(await new NativeMobileRemoteStateStore(native).read()).toBe(0)
  })

  it('erases malformed native records but retains an enrolled route after transfer expiry', async () => {
    const malformed = new MemoryNativeStore()
    malformed.record = '{"not":"a DSH state"}'
    await expect(new NativeMobileRemoteStateStore(malformed).restore()).resolves.toBeUndefined()
    expect(malformed.clearCalls).toBe(1)

    const expired = new MemoryNativeStore()
    expired.record = JSON.stringify({
      version: 1,
      config,
      eventCursor: 0,
      expiresAt: '2020-01-01T00:00:00.000Z',
      nextConnectionEpoch: 1,
    })
    await expect(new NativeMobileRemoteStateStore(expired).restore()).resolves.toMatchObject({
      config: { routeId: config.routeId },
      expiresAt: '2020-01-01T00:00:00.000Z',
    })
    expect(expired.clearCalls).toBe(0)
  })
})
