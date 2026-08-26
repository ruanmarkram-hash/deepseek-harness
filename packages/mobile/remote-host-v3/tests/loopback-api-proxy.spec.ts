import { EventEmitter } from 'node:events'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  fetch: vi.fn(),
  createSocket: vi.fn(),
}))

vi.mock('ws', () => ({ default: transport.createSocket }))

import { createLoopbackApiProxy } from '../src/loopback-api-proxy.ts'

class FakeSocket extends EventEmitter {
  closed = false

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('createLoopbackApiProxy', () => {
  it('uses only the fixed loopback unary carrier and restores the Host rpc id', async () => {
    transport.fetch.mockImplementation(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string }
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
