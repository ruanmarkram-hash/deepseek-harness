/** Fixed, sealed DSH services owned only by the signed Host runtime child. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RemoteDeviceDirectory, RemoteDeviceId, RemoteDeviceRecord } from '../../../packages/mobile/remote-devices/src/types.ts'
import type { RemoteHostV3Route } from '../../../packages/mobile/remote-host-v3/src/types.ts'
import type { RemoteWireId } from '../../../packages/mobile/remote-wire/src/types.ts'
import type { SealedHostDshServices } from './host-owned-dsh-runtime.ts'
import {
  requireSealedDshServiceCore,
  resolveProductionSealedDshServiceCore,
  type SealedDshServiceCore,
} from './sealed-dsh-service-graph.ts'

const STATE_VERSION = 2
const MAX_STATE_BYTES = 8 * 1024 * 1024
const STORE_DIRECTORY = join(homedir(), 'Library', 'Application Support', 'DSH Host', 'sealed-runtime-v3')
const STATE_FILE = 'state.json'
const LOCK_FILE = 'runtime.lock'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const KEY = /^[A-Za-z0-9_-]{43}$/

interface StoredDevice { readonly id: string; readonly incarnation: string; readonly label: string; readonly signingPublicKey: string; readonly agreementPublicKey: string; readonly enrolledAt: string; readonly lastSeenAt?: string }
interface StoredRoute { readonly routeId: string; readonly deviceId: string; readonly deviceEnrollmentId: string; readonly hostDeviceId: string; readonly hostEnrollmentId: string; readonly generation: number; readonly lastConnectionEpoch: number; readonly pendingConnectionEpoch?: number; readonly createdAt: string }
interface StoredState { readonly version: typeof STATE_VERSION; readonly hostEnrollmentId: string; readonly devices: Record<string, StoredDevice>; readonly routes: Record<string, StoredRoute> }

/** Closed failures for missing, corrupted, locked, or oversized signed-Host state. */
export class SealedHostDshCompositionUnavailableError extends Error {
  constructor() { super('sealed Host-owned DSH composition is unavailable'); this.name = 'SealedHostDshCompositionUnavailableError' }
}

/** A started static composition and the lock it owns for its entire child lifetime. */
export interface StaticHostDshComposition { readonly services: SealedHostDshServices; dispose(): Promise<void> }

/** Opens the only production store location. It is separate from every DSH Web profile home. */
export async function createStaticHostDshServices(): Promise<StaticHostDshComposition> {
  try {
    return await createServices(STORE_DIRECTORY, resolveProductionSealedDshServiceCore())
  } catch {
    throw new SealedHostDshCompositionUnavailableError()
  }
}

/** Test-only static-root seam. Production code never supplies a location. */
export const internals = { createServices }

async function createServices(root: string, core: SealedDshServiceCore): Promise<StaticHostDshComposition> {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const lock = await open(join(root, LOCK_FILE), 'wx', 0o600)
    let released = false
    try {
      const store = new FixedHostStore(join(root, STATE_FILE))
      await store.load()
      const checkedCore = requireSealedDshServiceCore(core)
      const sessionsRoot = join(root, 'sessions')
      await mkdir(sessionsRoot, { recursive: true, mode: 0o700 })
      const services: SealedHostDshServices = {
        apiProxy: await checkedCore.createApiProxy({ root, sessionsRoot }), remoteDevices: createDevices(store), routeAllocator: createRouteAllocator(store),
        now: () => new Date().toISOString(), newId: () => randomUUID() as RemoteWireId, audit: () => {},
      }
      return {
        services,
        async dispose(): Promise<void> {
          if (released) return
          released = true
          try { await checkedCore.dispose() } finally { await lock.close(); await rm(join(root, LOCK_FILE), { force: true }) }
        },
      }
    } catch (error) {
      await lock.close(); await rm(join(root, LOCK_FILE), { force: true }); throw error
    }
  } catch (error) {
    if (error instanceof SealedHostDshCompositionUnavailableError) throw error
    throw new SealedHostDshCompositionUnavailableError()
  }
}

/** Bounded, atomically replaced Host-owned public state. */
class FixedHostStore {
  private state: StoredState | undefined
  private writes = Promise.resolve()
  constructor(private readonly filename: string) {}
  async load(): Promise<void> {
    try {
      const content = await readFile(this.filename)
      if (content.byteLength > MAX_STATE_BYTES) throw new SealedHostDshCompositionUnavailableError()
      this.state = parseState(content.toString('utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = { version: STATE_VERSION, hostEnrollmentId: randomUUID(), devices: Object.create(null) as Record<string, StoredDevice>, routes: Object.create(null) as Record<string, StoredRoute> }
      await this.persist(this.read())
    }
  }
  read(): StoredState { if (this.state === undefined) throw new SealedHostDshCompositionUnavailableError(); return this.state }
  async update(mutator: (state: StoredState) => StoredState): Promise<StoredState> {
    const result = this.writes.then(async () => { const next = mutator(this.read()); await this.persist(next); this.state = next; return next })
    this.writes = result.then(() => {}, () => {})
    return result
  }
  private async persist(state: StoredState): Promise<void> {
    const output = `${JSON.stringify(state)}\n`
    if (Buffer.byteLength(output) > MAX_STATE_BYTES) throw new SealedHostDshCompositionUnavailableError()
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    await writeFile(temporary, output, { mode: 0o600 }); await rename(temporary, this.filename)
  }
}

function createDevices(store: FixedHostStore): RemoteDeviceDirectory {
  const copy = (value: StoredDevice): RemoteDeviceRecord => ({ ...value }) as RemoteDeviceRecord
  return {
    get(deviceId: RemoteDeviceId): RemoteDeviceRecord | undefined { const device = store.read().devices[deviceId]; return device === undefined ? undefined : copy(device) },
    async enroll(input: { readonly id: string; readonly label: string; readonly signingPublicKey: string; readonly agreementPublicKey: string }): Promise<RemoteDeviceRecord> {
      if (!ID.test(input.id) || !KEY.test(input.signingPublicKey) || !KEY.test(input.agreementPublicKey) || input.signingPublicKey === input.agreementPublicKey || input.label.trim().length === 0 || input.label.length > 64) throw new SealedHostDshCompositionUnavailableError()
      const now = new Date().toISOString(); let enrolled: StoredDevice | undefined
      await store.update(state => { if (state.devices[input.id] !== undefined) throw new SealedHostDshCompositionUnavailableError(); enrolled = { ...input, incarnation: randomUUID(), enrolledAt: now }; return { ...state, devices: { ...state.devices, [input.id]: enrolled } } })
      return copy(enrolled!)
    },
    async markSeen(deviceId: RemoteDeviceId, seenAt: string): Promise<RemoteDeviceRecord> {
      let seen: StoredDevice | undefined
      await store.update(state => { const current = state.devices[deviceId]; if (current === undefined || new Date(seenAt).toISOString() !== seenAt) throw new SealedHostDshCompositionUnavailableError(); seen = { ...current, lastSeenAt: seenAt }; return { ...state, devices: { ...state.devices, [deviceId]: seen } } })
      return copy(seen!)
    },
  } as RemoteDeviceDirectory
}

function createRouteAllocator(store: FixedHostStore): SealedHostDshServices['routeAllocator'] {
  const copy = (value: StoredRoute): RemoteHostV3Route => ({ ...value }) as RemoteHostV3Route
  return {
    async hostEnrollmentId(): Promise<string> { return store.read().hostEnrollmentId },
    get(deviceId: RemoteDeviceId): RemoteHostV3Route | undefined { const route = store.read().routes[deviceId]; return route === undefined ? undefined : copy(route) },
    async create(input) { let created: StoredRoute | undefined; await store.update(state => { if (state.routes[input.deviceId] !== undefined) throw new SealedHostDshCompositionUnavailableError(); created = { ...input, lastConnectionEpoch: 0, createdAt: new Date().toISOString() }; return { ...state, routes: { ...state.routes, [input.deviceId]: created } } }); return copy(created!) },
    async beginConnection(deviceId) { let next: StoredRoute | undefined; await store.update(state => { const current = state.routes[deviceId]; if (current === undefined) throw new SealedHostDshCompositionUnavailableError(); next = current.pendingConnectionEpoch === undefined ? { ...current, pendingConnectionEpoch: current.lastConnectionEpoch + 1 } : current; return { ...state, routes: { ...state.routes, [deviceId]: next } } }); return copy(next!) },
    async commitConnection(deviceId, epoch) { let committed: StoredRoute | undefined; await store.update(state => { const current = state.routes[deviceId]; if (current === undefined || current.pendingConnectionEpoch !== epoch) throw new SealedHostDshCompositionUnavailableError(); const { pendingConnectionEpoch: _pendingConnectionEpoch, ...rest } = current; committed = { ...rest, lastConnectionEpoch: epoch }; return { ...state, routes: { ...state.routes, [deviceId]: committed } } }); return copy(committed!) },
    async remove(deviceId) { let removed: StoredRoute | undefined; await store.update(state => { removed = state.routes[deviceId]; const { [deviceId]: _removed, ...routes } = state.routes; return { ...state, routes } }); return removed === undefined ? undefined : copy(removed) },
  }
}

function parseState(input: string): StoredState {
  let value: unknown; try { value = JSON.parse(input) } catch { throw new SealedHostDshCompositionUnavailableError() }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SealedHostDshCompositionUnavailableError()
  const state = value as Partial<StoredState>
  if (state.version !== STATE_VERSION || !ID.test(state.hostEnrollmentId ?? '') || !plainMap(state.devices) || !plainMap(state.routes)) throw new SealedHostDshCompositionUnavailableError()
  return state as StoredState
}
function plainMap(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).some(key => key === '__proto__' || key === 'constructor' || key === 'prototype') }
