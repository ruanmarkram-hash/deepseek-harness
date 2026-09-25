import { EventEmitter } from 'node:events'
import { RpcId, type ApiProxy } from '@deepseek-ai/dsh-remote-api'
import { afterEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  createSocket: vi.fn(),
}))

vi.mock('ws', () => ({ default: Object.assign(transport.createSocket, { CLOSED: 3 }) }))

import { createLoopbackApiProxy } from '../src/loopback-api-proxy.ts'

class FakeSocket extends EventEmitter {
  closed = false
  readyState = 1
  delayedClose = false
  readonly terminate = vi.fn(() => { this.finishClose() })

  close(): void {
    if (this.closed) return
    if (this.delayedClose) { this.readyState = 2; return }
    this.finishClose()
  }

  finishClose(): void {
    this.closed = true
    this.readyState = 3
    this.emit('close')
  }
}

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('createLoopbackApiProxy', () => {
  it.each([undefined, true, false])('downloads a session log with includeDescendants=%s', async (includeDescendants) => {
    const response = new Response('session log')
    transport.fetch.mockResolvedValue(response)
    vi.stubGlobal('fetch', transport.fetch)
    const signal = new AbortController().signal
    const api = createLoopbackApiProxy()
    const request = { sessionId: 'session /?#' as Parameters<ApiProxy['downloads']['sessionLog']>[0]['sessionId'], ...(includeDescendants === undefined ? {} : { includeDescendants }) }
    await expect(api.downloads.sessionLog(request, signal)).resolves.toBe(response)
    const [url, init] = transport.fetch.mock.calls[0]!
    if (!(url instanceof URL)) throw new Error('expected URL instance')
    expect(url.origin).toBe('http://127.0.0.1:3080')
    expect(url.pathname).toBe('/api/session.export')
    expect(url.searchParams.get('sessionId')).toBe(request.sessionId)
    expect(url.searchParams.get('includeDescendants')).toBe(includeDescendants === undefined ? null : String(includeDescendants))
    expect(init).toEqual({ method: 'GET', signal, cache: 'no-store', redirect: 'error' })
  })

  it('forwards a Client response only to the canonical response endpoint', async () => {
    transport.fetch.mockResolvedValue(Response.json({ accepted: true }))
    vi.stubGlobal('fetch', transport.fetch)
    const message = { type: 'client-response' as const, rpcId: RpcId('answer'), result: { ok: true as const, value: null } }
    await expect(createLoopbackApiProxy().respond(message)).resolves.toEqual({ accepted: true })
    expect(transport.fetch.mock.calls[0]?.[0]).toEqual(new URL('http://127.0.0.1:3080/api/respond'))
    const body = transport.fetch.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') throw new Error('expected serialized request')
    expect(JSON.parse(body)).toEqual(message)
    const init = transport.fetch.mock.calls[0]?.[1]
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', redirect: 'error' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it.each(['buffer', 'array-buffer', 'chunks'] as const)('decodes %s text frames while ignoring binary and malformed frames', async (kind) => {
    const socket = new FakeSocket()
    transport.createSocket.mockImplementation(function SocketFixture() { return socket })
    const control = new AbortController()
    const iterator = createLoopbackApiProxy().events.mux({ rpcId: RpcId('stream'), payload: {} }, control.signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    socket.emit('message', Buffer.from('binary'), true)
    socket.emit('message', Buffer.from('{not-json'), false)
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'bad-envelope' })), false)
    const bytes = Buffer.from(JSON.stringify({
      type: 'server-request', rpcId: 'frame-id', method: 'stream/error',
      payload: { type: 'stream/error', error: { code: 'bad-request', message: 'fixture', details: { issues: [] } } },
    }))
    const data = kind === 'buffer' ? bytes : kind === 'chunks' ? [bytes.subarray(0, 10), bytes.subarray(10)] : Uint8Array.from(bytes).buffer
    socket.emit('message', data, false)
    await expect(next).resolves.toMatchObject({ done: false, value: { rpcId: 'frame-id' } })
    control.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('finishes a stream whose signal was already cancelled at opening', async () => {
    const socket = new FakeSocket()
    transport.createSocket.mockImplementation(function SocketFixture() { return socket })
    const iterator = createLoopbackApiProxy().events.host({ rpcId: RpcId('stream'), payload: {} }, AbortSignal.abort())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    expect(socket.closed).toBe(true)
  })

  it.each(['synchronous', 'asynchronous', 'timeout', 'error'] as const)('releases listeners after %s socket shutdown', async (completion) => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    socket.delayedClose = completion !== 'synchronous'
    transport.createSocket.mockImplementation(function SocketFixture() { return socket })
    const iterator = createLoopbackApiProxy().events.host({ rpcId: RpcId('stream'), payload: {} }, new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    socket.emit('error', new Error('transport disconnected'))
    await vi.advanceTimersByTimeAsync(0)
    if (completion === 'asynchronous') socket.finishClose()
    else if (completion === 'error') socket.emit('error', new Error('close failed'))
    else if (completion === 'timeout') await vi.advanceTimersByTimeAsync(1000)
    await expect(next).resolves.toMatchObject({ done: true })
    expect(socket.eventNames()).toEqual([])
    expect(socket.terminate).toHaveBeenCalledTimes(completion === 'timeout' || completion === 'error' ? 1 : 0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not terminate a socket closed by an earlier callback in the same error dispatch', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    socket.delayedClose = true
    transport.createSocket.mockImplementation(function SocketFixture() { return socket })
    const iterator = createLoopbackApiProxy().events.host({ rpcId: RpcId('stream'), payload: {} }, new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    socket.emit('error', new Error('transport disconnected'))
    await vi.advanceTimersByTimeAsync(0)
    // EventEmitter snapshots the listeners. Closing here removes the later
    // force-termination listener, but that captured callback still runs once.
    socket.prependOnceListener('error', () => { socket.finishClose() })
    socket.emit('error', new Error('closing transport'))
    await expect(next).resolves.toMatchObject({ done: true })
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(socket.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('uses only the fixed loopback unary carrier and restores the Host rpc id', async () => {
    transport.fetch.mockImplementation(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected serialized request')
      const request = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: false, error: { code: 'bad-request', message: 'fixture refusal', details: { issues: [] } } },
      })
    })
    vi.stubGlobal('fetch', transport.fetch)
    const api = createLoopbackApiProxy()

    const response = await api.host.describe({ rpcId: RpcId('outer-host-id'), payload: {} })

    expect(response).toMatchObject({ rpcId: 'outer-host-id', result: { ok: false } })
    expect(transport.fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3080/api/host.describe'),
      expect.objectContaining({ method: 'POST', cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json' } }),
    )
    const [destination, init] = transport.fetch.mock.calls[0]!
    if (!(destination instanceof URL)) throw new Error('expected URL instance')
    expect(destination.origin).toBe('http://127.0.0.1:3080')
    expect(destination.search).toBe('')
    expect(destination.hash).toBe('')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    if (typeof init?.body !== 'string') throw new Error('expected serialized request')
    expect(JSON.parse(init.body)).toMatchObject({ type: 'client-request', method: 'host.describe', payload: {} })
  })

  it('opens only the fixed mux WebSocket and closes it when the gateway aborts', async () => {
    const socket = new FakeSocket()
    transport.createSocket.mockImplementation(function SocketFixture() { return socket })
    vi.stubGlobal('fetch', transport.fetch)
    const api = createLoopbackApiProxy()
    const abort = new AbortController()
    const iterator = api.events.mux({ rpcId: RpcId('stream-id'), payload: {} }, abort.signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    socket.emit('message', JSON.stringify({
      type: 'server-request', rpcId: 'frame-id', method: 'stream/error',
      payload: { type: 'stream/error', error: { code: 'bad-request', message: 'fixture', details: { issues: [] } } },
    }), false)

    await expect(next).resolves.toMatchObject({ done: false, value: { rpcId: 'frame-id', payload: { type: 'stream/error' } } })
    expect(transport.createSocket).toHaveBeenCalledWith(
      'ws://127.0.0.1:3080/api/events.mux',
      { maxPayload: 8 * 1024 * 1024 },
    )
    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    expect(socket.closed).toBe(true)
  })

  it('closes instead of decoding an oversized local WebSocket frame', async () => {
    const socket = new FakeSocket()
    transport.createSocket.mockImplementation(function SocketFixture() { return socket })
    vi.stubGlobal('fetch', transport.fetch)
    const api = createLoopbackApiProxy()
    const abort = new AbortController()
    const iterator = api.events.host({ rpcId: RpcId('stream-id'), payload: {} }, abort.signal)[Symbol.asyncIterator]()
    const next = iterator.next()

    socket.emit('message', Buffer.alloc(8 * 1024 * 1024 + 1), false)

    await expect(next).resolves.toMatchObject({ done: true })
    expect(socket.closed).toBe(true)
  })
})
