/**
 * @deepseek-ai/dsh-remote-host-fd199 — hosted-runtime FD199 startup plugin.
 *
 * Mounted only by a signed-Host launcher overlay: the plugin adopts inherited
 * descriptors 198/199, proves the kernel-private authority handshake, recovers
 * the native ownership journal, provides the desktop write fence the API
 * gateway resolves lazily, and attaches the V3 relay only after the native
 * activation consume succeeds. An ordinary `dsh web` composition never mounts
 * this plugin and keeps its exact existing behavior.
 * @module @deepseek-ai/dsh-remote-host-fd199
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Duplex } from 'node:stream'
import { REMOTE_HOST_V3_PRIVATE_FD } from '@deepseek-ai/dsh-remote-host-v3'
import { Fd199ChannelClient } from './client.ts'
import { Fd199AuthorityError } from './error.ts'
import { CurrentWebFd199Lifecycle } from './lifecycle.ts'
import { adoptInheritedAuthoritySocket, validateInheritedDescriptors } from './fd.ts'
import type {
  Fd199AuthorityClient,
  Fd199AuthorityFacts,
  Fd199DesktopWriteFence,
  Fd199InstructionAction,
} from './types.ts'

export { Fd199AuthorityError } from './error.ts'
export { CurrentWebFd199Lifecycle, CurrentWebFd199LifecycleError } from './lifecycle.ts'
export { Fd199ChannelClient } from './client.ts'
export {
  HOSTED_RUNTIME_ARGUMENTS,
  REMOTE_HOST_FD199_AUTHORITY_FD,
  adoptInheritedAuthoritySocket,
  isHostedRuntimeInvocation,
  validateInheritedDescriptors,
} from './fd.ts'
export type {
  Fd199AuthorityClient,
  Fd199AuthorityFacts,
  Fd199DesktopWriteFence,
  Fd199ExportFile,
  Fd199InstructionAction,
  Fd199OwnershipSnapshot,
  Fd199SameStoreTransition,
  Fd199WebOwner,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'remote-host-fd199'

/** The enabled V3 route composition must exist before the handoff can attach its relay. */
export const inject = ['remoteHostV3']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Desktop dispatch fence; resolved lazily by the API gateway per operation. */
    fd199DesktopWriteFence?: Fd199DesktopWriteFence
    /** Established authority channel; the same-store transition face of the hosted handoff. */
    fd199AuthorityClient?: Fd199AuthorityClient
    /**
     * Configured Web-graph exporter/releaser for the same-store transition.
     * Mounted by the session-store owner; absent means prepare fails closed.
     */
    fd199WebOwner?: import('./types.ts').Fd199WebOwner
  }
}

/**
 * Mounts the hosted FD199 startup lifecycle. Failures are loud: a hosted
 * runtime that cannot prove its signed-Host handshake has no reason to serve.
 * @param ctx - Host context of the configured Web runtime child.
 * @returns the disposer releasing the authority channel and fence service.
 */
export async function apply(ctx: Context): Promise<() => void> {
  validateInheritedDescriptors()
  return startHostedHandoff(ctx, adoptInheritedAuthoritySocket())
}

/**
 * The full hosted handoff startup over one adopted authority channel.
 * Split from {@link apply} so tests can drive the exact lifecycle over a
 * scripted in-memory channel; production always passes descriptor 199.
 * @param ctx - Host context of the configured Web runtime child.
 * @param channel - Adopted kernel-private authority channel.
 * @returns the disposer releasing the authority channel and fence service.
 */
export async function startHostedHandoff(ctx: Context, channel: Duplex): Promise<() => void> {
  const client = new Fd199ChannelClient(channel)
  const fence = new CurrentWebFd199Lifecycle('released')
  ctx.provide('fd199DesktopWriteFence', fence)
  ctx.provide('fd199AuthorityClient', client)

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    void client.close()
  }
  ctx.effect(() => dispose, name)

  const facts = await client.connect()
  const snapshot = await client.recoverSnapshot()

  client.onInstruction((action) => {
    void runInstruction(ctx, fence, action, facts).catch((error: unknown) => {
      // A failed instruction leaves the store-ownership question ambiguous;
      // the only safe posture is closing the fence permanently and dropping
      // the authority channel so neither peer can half-own the graph.
      dispose()
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    })
  })

  if (snapshot.status === 'prepared' || snapshot.status === 'exported' || snapshot.status === 'releasing') {
    // The previous child released the store under native attestation and was
    // interrupted before activation. Stay fully fenced until the Host gate
    // completes the transition; desktop work cannot share writers meanwhile.
    return dispose
  }
  if (snapshot.status === 'none') {
    // Fresh hosted ownership with no interrupted journal: desktop work resumes
    // immediately; the relay stays unbound until a later activation consume.
    fence.admitHostedService()
    ctx.provide('fd199DesktopReady', { signal: () => client.desktopReady() })
  } else {
    // A prior process already consumed an activation for this generation:
    // rebind the relay without running the fence through another cycle. The
    // replacement still proves its full Web runtime to native after FD198
    // has been adopted, so a restart cannot present a stale ready state.
    resumeHostedService(ctx, fence, facts)
    ctx.provide('fd199DesktopReady', { signal: () => client.desktopReady() })
  }
  return dispose
}

/**
 * Executes one authority instruction against the live fence and Web owner.
 * @param ctx - Host context supplying the optional Web-owner adapter.
 * @param fence - The provided desktop write fence.
 * @param action - Instruction selected by the signed Host application.
 * @param facts - Proven handshake facts announcing the signed Host path.
 */
async function runInstruction(
  ctx: Context,
  fence: CurrentWebFd199Lifecycle,
  action: Fd199InstructionAction,
  facts: Fd199AuthorityFacts,
): Promise<void> {
  if (action === 'prepare') {
    const owner = ctx.get('fd199WebOwner')
    const client = ctx.get('fd199AuthorityClient')
    if (owner === undefined || client === undefined) throw new Fd199AuthorityError()
    await fence.releaseForNative(() => owner.exportStoppedState(), client)
    // `release-authorized` proves the Host durably staged the immutable
    // export and moved its journal to unactivatable `releasing`.  The actual
    // store-close proof is this awaited whole-root disposal.  The child sends
    // no later acknowledgement: native observes/reaps this PID and only then
    // promotes the journal to `prepared` and starts the adopter.
    const exit = ctx.get('appExit')
    if (exit === undefined) throw new Fd199AuthorityError()
    await exit(0)
    return
  }
  const client = ctx.get('fd199AuthorityClient')
  if (client === undefined) throw new Fd199AuthorityError()
  await client.activate()
  resumeHostedService(ctx, fence, facts)
}

/**
 * Binds the activated V3 relay composition and reopens desktop dispatch.
 * @param ctx - Host context carrying the enabled V3 route composition.
 * @param fence - Fence reopened after the activation consume succeeded.
 * @param facts - Proven authority facts announcing the signed Host path.
 */
function resumeHostedService(
  ctx: Context,
  fence: CurrentWebFd199Lifecycle,
  facts: Fd199AuthorityFacts,
): void {
  // Building the native provider reads descriptor 198, which is allowed only
  // on the hosted path after the authority proved itself and the journal
  // reached its activated generation.
  const native = ctx.remoteHostV3.createInheritedNativeProvider(REMOTE_HOST_V3_PRIVATE_FD, facts.hostAppPath, undefined, true)
  ctx.remoteHostV3.startWithNative(native)
  fence.admitHostedService()
}
