/** Invariant companion for the hosted FD199 startup plugin. @module @deepseek-ai/dsh-remote-host-fd199/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-remote-host-fd199'

/** Cordis companion plugin name. */
export const name = 'remote-host-fd199-invariant'
/** The invariant registry is required before this companion registers. */
export const inject = ['invariants']

/**
 * Verify that the desktop write fence service stays present exactly while the
 * hosted startup plugin owns the transition lifecycle.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  // The plugin provides the fence before any effect can dispose it and never
  // removes the service key on dispose; the fence object itself rejects every
  // operation once closed. A missing service key with a live hosted plugin
  // would silently unfence desktop dispatch, so the presence relation is the
  // checkable invariant.
  if (ctx.get('fd199DesktopWriteFence') === undefined) {
    fail('the hosted FD199 startup plugin is mounted without its desktop write fence service')
  }
}, { inject: ['fd199DesktopWriteFence'] })

/** Register the fence-service presence check. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
