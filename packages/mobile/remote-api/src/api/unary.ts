/** Released mobile method names shared by in-process and loopback carriers. */

import type { ApiProxy } from './index.ts'
import type { RequestPayload, ResponseValue, RpcMethodMap } from './rpc-map.ts'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * Bind every released unary operation to one carrier's request handler.
 * @param unary - Carrier-owned handler factory preserving method payload and result types.
 * @returns The unary domains of the mobile API; events, downloads, and replies remain carrier-owned.
 */
export function bindMobileUnaryMethods(
  unary: <K extends keyof RpcMethodMap>(method: K) => (
    request: RpcRequest<RequestPayload<K>>, signal?: AbortSignal,
  ) => Promise<RpcResponse<ResponseValue<K>>>,
): Omit<ApiProxy, 'events' | 'downloads' | 'respond'> {
  return {
    sessions: {
      list: unary('session.list'), search: unary('session.search'), create: unary('session.create'), history: unary('session.history'),
      models: unary('session.models'), selectModel: unary('session.selectModel'), rename: unary('session.rename'), fork: unary('session.fork'),
      prompt: unary('session.prompt'), attachment: unary('session.attachment'), updateQueue: unary('session.updateQueue'), cancel: unary('session.cancel'),
    },
    subagents: { list: unary('subagent.list'), history: unary('subagent.history'), prompt: unary('subagent.prompt'), interrupt: unary('subagent.interrupt') },
    host: { describe: unary('host.describe'), pickDirectory: unary('host.pickDirectory'), listDirectory: unary('host.listDirectory'), createDirectory: unary('host.createDirectory'), openPath: unary('host.openPath') },
    workspace: { list: unary('workspace.list'), create: unary('workspace.create'), rename: unary('workspace.rename'), delete: unary('workspace.delete'), insertBefore: unary('workspace.insertBefore'), insertSessionBefore: unary('workspace.insertSessionBefore'), archiveSession: unary('workspace.archiveSession') },
    skills: { list: unary('skill.list') },
    plugins: { list: unary('plugins.list'), setEnabled: unary('plugins.setEnabled') },
    agentPresets: { list: unary('agentPreset.list'), select: unary('agentPreset.select'), read: unary('agentPreset.read'), copy: unary('agentPreset.copy'), openDocument: unary('agentPreset.openDocument'), remove: unary('agentPreset.remove') },
    goals: { create: unary('goal.create'), edit: unary('goal.edit'), pause: unary('goal.pause'), resume: unary('goal.resume'), complete: unary('goal.complete'), clear: unary('goal.clear') },
    settings: { describe: unary('settings.describe'), openDocument: unary('settings.openDocument'), update: unary('settings.update'), replace: unary('settings.replace'), mutate: unary('settings.mutate') },
    credentials: { describe: unary('credentials.describe'), set: unary('credentials.set'), unset: unary('credentials.unset') },
    llm: { providers: unary('llm.providers'), models: unary('llm.models'), discoverModels: unary('llm.discoverModels') },
  }
}
