/** Package-owned invariant companion for trusted remote device records. @module @deepseek-ai/dsh-remote-devices/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { RemoteDeviceChange } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-remote-devices'

/** Cordis companion plugin name. */
export const name = 'remote-devices-invariant'
/** The invariant registry must be available before this companion registers. */
export const inject = ['invariants']

/** Check that every post-durability event agrees with current directory state. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const checkChange = (change: RemoteDeviceChange): true => {
    switch (change.type) {
      case 'enrolled':
      case 'seen': {
        const current = ctx.remoteDevices.get(change.device.id)
        if (current === undefined || JSON.stringify(current) !== JSON.stringify(change.device)) {
          fail(`remote device '${change.device.id}' change disagrees with durable directory state`)
        }
        return true
      }
      case 'revoked':
        if (ctx.remoteDevices.get(change.deviceId) !== undefined) {
          fail(`revoked remote device '${change.deviceId}' remains in the durable directory`)
        }
        return true
    }
  }
  ctx.on('remote-devices/changed', (change: RemoteDeviceChange) => {
    checkChange(change)
  })
}, { inject: ['remoteDevices'] })

/** Register the device event and directory-state agreement check. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
