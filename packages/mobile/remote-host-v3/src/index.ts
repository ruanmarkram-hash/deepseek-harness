/** Host-owned V3 route allocation and encrypted-relay composition. @module @deepseek-ai/dsh-remote-host-v3 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { RemoteDeviceId } from '@deepseek-ai/dsh-remote-devices'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { RemoteHostV3Error } from './error.ts'
import type {
  RemoteDeviceDirectory,
} from '@deepseek-ai/dsh-remote-devices'
import type {
  RemoteHostV3ControllerApi,
  RemoteHostV3NativeProvider,
  RemoteHostV3Route,
  RemoteHostV3RuntimePipe,
} from './types.ts'
import { createRemoteHostV3InheritedWireProvider, REMOTE_HOST_V3_PRIVATE_FD } from './remote-wire.ts'

export { RemoteHostV3Error, isRemoteHostV3Error } from './error.ts'
export { createLoopbackApiProxy } from './loopback-api-proxy.ts'
export type {
  RemoteHostV3ControllerApi,
  RemoteHostV3EnrollmentReceipt,
  RemoteHostV3NativeProvider,
  RemoteHostV3Route,
  RemoteHostV3RuntimePipe,
} from './types.ts'
export {
  REMOTE_HOST_V3_PRIVATE_FD,
  REMOTE_HOST_V3_WIRE_MAX_CONNECTION_QUEUE_BYTES,
  REMOTE_HOST_V3_WIRE_MAX_CONNECTION_QUEUE_ITEMS,
  REMOTE_HOST_V3_WIRE_MAX_CONNECTIONS,
  REMOTE_HOST_V3_WIRE_MAX_CLOSING_TOMBSTONES,
  REMOTE_HOST_V3_WIRE_MAX_INGRESS_BYTES,
  REMOTE_HOST_V3_WIRE_MAX_INGRESS_ITEMS,
  REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_BYTES,
  REMOTE_HOST_V3_WIRE_MAX_OUTBOUND_ITEMS,
  REMOTE_HOST_V3_WIRE_MAX_RECORDS_PER_INGRESS_CHUNK,
  REMOTE_HOST_V3_WIRE_MAX_METADATA_BYTES,
  REMOTE_HOST_V3_WIRE_MAX_RECORD_BYTES,
  RemoteHostV3InheritedWireProvider,
  createRemoteHostV3InheritedWireProvider,
} from './remote-wire.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const storedRouteSchema = zod.object({
  routeId: zod.string().regex(ID),
  deviceId: zod.string().regex(ID),
  deviceEnrollmentId: zod.string().regex(ID),
  hostDeviceId: zod.string().regex(ID),
  hostEnrollmentId: zod.string().regex(ID),
  generation: zod.number().int().min(1).max(2_147_483_647),
  lastConnectionEpoch: zod.number().int().min(0).max(2_147_483_647),
  pendingConnectionEpoch: zod.number().int().min(1).max(2_147_483_647).optional(),
  createdAt: zod.string(),
}).strict()

const storedHostSchema = zod.object({ hostEnrollmentId: zod.string().regex(ID) }).strict()

type StoredRoute = zod.infer<typeof storedRouteSchema>

/** Durable public route coordinates. Route credentials remain in the signed helper. */
export const REMOTE_HOST_V3_DOMAIN = defineDomain({
  name: 'remote_host_v3',
  version: 1,
  tables: {
    host: domainTable<string, zod.infer<typeof storedHostSchema>>(storedHostSchema),
    routes: domainTable<RemoteDeviceId, StoredRoute>(storedRouteSchema),
  },
})

/** Cordis plugin name. */
export const name = 'remote-host-v3'
/** Generic Host dispatch is required; device-directory checks happen inside the gateway. */
export const inject = ['storageDomain', 'remoteDevices', 'remoteGateway']

/** Deployment-selected Host V3 composition values. */
export interface Config {
  /** Starts the inherited-pipe gateway handoff only for a signed Host-app-owned runtime child. */
  enabled: boolean
  /** Absolute executable path the signed Host app must attest before its inherited pipe is accepted. */
  hostAppPath: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  hostAppPath: z.string().default(''),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Signed Host-app handoff; an ordinary unsigned Web Host deliberately provides none. */
    remoteHostV3Native?: RemoteHostV3NativeProvider
    /** Local Host route manager; it exposes no listener or browser endpoint. */
    remoteHostV3: RemoteHostV3Controller
  }
}

/** @param value - Candidate date text. @returns whether it is a canonical millisecond ISO instant. */
function canonicalInstant(value: string): boolean {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

/** @param record - Stored route. @returns immutable public route copy. */
function copyRoute(record: StoredRoute): RemoteHostV3Route {
  return { ...record } as RemoteHostV3Route
}

/** @param value - Candidate helper path. @returns whether it is an absolute non-empty path. */
function absolutePath(value: string): boolean {
  return value.startsWith('/') && value.length > 1 && !value.includes('\u0000')
}

/** Process-local serial executor for durable route mutations. */
class RouteWrites {
  private tail: Promise<void> = Promise.resolve()

  /** @param operation - Exclusive durable route mutation. @returns the mutation result. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }
}

/** Allocates durable Host route facts and exact reconnect epochs without persisting credentials. */
export class RemoteHostV3RouteAllocator {
  private readonly writes = new RouteWrites()

  /**
   * @param routes - Durable public route table.
   * @param host - Durable Host identity-incarnation table.
   * @param now - Host-local clock.
   * @param newId - Cryptographic opaque id factory.
   */
  constructor(
    private readonly routes: KvTable<RemoteDeviceId, StoredRoute>,
    private readonly host: KvTable<string, zod.infer<typeof storedHostSchema>>,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => randomUUID(),
  ) {}

  /**
   * Reads or creates the durable Host identity incarnation.
   * @returns stable Host identity incarnation, creating it inside the durable Host profile exactly once.
   */
  async hostEnrollmentId(): Promise<string> {
    return this.writes.run(async () => {
      const existing = this.host.get('identity')
      if (existing !== undefined) return existing.hostEnrollmentId
      const hostEnrollmentId = this.newId()
      if (!ID.test(hostEnrollmentId)) throw new RemoteHostV3Error('REMOTE_HOST_V3_ROUTE_INVALID', 'Host identity incarnation is invalid')
      await this.host.put('identity', { hostEnrollmentId })
      return hostEnrollmentId
    })
  }

  /**
   * Stores the exact public Host enrollment incarnation already confirmed by
   * the native Host. A different value cannot replace an existing identity.
   * @param hostEnrollmentId - Confirmed opaque Host enrollment incarnation.
   * @returns that stable durable incarnation.
   */
  async seedHostEnrollmentId(hostEnrollmentId: string): Promise<string> {
    return this.writes.run(async () => {
      if (!ID.test(hostEnrollmentId)) throw new RemoteHostV3Error('REMOTE_HOST_V3_ROUTE_INVALID', 'Host identity incarnation is invalid')
      const existing = this.host.get('identity')
      if (existing !== undefined) {
        if (existing.hostEnrollmentId !== hostEnrollmentId) {
          throw new RemoteHostV3Error('REMOTE_HOST_V3_ROUTE_INVALID', 'Host identity incarnation conflicts with durable identity')
        }
        return existing.hostEnrollmentId
      }
      await this.host.put('identity', { hostEnrollmentId })
      return hostEnrollmentId
    })
  }

  /**
   * Lists stable public route copies in device-id order.
   * @returns stable public route copies in device-id order.
   */
  list(): readonly RemoteHostV3Route[] {
    return [...this.routes.entries()]
      .map(([, route]) => copyRoute(route))
      .sort((left, right) => String(left.deviceId).localeCompare(String(right.deviceId)))
  }

  /**
   * Looks up the current public route for a trusted device.
   * @param deviceId - Trusted device.
   * @returns its public route, if one exists.
   */
  get(deviceId: RemoteDeviceId): RemoteHostV3Route | undefined {
    const route = this.routes.get(deviceId)
    return route === undefined ? undefined : copyRoute(route)
  }

  /**
   * Creates a durable public route for a newly provisioned native relay route.
   * @param input - Public facts for the new route.
   * @returns the durable route.
   */
  async create(input: Omit<RemoteHostV3Route, 'generation' | 'lastConnectionEpoch' | 'pendingConnectionEpoch' | 'createdAt'> & { readonly generation: number }): Promise<RemoteHostV3Route> {
    const hostEnrollmentId = await this.hostEnrollmentId()
    if (input.hostEnrollmentId !== hostEnrollmentId) {
      throw new RemoteHostV3Error('REMOTE_HOST_V3_ROUTE_INVALID', 'Remote route does not use the authoritative Host identity incarnation')
    }
    return this.writes.run(async () => {
      if (this.routes.get(input.deviceId) !== undefined) throw new RemoteHostV3Error('REMOTE_HOST_V3_ROUTE_EXISTS', 'A remote route already exists for this device')
      const createdAt = this.now()
      const candidate: StoredRoute = { ...input, lastConnectionEpoch: 0, createdAt }
      const parsed = storedRouteSchema.safeParse(candidate)
      if (!parsed.success || !canonicalInstant(createdAt)) throw new RemoteHostV3Error('REMOTE_HOST_V3_ROUTE_INVALID', 'Remote route facts are invalid')
      await this.routes.put(input.deviceId, parsed.data)
      return copyRoute(parsed.data)
    })
  }

  /**
   * Begins or resumes allocation of the route's exact next connection epoch.
   * @param deviceId - Route owner.
   * @returns a durable exact next epoch; retries keep the existing pending epoch.
   */
  async beginConnection(deviceId: RemoteDeviceId): Promise<RemoteHostV3Route> {
    return this.writes.run(async () => {
      const current = this.routes.get(deviceId)
      if (current === undefined) throw new RemoteHostV3Error('REMOTE_HOST_V3_ROUTE_UNAVAILABLE', 'Remote route is unavailable')
      if (current.pendingConnectionEpoch !== undefined) return copyRoute(current)
      const pendingConnectionEpoch = current.lastConnectionEpoch + 1
      if (pendingConnectionEpoch > 2_147_483_647) throw new RemoteHostV3Error('REMOTE_HOST_V3_EPOCH_INVALID', 'Remote route epoch is exhausted')
      const next = await this.routes.update(deviceId, value => ({ ...value, pendingConnectionEpoch }))
      return copyRoute(next)
    })
  }

  /**
   * Commits the exact connection epoch completed by both peers.
   * @param deviceId - Route owner.
   * @param epoch - Mutually-completed exact epoch.
   * @returns committed public route.
   */
  async commitConnection(deviceId: RemoteDeviceId, epoch: number): Promise<RemoteHostV3Route> {
    return this.writes.run(async () => {
      const current = this.routes.get(deviceId)
      if (current === undefined || current.pendingConnectionEpoch !== epoch) {
        throw new RemoteHostV3Error('REMOTE_HOST_V3_EPOCH_INVALID', 'Remote route epoch cannot be committed')
      }
      const next = await this.routes.update(deviceId, (value) => {
        const { pendingConnectionEpoch: _pendingConnectionEpoch, ...committed } = value
        return { ...committed, lastConnectionEpoch: epoch }
      })
      return copyRoute(next)
    })
  }

  /**
   * Removes a device's durable public route.
   * @param deviceId - Route owner.
   * @returns the removed public route, or `undefined` when no route existed.
   */
  async remove(deviceId: RemoteDeviceId): Promise<RemoteHostV3Route | undefined> {
    return this.writes.run(async () => {
      const current = this.routes.get(deviceId)
      if (current === undefined) return undefined
      await this.routes.delete(deviceId)
      return copyRoute(current)
    })
  }
}

/** Host-local V3 coordinator. It creates no HTTP listener, performs no cryptography, and owns no route credential. */
export class RemoteHostV3Controller implements RemoteHostV3ControllerApi {
  private readonly abort = new AbortController()
  private stopped = false
  private serving = false

  /**
   * @param ctx - Host context.
   * @param allocator - Durable public route allocator.
   * @param devices - Durable trusted-device directory feeding the inherited pipe.
   * @param native - Signed Host-app handoff, if enabled at mount.
   * @param config - Validated deployment config.
   */
  constructor(
    private readonly ctx: Context,
    private readonly allocator: RemoteHostV3RouteAllocator,
    private readonly devices: RemoteDeviceDirectory,
    private readonly native: RemoteHostV3NativeProvider | undefined,
    private readonly config: Config,
  ) {}

  /**
   * Lists the allocator's durable public routes without credentials or ciphertext.
   * @returns durable public routes without route tokens, private keys, or ciphertext.
   */
  listRoutes(): readonly RemoteHostV3Route[] { return this.allocator.list() }

  /** Begin the generic gateway's receive loop over the signed Host app's inherited private pipe. */
  start(): void {
    if (!this.config.enabled) return
    // An empty hostAppPath is the hosted launcher's exclusive marker: the
    // FD199 startup plugin owns the deferred attach after its authority
    // handshake. Any other enabled deployment without a mounted provider
    // still fails closed here.
    if (this.native === undefined && !absolutePath(this.config.hostAppPath)) return
    this.serve(this.requireNative())
  }

  /**
   * Begins serving over a natively activated handoff that arrived after mount,
   * exactly once. The hosted FD199 startup plugin calls this only after its
   * authority handshake and journal consume succeeded.
   * @param native - Activated signed Host-app handoff for this child process.
   */
  startWithNative(native: RemoteHostV3NativeProvider): void {
    if (!this.config.enabled) throw new RemoteHostV3Error('REMOTE_HOST_V3_DISABLED', 'Remote Host V3 is disabled')
    if (this.stopped || this.serving) throw new RemoteHostV3Error('REMOTE_HOST_V3_HELPER_UNAVAILABLE', 'Remote Host V3 is not accepting a deferred handoff')
    if (!absolutePath(native.hostAppPath)) {
      throw new RemoteHostV3Error('REMOTE_HOST_V3_HELPER_MISMATCH', 'The activated Host-app handoff path is invalid')
    }
    if (native.runtimePipe.kind !== 'inherited-private-pipe') {
      throw new RemoteHostV3Error('REMOTE_HOST_V3_HELPER_MISMATCH', 'The activated Host-app handoff pipe is invalid')
    }
    this.serve(native)
  }

  /**
   * Builds the inherited-pipe native provider over this deployment's durable
   * route allocator and device directory. Descriptor 198 stays unread until a
   * caller actually serves the returned pipe.
   * @param descriptor - Inherited relay descriptor; only the fixed value is accepted.
   * @param hostAppPath - Absolute path announced by the proven FD199 authority.
   * @param inheritedPipe - Test-only prebuilt pipe; production always adopts descriptor 198.
   * @param requireEnrollmentSeed - Whether runtime readiness requires the native Host enrollment seed first.
   * @returns the native provider for {@link startWithNative}.
   */
  createInheritedNativeProvider(
    descriptor: number,
    hostAppPath: string,
    inheritedPipe?: RemoteHostV3RuntimePipe,
    requireEnrollmentSeed: boolean = false,
  ): RemoteHostV3NativeProvider {
    if (!this.config.enabled) throw new RemoteHostV3Error('REMOTE_HOST_V3_DISABLED', 'Remote Host V3 is disabled')
    if (descriptor !== REMOTE_HOST_V3_PRIVATE_FD || !absolutePath(hostAppPath)) {
      throw new RemoteHostV3Error('REMOTE_HOST_V3_HELPER_MISMATCH', 'The inherited handoff facts are invalid')
    }
    return {
      hostAppPath,
      runtimePipe: inheritedPipe ?? createRemoteHostV3InheritedWireProvider(this.allocator, this.devices, requireEnrollmentSeed),
    }
  }

  /** Stop links, provider delivery, and future route activity. */
  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    this.abort.abort()
  }

  /** Serves the gateway once over one pipe; concurrent or repeat serves are closed errors. */
  private serve(native: RemoteHostV3NativeProvider): void {
    if (this.serving) throw new RemoteHostV3Error('REMOTE_HOST_V3_HELPER_MISMATCH', 'Remote Host V3 already serves an inherited pipe')
    this.serving = true
    // The receive loop lives for the process lifetime; disposal aborts it.
    void this.ctx.remoteGateway.serve(native.runtimePipe, this.abort.signal)
  }

  private requireNative(): RemoteHostV3NativeProvider {
    if (!this.config.enabled) throw new RemoteHostV3Error('REMOTE_HOST_V3_DISABLED', 'Remote Host V3 is disabled')
    if (this.native === undefined) throw new RemoteHostV3Error('REMOTE_HOST_V3_HELPER_UNAVAILABLE', 'A signed DSH Host app runtime handoff is required')
    if (!absolutePath(this.config.hostAppPath) || this.native.hostAppPath !== this.config.hostAppPath || this.native.runtimePipe.kind !== 'inherited-private-pipe') {
      throw new RemoteHostV3Error('REMOTE_HOST_V3_HELPER_MISMATCH', 'The mounted signed Host-app runtime handoff does not match deployment configuration')
    }
    return this.native
  }
}

/**
 * The hosted-launch argv contract, mirrored from the FD199 startup package
 * (which depends on this package, so the constant lives here too).
 */
const HOSTED_RUNTIME_ARGUMENTS = ['--private-relay-fd', '198', '--private-authority-fd', '199'] as const

function isHostedRuntimeInvocation(argv: readonly string[]): boolean {
  if (argv.length < HOSTED_RUNTIME_ARGUMENTS.length) return false
  return HOSTED_RUNTIME_ARGUMENTS.every((value, index) => argv[argv.length - HOSTED_RUNTIME_ARGUMENTS.length + index] === value)
}

/** Mount a disabled-by-default V3 Host coordinator. It never adds an HTTP listener, XPC client, key operation, or route credential. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain = await ctx.storageDomain.open(REMOTE_HOST_V3_DOMAIN)
  const allocator = new RemoteHostV3RouteAllocator(domain.table('routes'), domain.table('host'))
  // An ordinary Web Host deliberately has no signed-native handoff. Do not
  // read its optional service unless this deployment has explicitly enabled
  // the signed Host-app composition, because Cordis rejects undeclared direct
  // property access even when the disabled branch would never use it.
  const native = config.enabled ? ctx.get('remoteHostV3Native') : undefined
  const controller = new RemoteHostV3Controller(ctx, allocator, ctx.remoteDevices, native, config)
  ctx.effect(() => () => {
    void controller.dispose()
    return domain.close()
  })
  ctx.provide('remoteHostV3', controller)
  // The empty-hostAppPath marker defers the first serve only for a genuine
  // hosted launch (the FD199 startup plugin owns the later attach). The same
  // shape reached any other way stays fail-closed instead of going inert.
  const hostedLaunch = isHostedRuntimeInvocation(ctx.get('cmdlineArgs')?.get() ?? [])
  if (!shouldDeferStart({ enabled: config.enabled, hostAppPath: config.hostAppPath }, native, hostedLaunch)) {
    await controller.start()
  }
}

/**
 * Decides whether a hosted launch must wait for its later FD199 activation.
 * @param config - Enabled state and signed Host-app path marker.
 * @param native - Native provider available during initial composition.
 * @param hostedLaunch - Whether argv proves the fixed hosted-runtime invocation.
 * @returns whether startup must defer to the FD199 handoff.
 */
export function shouldDeferStart(
  config: { enabled: boolean; hostAppPath: string },
  native: RemoteHostV3NativeProvider | undefined,
  hostedLaunch: boolean,
): boolean {
  return config.enabled && native === undefined && config.hostAppPath == '' && hostedLaunch
}
