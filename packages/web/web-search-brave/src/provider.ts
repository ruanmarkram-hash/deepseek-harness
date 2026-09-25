/** Brave Web Search HTTP adapter.
 * @module @deepseek-ai/dsh-web-search-brave/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/** Stable search provider id. */
export const BRAVE_PROVIDER_ID = 'brave'

/** Brave's published Web Search endpoint. */
export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

interface BraveResponse {
  web?: { results?: Array<{ url: string; title?: string; description?: string }> }
}

/** Map portable source fields from a Brave Web Search response.
 * @param body - parsed Brave response.
 * @returns sources for the web service.
 */
export function mapBraveResponse(body: BraveResponse): WebSearchResult {
  const sources: WebSearchSource[] = (body.web?.results ?? []).map(item => ({
    url: item.url,
    ...item.title ? { title: item.title } : {},
    ...item.description ? { snippet: item.description } : {},
  }))
  return { sources, truncated: false }
}

/** Resolves a fresh key for every request and never includes it in an error. */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = BRAVE_PROVIDER_ID

  /**
   * @param resolveApiKey - current key source.
   * @param endpoint - Web Search endpoint; production uses the fixed Brave endpoint.
   */
  constructor(
    private readonly resolveApiKey: () => Promise<string | undefined>,
    private readonly endpoint = BRAVE_SEARCH_ENDPOINT,
  ) {}

  /** Credential lookup is asynchronous; a selected provider reports a missing key on search. */
  available(): boolean { return true }

  /** Search Brave, rejecting redirects before any credential can reach the target.
   * @param request - query and optional source bound.
   * @param signal - optional caller cancellation.
   * @returns normalized Brave web sources.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const apiKey = await this.resolveApiKey().catch(() => {
      throw new WebError('Brave Search credential resolution failed', 'WEB_PROVIDER_ERROR')
    })
    if (!apiKey) throw new WebError('Brave Search API key is unavailable', 'WEB_PROVIDER_CREDENTIAL_MISSING')
    if (signal?.aborted) throw new WebError('Brave Search aborted', 'WEB_ABORTED')

    const url = new URL(this.endpoint)
    url.searchParams.set('q', request.query)
    url.searchParams.set('count', String(Math.min(request.maxResults ?? 10, 20)))
    let response: Response
    try {
      response = await fetch(url, {
        redirect: 'error',
        headers: { 'X-Subscription-Token': apiKey, accept: 'application/json' },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (isAbortError(error) || signal?.aborted) throw new WebError('Brave Search aborted', 'WEB_ABORTED')
      throw new WebError('Brave Search request failed', 'WEB_PROVIDER_ERROR')
    }
    if (!response.ok) {
      // An error response may stream indefinitely; release its connection before reporting failure.
      await response.body?.cancel().catch(() => undefined)
      throw new WebError(`Brave Search API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }
    try {
      return mapBraveResponse(await response.json() as BraveResponse)
    } catch (error: unknown) {
      if (isAbortError(error) || signal?.aborted) throw new WebError('Brave Search aborted', 'WEB_ABORTED')
      throw new WebError('Brave Search returned an unprocessable response', 'WEB_PROVIDER_ERROR')
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
