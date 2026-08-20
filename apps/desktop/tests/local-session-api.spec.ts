import { describe, expect, it } from 'vitest'
import { LocalSessionApi } from '../src/local-session-api.ts'

function response(value: unknown): Response {
  return Response.json({ type: 'server-response', rpcId: 'r', result: { ok: true, value } })
}

describe('LocalSessionApi', () => {
  it('uses only literal local DSH paths and forces a text-only queued prompt', async () => {
    const requests: Request[] = []
    const api = new LocalSessionApi(new URL('http://127.0.0.1:3080/'), async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.endsWith('/api/session.list')) return response({ items: [{ sessionId: 'desktop-session' }] })
      if (request.url.endsWith('/api/session.history')) return response({ events: [{ event: { type: 'assistant/message' } }] })
      return response({ accepted: true })
    })

    const [session] = await api.listSessions()
    await api.history(session!)
    await api.queueText(session!, 'plain mobile text')

    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/api/session.list', '/api/session.history', '/api/session.prompt',
    ])
    expect(await requests[2]!.json()).toMatchObject({
      type: 'client-request',
      method: 'session.prompt',
      payload: {
        sessionId: 'desktop-session',
        mode: 'queue',
        content: [{ type: 'text', text: 'plain mobile text' }],
      },
    })
    expect(requests.every(request => request.redirect === 'error')).toBe(true)
    expect(requests.every(request => request.headers.get('content-type') === 'application/json')).toBe(true)
  })

  it('refuses a non-loopback origin and malformed selected session before any request', async () => {
    expect(() => new LocalSessionApi(new URL('https://example.test/'))).toThrow('rejected non-local Harness URL')
    let called = false
    const api = new LocalSessionApi(new URL('http://localhost:3080/'), async () => {
      called = true
      return response({ accepted: true })
    })
    await expect(api.history({ key: 'bad\u0000session' })).rejects.toThrow('rejected the selected session')
    expect(called).toBe(false)
  })
})
