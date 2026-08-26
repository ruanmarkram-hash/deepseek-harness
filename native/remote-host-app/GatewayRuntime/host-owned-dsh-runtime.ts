/**
 * Static in-process composition point for the signed Host's DSH remote
 * runtime. FD198 is consumed only by the existing inherited Remote Wire
 * provider; all DSH operations remain in the same process through ApiProxy.
 */
import { RemoteGateway, type RemoteGatewayAuditEntry } from '../../../packages/mobile/remote-gateway/src/index.ts'
import { createRemoteHostV3InheritedWireProvider } from '../../../packages/mobile/remote-host-v3/src/remote-wire.ts'
import type { RemoteHostV3RuntimePipe } from '../../../packages/mobile/remote-host-v3/src/types.ts'
import type { ApiProxy } from '../../../packages/host/apiproxy/src/api/index.ts'
import type { RemoteDeviceDirectory } from '../../../packages/mobile/remote-devices/src/types.ts'
import type { RemoteWireId } from '../../../packages/mobile/remote-wire/src/types.ts'

type RemoteHostV3RouteAllocator = Parameters<typeof createRemoteHostV3InheritedWireProvider>[0]

/** The only permitted in-process remote dispatch memory limits. */
export const SEALED_REMOTE_GATEWAY_LIMITS = Object.freeze({
  maxIdempotencyEntriesPerDevice: 2_048,
  maxEventEntriesPerDevice: 4_096,
})

/** Fixed properties of the host-owned DSH process. No Web runtime is consulted. */
export const SEALED_HOST_DSH_OWNERSHIP = Object.freeze({
  persistence: 'signed-host-runtime-only',
  configuration: 'statically-composed-only',
  userPatchLayers: false,
  environmentConfiguration: false,
  localhostCarrier: false,
} as const)

/** The minimal DSH services that must have been statically composed before FD198 can be read. */
export interface SealedHostDshServices {
  /** The real composed DSH API implementation, never an HTTP client or proxy. */
  readonly apiProxy: ApiProxy
  /** The durable, Host-owned trusted-device directory. */
  readonly remoteDevices: RemoteDeviceDirectory
  /** The durable route and exact epoch allocator. */
  readonly routeAllocator: RemoteHostV3RouteAllocator
  /** Deterministic Host clock. */
  readonly now: () => string
  /** Cryptographically opaque remote-wire identifier factory. */
  readonly newId: () => RemoteWireId
  /** Host-local audit sink that never receives remote request payloads. */
  readonly audit: (entry: RemoteGatewayAuditEntry) => void
}

/** Live in-process DSH runtime, owned by the signed Host child lifecycle. */
export interface SealedHostOwnedRuntime {
  /** The generic DSH gateway serving authenticated Remote Wire connections. */
  readonly gateway: RemoteGateway
  /** Stops acceptance and closes all active authenticated connections. */
  stop(): Promise<void>
}

/**
 * Starts the only allowed Host remote path: an already-authenticated FD198
 * provider directly into the composed DSH ApiProxy gateway. It has no HTTP,
 * WebSocket, endpoint discovery, token, or second carrier.
 * @param services - Fully initialized statically composed DSH services.
 * @returns the lifecycle owner for the in-process provider and gateway.
 */
export function startSealedHostOwnedRuntime(services: SealedHostDshServices): SealedHostOwnedRuntime {
  const runtimePipe = createRemoteHostV3InheritedWireProvider(services.routeAllocator, services.remoteDevices)
  return startWithInheritedPipe(services, runtimePipe)
}

/** Test-only seam for exercising the unchanged provider/gateway composition over an in-memory inherited pipe. */
export const internals = { startWithInheritedPipe }

function startWithInheritedPipe(services: SealedHostDshServices, runtimePipe: RemoteHostV3RuntimePipe): SealedHostOwnedRuntime {
  const gateway = new RemoteGateway({
    api: services.apiProxy,
    devices: services.remoteDevices,
    now: services.now,
    newId: services.newId,
    audit: services.audit,
  }, SEALED_REMOTE_GATEWAY_LIMITS)
  const abort = new AbortController()
  void gateway.serve(runtimePipe, abort.signal).catch(() => {
    abort.abort()
    void gateway.dispose()
  })
  return {
    gateway,
    async stop(): Promise<void> {
      abort.abort()
      await gateway.dispose()
    },
  }
}
