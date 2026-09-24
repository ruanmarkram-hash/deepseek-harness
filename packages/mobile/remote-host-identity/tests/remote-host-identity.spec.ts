import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, isRemoteHostIdentityError, RemoteHostIdentityError, RemoteEnrollmentController, RemoteHostIdentity, type ProtectedRemoteHostIdentityHandle } from '@deepseek-ai/dsh-remote-host-identity'
import type { RemoteDeviceDirectory, RemoteDeviceEnrollment } from '@deepseek-ai/dsh-remote-devices'
import { directoryFixture } from '../../remote-devices/tests/fixture.ts'

const handle: ProtectedRemoteHostIdentityHandle = {
  publicIdentity: () => ({ hostDeviceId: 'A'.repeat(32) as never, signingPublicKey: 'B'.repeat(43), agreementPublicKey: 'C'.repeat(43) }),
  sign: payload => new Uint8Array([...payload, 1]),
  deriveSharedSecret: () => new Uint8Array(32),
}
const enrollment: RemoteDeviceEnrollment = { id: 'remote_device_0001', label: 'Ruan’s iPhone', signingPublicKey: Buffer.alloc(32, 3).toString('base64url'), agreementPublicKey: Buffer.alloc(32, 4).toString('base64url') }

describe('RemoteHostIdentity', () => {
  it('rejects mounting without a signed provider and identifies only its own errors', async () => {
    await expect(apply(new Context())).rejects.toMatchObject({ code: 'REMOTE_HOST_IDENTITY_UNAVAILABLE' })
    expect(isRemoteHostIdentityError(new RemoteHostIdentityError('REMOTE_HOST_IDENTITY_INPUT_INVALID', 'safe'))).toBe(true)
    expect(isRemoteHostIdentityError(new Error('safe'))).toBe(false)
  })
  it('uses only protected-handle operations and returns public copies', () => {
    const identity = RemoteHostIdentity.fromProtectedHandle(handle)
    expect(identity.publicIdentity()).toEqual(handle.publicIdentity())
    expect(identity.sign(new Uint8Array([7]))).toEqual(new Uint8Array([7, 1]))
    expect(identity.deriveSharedSecret('C'.repeat(43))).toHaveLength(32)
  })
})

describe('RemoteEnrollmentController', () => {
  it('uses default entropy and time and evicts the oldest abandoned invitation at capacity', async () => {
    const controller = new RemoteEnrollmentController(RemoteHostIdentity.fromProtectedHandle(handle), directoryFixture({}))
    const first = await controller.issueRoute()
    let newest = first
    for (let index = 0; index < 32; index += 1) newest = await controller.issueRoute()
    expect(newest.invitation.routeId).not.toBe(first.invitation.routeId)
    await expect(controller.confirm({ route: first.invitation, device: enrollment })).rejects.toMatchObject({ code: 'REMOTE_HOST_IDENTITY_INPUT_INVALID' })
    await expect(controller.confirm({ route: newest.invitation, device: enrollment })).resolves.toMatchObject({ id: enrollment.id })
    await expect(controller.confirm({ route: newest.invitation, device: enrollment })).rejects.toMatchObject({ code: 'REMOTE_HOST_IDENTITY_INPUT_INVALID' })
  })

  it('rejects modified invitation facts without consuming the original', async () => {
    const controller = new RemoteEnrollmentController(RemoteHostIdentity.fromProtectedHandle(handle), directoryFixture({}))
    const { invitation } = await controller.issueRoute()
    for (const route of [
      { ...invitation, clientAuthToken: 'changed' },
      { ...invitation, expiresAt: 'changed' },
      { ...invitation, host: { ...invitation.host, signingPublicKey: 'changed' } },
      { ...invitation, host: { ...invitation.host, agreementPublicKey: 'changed' } },
    ]) await expect(controller.confirm({ route, device: enrollment })).rejects.toMatchObject({ code: 'REMOTE_HOST_IDENTITY_INPUT_INVALID' })
    await expect(controller.confirm({ route: invitation, device: enrollment })).resolves.toMatchObject({ id: enrollment.id })
  })
  it('expires, splits host credentials, and snapshots confirmed devices', async () => {
    const enroll = vi.fn<RemoteDeviceDirectory['enroll']>(async input => ({ ...input, id: input.id as never, incarnation: 'F'.repeat(32) as never, enrolledAt: '2026-08-20T00:00:00.000Z' }))
    let now = new Date('2026-08-20T00:00:00.000Z')
    const controller = new RemoteEnrollmentController(
      RemoteHostIdentity.fromProtectedHandle(handle), directoryFixture({ enroll }),
      () => new Uint8Array(24), () => now,
    )
    const route = await controller.issueRoute()
    expect(route.hostAuthToken).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(route.invitation).not.toHaveProperty('hostAuthToken')
    const mutable = { ...enrollment }
    await controller.confirm({ route: route.invitation, device: mutable })
    mutable.label = 'changed'
    expect(enroll.mock.calls[0]?.[0]).toMatchObject({ label: 'Ruan’s iPhone' })
    const expired = await controller.issueRoute()
    now = new Date('2026-08-20T00:05:00.000Z')
    await expect(controller.confirm({ route: expired.invitation, device: enrollment })).rejects.toMatchObject({ code: 'REMOTE_HOST_IDENTITY_INPUT_INVALID' })
  })
})
