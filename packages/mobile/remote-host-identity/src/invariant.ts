/** Package-owned invariant companion for Keychain-backed Host identity. @module @deepseek-ai/dsh-remote-host-identity/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-remote-host-identity'

/** Cordis companion plugin name. */
export const name = 'remote-host-identity-invariant'
/** The invariant registry must be available before this companion registers. */
export const inject = ['invariants']

/** No runtime invariant: the private Keychain item is intentionally unreadable outside the identity service. */
const install: InvariantInstaller = () => {}

/** Register this package's ownership reservation. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
