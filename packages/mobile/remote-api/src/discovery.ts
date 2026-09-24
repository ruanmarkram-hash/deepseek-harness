/** Read-only loopback discovery used by the independently installed thin Desktop shell. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ApiProxy } from './api/index.ts'
import { toFetchHandler } from './fetch/handler.ts'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const MAX_DISCOVERY_BODY = 8192

/**
 * Register the exact legacy discovery route, without mounting legacy mutation endpoints.
 * @param ctx - Host context whose WebServer owns the listener lifetime.
 * @param api - Read-only descriptor provider behind the hosted operation fence.
 */
export function installDesktopDiscovery(ctx: Context, api: ApiProxy): void {
  ctx.inject(['webServer'], (web) => {
    web.effect(() => web.webServer.register({ kind: 'exact', path: '/api/host.describe', async handler(request, response) {
      const local = request.socket.remoteAddress !== undefined && LOOPBACK_ADDRESSES.has(request.socket.remoteAddress)
      const host = request.headers.host
      const authority = typeof host === 'string' && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)
      if (!local || !authority || request.headers.origin !== undefined) { response.writeHead(403); response.end(); return }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
      const chunks: Buffer[] = []
      let size = 0
      try {
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.length
          if (size > MAX_DISCOVERY_BODY) { response.writeHead(413); response.end(); return }
          chunks.push(Buffer.from(bytes))
        }
        const result = await toFetchHandler(api).fetch(new Request('http://127.0.0.1/api/host.describe', {
          method: 'POST', headers: { 'content-type': request.headers['content-type'] ?? '' }, body: Buffer.concat(chunks).toString('utf8'),
        }))
        response.writeHead(result.status, Object.fromEntries(result.headers))
        response.end(await result.text())
      } catch {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      }
    } }), 'remote-api: thin Desktop discovery')
  })
}
