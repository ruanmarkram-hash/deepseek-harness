/** Build-32 mobile API compatibility over the current Host controllers. */
import type { Context } from '@deepseek-ai/cordis'
import { createMobileApi } from './adapter.ts'
import { installDesktopDiscovery } from './discovery.ts'
import type { ApiProxy } from './api/index.ts'
export type * from './api/index.ts'
export { RpcId } from './api/rpc.ts'
export { invokeApiProxyMethod, toFetchHandler } from './fetch/handler.ts'
export { AbstractApiClient, InProcessApiClient } from './fetch/client.ts'
export type { IApiClient } from './fetch/client.ts'
export { createMobileApi } from './adapter.ts'
export const name = 'remote-api'
export const inject = ['typertGateway', 'sessionController', 'workspaceController', 'sessions', 'agents', 'sessionProjections']
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Fixed mobile v3 API compatibility face, mounted only in a signed Host child. */
    apiProxy: ApiProxy
  }
}
/** Mount the mobile compatibility face over the same current Host services. */
export function apply(ctx: Context): void {
  const api = createMobileApi(ctx)
  ctx.provide('apiProxy', api)
  installDesktopDiscovery(ctx, api)
}
