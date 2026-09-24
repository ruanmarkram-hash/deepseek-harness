import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebRuntime from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as bravePlugin from '../src/index.ts'
import { BraveSearchProvider, mapBraveResponse } from '../src/provider.ts'

afterEach(() => vi.unstubAllGlobals())

describe('Brave Search', () => {
  it('maps Brave web results without adding generated prose', () => {
    expect(mapBraveResponse({ web: { results: [
      { url: 'https://a.test', title: 'A', description: 'Summary' },
      { url: 'https://b.test' },
    ] } })).toEqual({
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'Summary' }, { url: 'https://b.test' }],
      truncated: false,
    })
    expect(mapBraveResponse({})).toEqual({ sources: [], truncated: false })
  })

  it('uses a custom credential reference and falls back to the launch environment', async () => {
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { CUSTOM_BRAVE_KEY: 'ambient-secret' } },
    ]))
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(bravePlugin, { apiKeyEnv: 'CUSTOM_BRAVE_KEY' })
    const sentKeys: Array<string | null> = []
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      sentKeys.push(new Headers(init.headers).get('X-Subscription-Token'))
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await ctx.web.search({ query: 'ambient' })
      expect(sentKeys).toEqual(['ambient-secret'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects absent and empty ambient keys when no credential service exists', async () => {
    for (const values of [{}, { BRAVE_API_KEY: '' }]) {
      const ctx = new Context()
      ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values }]))
      await ctx.plugin(WebRuntime, {})
      bravePlugin.apply(ctx, {})
      try {
        await expect(ctx.web.search({ query: 'missing' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })

  it('resolves the current stored credential on every search and sends the requested bound', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(MemoryCredentials, { BRAVE_API_KEY: 'first-secret' })
    await ctx.plugin(bravePlugin, {})
    const requests: Array<{ url: string; key: string | null; redirect: RequestRedirect }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: URL, init: RequestInit) => {
      requests.push({ url: String(input), key: new Headers(init.headers).get('X-Subscription-Token'), redirect: init.redirect ?? 'follow' })
      return new Response(JSON.stringify({ web: { results: [{ url: 'https://a.test' }] } }), { status: 200 })
    }))
    try {
      await ctx.web.search({ query: 'one', maxResults: 3 })
      await ctx.credentials.set(credentialRef('BRAVE_API_KEY'), 'second-secret')
      await ctx.web.search({ query: 'two', maxResults: 2 })
      expect(requests.map(r => r.key)).toEqual(['first-secret', 'second-secret'])
      expect(requests.map(r => new URL(r.url).searchParams.get('count'))).toEqual(['3', '2'])
      expect(requests.map(r => r.redirect)).toEqual(['error', 'error'])
      expect(requests.every(r => r.url.startsWith('https://api.search.brave.com/res/v1/web/search?'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps secrets out of missing-credential and transport errors', async () => {
    const provider = new BraveSearchProvider(async () => undefined)
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    const leaked = 'secret-only-in-transport-error'
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(leaked) }))
    const error = await new BraveSearchProvider(async () => 'brave-key')
      .search({ query: 'q' }).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(JSON.stringify(error)).not.toContain(leaked)
    expect(String(error)).not.toContain(leaked)
  })

  it('rejects credential lookup failures, cancellation, API errors, and malformed responses', async () => {
    const request = { query: 'q', maxResults: 50 }
    const rejectedCredential = new BraveSearchProvider(async () => { throw new Error('private credential detail') })
    await expect(rejectedCredential.search(request)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

    const controller = new AbortController()
    controller.abort()
    await expect(new BraveSearchProvider(async () => 'key').search(request, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })

    const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => new Response('{}', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new BraveSearchProvider(async () => 'key').search(request, new AbortController().signal))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('count')).toBe('20')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new BraveSearchProvider(async () => 'key').search(request)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('cancels a streaming API-error body before rejecting', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 503 })))
    await expect(new BraveSearchProvider(async () => 'key').search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(cancel).toHaveBeenCalledOnce()

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, body: null })))
    await expect(new BraveSearchProvider(async () => 'key').search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

    const privateCancellationError = 'private cancellation detail'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503,
      body: { cancel: () => Promise.reject(new Error(privateCancellationError)) },
    })))
    const error = await new BraveSearchProvider(async () => 'key').search({ query: 'q' }).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(JSON.stringify(error)).not.toContain(privateCancellationError)
  })

  it('classifies aborts in transport and response decoding', async () => {
    const provider = new BraveSearchProvider(async () => 'key')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }))
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    })))
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: () => Promise.reject(new DOMException('bad data', 'DataError')),
    })))
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('unregisters from the Web service when its fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(MemoryCredentials, {})
    const fiber = await ctx.plugin(bravePlugin, {})
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
    await ctx.fiber.dispose()
  })

  it('loads through a test-only Cordis file and returns Web sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-brave-'))
    const config = join(directory, 'cordis.yml')
    const ctx = new Context()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ web: { results: [
      { url: 'https://example.test', title: 'Example', description: 'Found' },
    ] } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      ctx.baseUrl = pathToFileURL(directory).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      Object.assign(ctx.loader.builtins, { web: WebRuntime, credentials: MemoryCredentials, brave: bravePlugin })
      await writeFile(config, '- name: cordis:web\n- name: cordis:credentials\n  config: {}\n- name: cordis:brave\n')
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
      await ctx.loader.await()
      for (const entry of ctx.loader.entries()) await entry.fiber?.await()
      await ctx.credentials.set(credentialRef('BRAVE_API_KEY'), 'fixture-only-key')
      expect(await ctx.web.search({ query: 'fixture query' })).toEqual({
        sources: [{ url: 'https://example.test', title: 'Example', snippet: 'Found' }], truncated: false,
      })
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('Brave redirect policy', () => {
  it.each([301, 302, 303, 307, 308])('blocks HTTP %i without contacting Location', async (status) => {
    let targetHits = 0
    const target = createServer((_request, response) => { targetHits++; response.writeHead(204).end() })
    let redirect: Server | undefined
    try {
      const targetOrigin = await listen(target)
      redirect = createServer((_request, response) => {
        response.writeHead(status, { location: `${targetOrigin}/collect` }).end()
      })
      const redirectOrigin = await listen(redirect)
      const provider = new BraveSearchProvider(async () => 'brave-secret', `${redirectOrigin}/search`)
      await expect(provider.search({ query: 'private query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(targetHits).toBe(0)
    } finally {
      if (redirect?.listening) await close(redirect)
      if (target.listening) await close(target)
    }
  })
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}
