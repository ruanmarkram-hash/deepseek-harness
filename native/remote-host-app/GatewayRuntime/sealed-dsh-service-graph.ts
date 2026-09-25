/**
 * The fixed service requirements for a real, in-process DSH model runtime.
 *
 * This module intentionally provides no substitute implementation. The Web
 * profile is not an authenticated capability and must never be imported or
 * booted by the signed Host child.
 */
import type { ApiProxy } from '../../../packages/mobile/remote-api/src/api/index.ts'

/** Exact static components a future sealed core must provide before FD198 is accepted. */
export const SEALED_DSH_SERVICE_GRAPH = Object.freeze({
  composition: 'dsh-sealed-host-core-v1',
  required: Object.freeze([
    'agent-default-model',
    'agents',
    'attachments',
    'llm',
    'session-persistence',
    'sessions',
    'subagents',
    'user-approval',
    'user-questions',
    'workspace-registry',
  ]),
  forbidden: Object.freeze([
    'Loader',
    'profile-patches',
    'user-patches',
    'environment-configuration',
    'webserver',
    'localhost-carrier',
    'dynamic-plugin-imports',
  ]),
} as const)

/** Fixed directories that a true core receives from the signed Host only. */
export interface SealedDshStorage {
  /** Private signed-Host root, never a DSH Web profile home. */
  readonly root: string
  /** The core's exclusively owned durable session root. */
  readonly sessionsRoot: string
}

/**
 * A future dependency-closed DSH core. It must implement the real ApiProxy
 * operations over agents, events, approvals, and durable session logs.
 */
export interface SealedDshServiceCore {
  /** Versioned identity checked before the remote provider is started. */
  readonly composition: typeof SEALED_DSH_SERVICE_GRAPH.composition
  /** Builds the real ApiProxy from fixed Host-owned dependencies only. */
  createApiProxy(storage: SealedDshStorage): Promise<ApiProxy>
  /** Releases all core resources before the signed Host child exits. */
  dispose(): Promise<void>
}

/** Thrown until the dependency-closed agent/model core is linked into this artifact. */
export class SealedDshServiceGraphUnavailableError extends Error {
  constructor() {
    super('the dependency-closed DSH agent/model service graph is unavailable')
    this.name = 'SealedDshServiceGraphUnavailableError'
  }
}

/**
 * Resolves the production service graph. There is deliberately no fallback to
 * the Web profile, a local port, Loader, environment, or user configuration.
 * @returns never until a statically linked sealed core is supplied.
 */
export function resolveProductionSealedDshServiceCore(): never {
  throw new SealedDshServiceGraphUnavailableError()
}

/**
 * Checks a directly linked core before it is trusted with the signed Host
 * state. Tests may supply an in-memory implementation through this typed seam.
 * @param core - statically linked core implementation.
 * @returns the checked core.
 */
export function requireSealedDshServiceCore(core: SealedDshServiceCore): SealedDshServiceCore {
  if (core.composition !== SEALED_DSH_SERVICE_GRAPH.composition) {
    throw new SealedDshServiceGraphUnavailableError()
  }
  return core
}
