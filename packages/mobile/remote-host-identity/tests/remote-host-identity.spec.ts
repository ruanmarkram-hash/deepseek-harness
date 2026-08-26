import { describe, expect, it, vi } from 'vitest'
import { RemoteEnrollmentController, RemoteHostIdentity, type ProtectedRemoteHostIdentityHandle } from '@deepseek-ai/dsh-remote-host-identity'
import type { RemoteDeviceDirectory, RemoteDeviceEnrollment } from '@deepseek-ai/dsh-remote-devices'

const handle: ProtectedRemoteHostIdentityHandle = {
  publicIdentity: () => ({ hostDeviceId: 'A'.repeat(32) as never, signingPublicKey: 'B'.repeat(43), agreementPublicKey: 'C'.repeat(43) }),
  sign: payload => new Uint8Array([...payload, 1]),
  deriveSharedSecret: () => new Uint8Array(32),
}
const enrollment: RemoteDeviceEnrollment = { id: 'remote_device_0001', label: 'Ruan’s iPhone', signingPublicKey: 'D'.repeat(43), agreementPublicKey: 'E'.repeat(43) }

describe('RemoteHostIdentity', () => {
  it('uses only protected-handle operations and returns public copies', () => {
    const identity = RemoteHostIdentity.fromProtectedHandle(handle)
    expect(identity.publicIdentity()).toEqual(handle.publicIdentity())
    expect(identity.sign(new Uint8Array([7]))).toEqual(new Uint8Array([7, 1]))
    expect(identity.deriveSharedSecret('C'.repeat(43))).toHaveLength(32)
  })
})

describe('RemoteEnrollmentController', () => {
  it('expires, splits host credentials, and snapshots confirmed devices', async () => {
    const enroll = vi.fn<RemoteDeviceDirectory['enroll']>(async input => ({ ...input, id: input.id as never, incarnation: 'F'.repeat(32) as never, enrolledAt: '2026-08-20T00:00:00.000Z' }))
    let now = new Date('2026-08-20T00:00:00.000Z')
    const controller = new RemoteEnrollmentController(
      RemoteHostIdentity.fromProtectedHandle(handle), { enroll } as unknown as RemoteDeviceDirectory,
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
