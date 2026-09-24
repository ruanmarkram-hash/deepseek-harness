/**
 * Legacy test-only model of a configured DSH Web service graph handoff.
 * Its version-2 capabilities and whole-file arrays remain separate from the
 * production streaming client and Swift journal; no production entrypoint
 * calls these helpers.
 *
 * The native carrier retains both the configured graph and its credentials.
 * TypeScript receives neither an ApiProxy nor a reusable activation token: it
 * can only ask native to start one fixed FD198 remote gateway lease.
 */
import type { QuiescedWebOwnerExportFile } from './offline-web-owner-handoff.ts'
import type {
  SealedHostDshServices,
  SealedHostOwnedRuntime,
} from './host-owned-dsh-runtime.ts'

/** Native-only conditions for reusing the existing configured DSH graph. */
export const NATIVE_OWNED_CONFIGURED_DSH_HANDOFF_REQUIREMENTS = Object.freeze({
  carrier: 'FD199',
  process: 'native-owned-configured-dsh-web-graph',
  desktopAndRemoteApi: 'same-in-process-apiproxy',
  modelCredentials: 'remain-with-configured-web-graph',
  requiredOrder: Object.freeze(['quiesce', 'export', 'release-store', 'native-attest-and-stage', 'native-activate-and-lease', 'start-fd198']),
  prohibited: Object.freeze(['process-control', 'registry-discovery', 'local-network-carrier', 'endpoint-discovery', 'model-secret-export', 'post-release-store-copy']),
} as const)

/**
 * The exact extra lifecycle operations a configured Web graph must expose.
 * It is intentionally narrower than Cordis or ApiProxy: no plugin loading,
 * filesystem path, credential, endpoint, or process handle is reachable.
 */
export interface ConfiguredDshWebOwner {
  /** Stops admission and waits for all active session/model work to settle. */
  quiesce(): Promise<void>
  /** Produces the complete immutable export while the graph still owns it. */
  exportStoppedState(): Promise<readonly QuiescedWebOwnerExportFile[]>
  /** Relinquishes every live persistence handle after the export is complete. */
  releaseStoreOwnership(): Promise<void>
}

/**
 * Native FD199 authority installed only in a native-owned configured Web
 * process. `prepareReleasedStoppedExport()` is one durable native
 * transaction: it resolves its single registered configured graph internally,
 * verifies bytes, invokes the release barrier, signs and stages the prepared
 * record under its private journal, and recovers an interrupted transition
 * itself. Node never supplies graph identity or observes proof material or a
 * journal path.
 */
export interface NativeFd199ConfiguredWebOwnerCapability {
  readonly kind: 'native-attested-fd199-configured-web-owner-v2'
  prepareReleasedStoppedExport(input: Readonly<{
    files: readonly QuiescedWebOwnerExportFile[]
    releaseStoreOwnership: () => Promise<void>
  }>): Promise<void>
}

/**
 * Opaque lease of the one fixed remote gateway. Native atomically verifies
 * the current FD199 activated record and CAS-acquires the configured graph's
 * exclusive runtime lease before creating this object. `stop()` first closes
 * FD198 work and revokes the lease, then allows ownership to be returned.
 */
interface NativeActivatedConfiguredDshGatewayLease {
  stop(): Promise<void>
}

/** The only Host-visible lifecycle after native starts the fixed gateway. */
export interface ActivatedConfiguredDshGatewayLease {
  stop(): Promise<void>
}

/**
 * Native Host capability. Its concrete implementation owns the configured
 * desktop ApiProxy and invokes the fixed RemoteGateway internally. The only
 * input is the fixed provider's durable device/route services; no API, model,
 * endpoint, token, or caller-supplied activation data crosses this boundary.
 */
export interface NativeActivatedConfiguredDshCapability {
  readonly kind: 'native-activated-configured-dsh-v2'
  startActivatedFixedRemoteGateway(services: Omit<SealedHostDshServices, 'apiProxy'>): Promise<NativeActivatedConfiguredDshGatewayLease>
}

/** Fail-closed error for a missing, stale, or incorrectly ordered handoff. */
export class NativeOwnedConfiguredDshHandoffError extends Error {
  constructor() {
    super('the native-owned configured DSH handoff is unavailable or invalid')
    this.name = 'NativeOwnedConfiguredDshHandoffError'
  }
}

/**
 * Executes the legacy model's Web-owner handoff. The supplied native transaction owns the
 * release/attest/stage boundary, so a crash cannot expose a released source
 * without durable native recovery state. Tests supply this capability;
 * the production dsh web launch uses the remote-host-fd199 package instead.
 */
export async function prepareConfiguredDshWebOwnerHandoff(
  owner: ConfiguredDshWebOwner,
  native: NativeFd199ConfiguredWebOwnerCapability,
): Promise<void> {
  try {
    if (native.kind !== 'native-attested-fd199-configured-web-owner-v2') throw new NativeOwnedConfiguredDshHandoffError()
    await owner.quiesce()
    const files = await owner.exportStoppedState()
    await native.prepareReleasedStoppedExport({
      files,
      releaseStoreOwnership: owner.releaseStoreOwnership,
    })
  } catch {
    throw new NativeOwnedConfiguredDshHandoffError()
  }
}

/**
 * Starts the fixed FD198 remote gateway after native has atomically verified
 * and consumed the current FD199 activation. The Host gets an opaque stop
 * lease only, never a configured DSH API object. This legacy helper has test
 * callers only and does not start the production hosted runtime.
 */
export async function startActivatedConfiguredDshHostRuntime(
  native: NativeActivatedConfiguredDshCapability,
  services: Omit<SealedHostDshServices, 'apiProxy'>,
): Promise<ActivatedConfiguredDshGatewayLease> {
  try {
    if (native.kind !== 'native-activated-configured-dsh-v2') throw new NativeOwnedConfiguredDshHandoffError()
    const lease = await native.startActivatedFixedRemoteGateway(services)
    if (lease === null || typeof lease !== 'object' || typeof lease.stop !== 'function') {
      throw new NativeOwnedConfiguredDshHandoffError()
    }
    return Object.freeze({ stop: async (): Promise<void> => { await lease.stop() } })
  } catch {
    throw new NativeOwnedConfiguredDshHandoffError()
  }
}

/** Compile-time evidence that a native lease is not a public runtime facade. */
export type _NativeConfiguredGatewayLeaseHasNoApi = Omit<ActivatedConfiguredDshGatewayLease, keyof SealedHostOwnedRuntime>
