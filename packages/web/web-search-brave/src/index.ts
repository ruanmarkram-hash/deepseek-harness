/** Brave Search provider for the Host web service.
 * @module @deepseek-ai/dsh-web-search-brave
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import { BraveSearchProvider } from './provider.ts'

export { BraveSearchProvider, BRAVE_SEARCH_ENDPOINT, BRAVE_PROVIDER_ID } from './provider.ts'

/** Cordis plugin name. */
export const name = 'web-search-brave'

/** The service receiving this provider. */
export const inject = ['web']

/** Secret-free plugin configuration. */
export interface Config {
  /** Credential reference resolved for each search. */
  apiKeyEnv?: string
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('BRAVE_API_KEY'),
})

/** Register Brave Search on the Host web service.
 * @param ctx - Host plugin context.
 * @param config - credential reference configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const ref = credentialRef(config.apiKeyEnv ?? 'BRAVE_API_KEY')
  ctx.web.registerSearchProvider(new BraveSearchProvider(async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    const ambient = launchEnvironmentOf(ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }))
}
