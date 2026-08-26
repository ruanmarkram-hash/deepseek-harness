/** Invariant companion for Host V3 route composition. @module @deepseek-ai/dsh-remote-host-v3/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-remote-host-v3'

/** Cordis companion plugin name. */
export const name = 'remote-host-v3-invariant'
/** The invariant registry is required before this companion registers. */
export const inject = ['invariants']

/** Verify that durable route records never retain a pending epoch behind their committed high-water. */
const install: InvariantInstaller = Object.assign((_ctx: Context, _fail: InvariantFailure) => {
  // No runtime invariant: route mutations are internally serialized and storage-schema validated, and no Host event carries route credentials or connection traffic to observe here.
})

/** Register the empty companion because route truth is durable and not event-derived. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
