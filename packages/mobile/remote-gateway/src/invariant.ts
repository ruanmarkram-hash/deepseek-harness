/** Package-owned invariant companion for Host remote-gateway audit records. @module @deepseek-ai/dsh-remote-gateway/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { RemoteGatewayAuditEntry } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-remote-gateway'

/** Cordis companion plugin name. */
export const name = 'remote-gateway-invariant'
/** The invariant registry must be available before this companion registers. */
export const inject = ['invariants']

/** Check that a completed remote operation still names a currently trusted device. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('remote-gateway/audit', (entry: RemoteGatewayAuditEntry) => {
    if (entry.outcome === 'completed' && ctx.remoteDevices.get(entry.deviceId) === undefined) {
      fail(`completed remote gateway operation names revoked device '${entry.deviceId}'`)
    }
  })
}, { inject: ['remoteDevices'] })

/** Register remote gateway provenance checks. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
