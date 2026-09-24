/** Fixed loopback carrier from the sealed remote Host runtime to the live DSH Web Host. */

import WebSocket from 'ws'
import {
  AbstractApiClient,
  type ApiProxy,
  type HostFrame,
  type MuxFrame,
  type RequestPayload,
  type ResponseValue,
  type RpcMethodMap,
  type RpcRequest,
  type RpcResponse,
} from '@deepseek-ai/dsh-remote-api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-remote-api/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-remote-api/api/rpc.schema'
import { bindMobileUnaryMethods } from '@deepseek-ai/dsh-remote-api/api/unary'

const LOOPBACK_ORIGIN = 'http://127.0.0.1:3080/'
const LOOPBACK_HOST = '127.0.0.1'
const LOOPBACK_PORT = '3080'
const MAX_WEBSOCKET_MESSAGE_BYTES = 8 * 1024 * 1024

/**
 * Builds the sole API carrier allowed for the sealed remote runtime: the existing local DSH Web Host.
 * @returns an API proxy restricted to the fixed loopback Host endpoints.
 */
export function createLoopbackApiProxy(): ApiProxy {
  const client = new LoopbackApiClient()
  const unary = <K extends keyof RpcMethodMap>(method: K) => (
    request: RpcRequest<RequestPayload<K>>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<ResponseValue<K>>> => client.call(method, request.payload, signal)
    .then(response => ({ rpcId: request.rpcId, result: response.result }))

  return {
    ...bindMobileUnaryMethods(unary),
    events: {
      mux: (_request, signal) => client.eventsMux(signal),
      host: (_request, signal) => client.eventsHost(signal),
    },
    downloads: { sessionLog: (request, signal) => client.sessionLog(request.sessionId, request.includeDescendants, signal) },
    respond: message => client.respond(message),
  } satisfies ApiProxy
}

class LoopbackApiClient extends AbstractApiClient {
  protected override resolveBase(): string {
    return LOOPBACK_ORIGIN
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    // This private client exposes only the bound unary and response methods.
    // Their shared JSON carrier owns init; transport policy and authority stay fixed here.
    const destination = new URL(LOOPBACK_ORIGIN)
    destination.pathname = input.pathname
    const request: RequestInit = {
      ...init,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      redirect: 'error',
    }
    return globalThis.fetch(destination, request)
  }

  call<K extends keyof RpcMethodMap>(method: K, payload: RequestPayload<K>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<K>>> {
    return this.callUnary(method, payload, signal)
  }

  eventsMux(signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket('/api/events.mux', signal, muxFrameSchema)
  }

  eventsHost(signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket('/api/events.host', signal, hostFrameSchema)
  }

  async sessionLog(sessionId: string, includeDescendants: boolean | undefined, signal: AbortSignal): Promise<Response> {
    const url = new URL('/api/session.export', LOOPBACK_ORIGIN)
    url.searchParams.set('sessionId', sessionId)
    if (includeDescendants !== undefined) url.searchParams.set('includeDescendants', String(includeDescendants))
    return globalThis.fetch(url, { method: 'GET', signal, cache: 'no-store', redirect: 'error' })
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: '/api/events.mux' | '/api/events.host',
    signal: AbortSignal,
    frameSchema: { parse(value: unknown): F },
  ): AsyncGenerator<RpcRequest<F>> {
    const socket = new WebSocket(`ws://${LOOPBACK_HOST}:${LOOPBACK_PORT}${path}`, {
      maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
    })
    const inbox: Array<RpcRequest<F> | undefined> = []
    let wake: (() => void) | undefined
    const enqueue = (value: RpcRequest<F> | undefined): void => { inbox.push(value); wake?.(); wake = undefined }
    const close = (): void => { enqueue(undefined) }
    const message = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return
      try {
        if (messageBytes(data) > MAX_WEBSOCKET_MESSAGE_BYTES) {
          socket.close(1009, 'message too large')
          return
        }
        const raw = typeof data === 'string'
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(data)).toString('utf8')
            : Array.isArray(data)
              ? Buffer.concat(data).toString('utf8')
              : data.toString('utf8')
        const envelope = serverRequestSchema.parse(JSON.parse(raw))
        const payload = frameSchema.parse(envelope.payload)
        this.onEnvelope(envelope)
        enqueue({ rpcId: envelope.rpcId, payload })
      } catch {
        // One malformed local frame cannot be reinterpreted as trusted Host state.
      }
    }
    const abort = (): void => { socket.close() }
    socket.on('message', message)
    socket.once('close', close)
    socket.once('error', close)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift()
          if (item === undefined) return
          yield item
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await closeSocket(socket)
      socket.off('message', message)
      socket.off('close', close)
      socket.off('error', close)
    }
  }
}

function messageBytes(data: WebSocket.RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data)
  if (data instanceof ArrayBuffer) return data.byteLength
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0)
  return data.byteLength
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => {
    let settled = false
    const isSettled = () => settled
    let deadline: ReturnType<typeof setTimeout> | undefined
    const forceTerminate = (): void => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      socket.off('close', finish)
      socket.off('error', forceTerminate)
      if (deadline !== undefined) clearTimeout(deadline)
      resolve()
    }
    socket.once('close', finish)
    socket.on('error', forceTerminate)
    socket.close()
    if (!isSettled()) {
      deadline = setTimeout(() => {
        forceTerminate()
        finish()
      }, 1_000)
      deadline.unref()
    }
  })
}
