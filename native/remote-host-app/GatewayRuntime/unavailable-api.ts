/** Closed defaults for API capabilities not linked into a fixed native service graph. */
import type { ApiProxy } from '../../../packages/mobile/remote-api/src/api/index.ts'

async function unavailable(): Promise<never> {
  throw new Error('this API capability is unavailable in the sealed Host graph')
}

async function* noEvents(): AsyncIterable<never> {}

/**
 * Supply a complete typed API whose unimplemented operations fail closed.
 * Callers replace only the capabilities their fixed graph actually owns.
 * @returns a fresh capability surface with no ambient services or transports.
 */
export function unavailableApi(): ApiProxy {
  return {
    sessions: {
      list: unavailable, search: unavailable, create: unavailable, history: unavailable,
      models: unavailable, selectModel: unavailable, rename: unavailable, fork: unavailable,
      prompt: unavailable, attachment: unavailable, updateQueue: unavailable, cancel: unavailable,
    },
    subagents: { list: unavailable, history: unavailable, prompt: unavailable, interrupt: unavailable },
    host: {
      describe: unavailable, pickDirectory: unavailable, listDirectory: unavailable,
      createDirectory: unavailable, openPath: unavailable,
    },
    workspace: {
      list: unavailable, create: unavailable, rename: unavailable, delete: unavailable,
      insertBefore: unavailable, insertSessionBefore: unavailable, archiveSession: unavailable,
    },
    skills: { list: unavailable },
    agentPresets: {
      list: unavailable, select: unavailable, read: unavailable, copy: unavailable,
      openDocument: unavailable, remove: unavailable,
    },
    goals: {
      create: unavailable, edit: unavailable, pause: unavailable, resume: unavailable, complete: unavailable, clear: unavailable,
    },
    settings: {
      describe: unavailable, openDocument: unavailable, update: unavailable, replace: unavailable, mutate: unavailable,
    },
    credentials: { describe: unavailable, set: unavailable, unset: unavailable },
    llm: { providers: unavailable, models: unavailable, discoverModels: unavailable },
    events: { mux: noEvents, host: noEvents },
    downloads: { sessionLog: unavailable },
    respond: unavailable,
  }
}
