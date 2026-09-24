/** Package-owned invariant companion for remote relay transport values. @module @deepseek-ai/dsh-remote-relay-protocol/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-remote-relay-protocol'

/** Cordis companion plugin name. */
export const name = 'remote-relay-protocol-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: a transport-neutral parser and cipher exposes no Cordis event or mutable service relation. */
const install: InvariantInstaller = () => {}

/** @param ctx - Cordis context carrying the invariant registry. @returns installed registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
