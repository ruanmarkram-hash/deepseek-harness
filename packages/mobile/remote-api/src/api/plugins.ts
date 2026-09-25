/** Sanitized Host plugin catalog shared by local and enrolled owner clients. */
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One installed Host plugin. Required entries remain visible but cannot be disabled. */
export interface PluginView {
  readonly id: string
  readonly name: string
  readonly source: 'bundled' | 'downloaded'
  readonly enabled: boolean
  readonly required: boolean
  readonly reason?: string
}

/** Host-owned plugin inspection and exact-id enablement. Package installation stays local to the Host. */
export interface PluginsApi {
  /** @param request - Empty catalog request. @returns Installed plugin rows from the Host. */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ plugins: PluginView[] }>>
  /** @param request - Exact installed plugin id and requested state. @returns The committed Host row. */
  setEnabled(request: RpcRequest<{ id: string; enabled: boolean }>): Promise<RpcResponse<{ plugin: PluginView }>>
}
