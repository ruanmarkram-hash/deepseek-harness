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
} from '@deepseek-ai/dsh-host-apiproxy'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'

const LOOPBACK_ORIGIN = 'http://127.0.0.1:3080/'
const LOOPBACK_HOST = '127.0.0.1'
const LOOPBACK_PORT = '3080'
const MAX_WEBSOCKET_MESSAGE_BYTES = 8 * 1024 * 1024
const API_METHOD_PATH = /^\/api\/(?:session|subagent|host|workspace|skill|agentPreset|goal|settings|credentials|llm)\.[A-Za-z]+$/
const EVENTS_PATHS = new Set(['/api/events.mux', '/api/events.host'])

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
    sessions: {
      list: unary('session.list'), search: unary('session.search'), create: unary('session.create'), history: unary('session.history'),
      models: unary('session.models'), selectModel: unary('session.selectModel'), rename: unary('session.rename'), fork: unary('session.fork'),
      prompt: unary('session.prompt'), attachment: unary('session.attachment'), updateQueue: unary('session.updateQueue'), cancel: unary('session.cancel'),
    },
    subagents: {
      list: unary('subagent.list'), history: unary('subagent.history'), prompt: unary('subagent.prompt'), interrupt: unary('subagent.interrupt'),
    },
    host: {
      describe: unary('host.describe'), pickDirectory: unary('host.pickDirectory'), listDirectory: unary('host.listDirectory'),
      createDirectory: unary('host.createDirectory'), openPath: unary('host.openPath'),
    },
    workspace: {
      list: unary('workspace.list'), create: unary('workspace.create'), rename: unary('workspace.rename'), delete: unary('workspace.delete'),
      insertBefore: unary('workspace.insertBefore'), insertSessionBefore: unary('workspace.insertSessionBefore'), archiveSession: unary('workspace.archiveSession'),
    },
    skills: { list: unary('skill.list') },
    agentPresets: {
      list: unary('agentPreset.list'), select: unary('agentPreset.select'), read: unary('agentPreset.read'), copy: unary('agentPreset.copy'),
      openDocument: unary('agentPreset.openDocument'), remove: unary('agentPreset.remove'),
    },
    goals: {
      create: unary('goal.create'), edit: unary('goal.edit'), pause: unary('goal.pause'), resume: unary('goal.resume'),
      complete: unary('goal.complete'), clear: unary('goal.clear'),
    },
    settings: {
      describe: unary('settings.describe'), openDocument: unary('settings.openDocument'), update: unary('settings.update'),
      replace: unary('settings.replace'), mutate: unary('settings.mutate'),
    },
    credentials: { describe: unary('credentials.describe'), set: unary('credentials.set'), unset: unary('credentials.unset') },
    llm: { providers: unary('llm.providers'), models: unary('llm.models'), discoverModels: unary('llm.discoverModels') },
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
    assertUnaryRequest(input, init)
    const request: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      redirect: 'error',
    }
    if (init?.body !== undefined) request.body = init.body
    if (init?.signal !== undefined && init.signal !== null) request.signal = init.signal
    return globalThis.fetch(new URL(input.pathname, LOOPBACK_ORIGIN), request)
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
    if (!EVENTS_PATHS.has(path)) throw new Error('Loopback WebSocket path is not allowed')
    const socket = new WebSocket(`ws://${LOOPBACK_HOST}:${LOOPBACK_PORT}${path}`, {
      maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
    })
    const inbox: Array<RpcRequest<F> | undefined> = []
    let wake: (() => void) | undefined
    const enqueue = (value: RpcRequest<F> | undefined): void => { inbox.push(value); wake?.(); wake = undefined }
    const close = (): void => enqueue(undefined)
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
    if (!settled) {
      deadline = setTimeout(() => {
        forceTerminate()
        finish()
      }, 1_000)
      deadline.unref()
    }
  })
}

function assertUnaryRequest(input: URL, init: RequestInit | undefined): void {
  if (input.protocol !== 'http:' || input.hostname !== LOOPBACK_HOST || input.port !== LOOPBACK_PORT
    || input.username !== '' || input.password !== '' || input.search !== '' || input.hash !== '') {
    throw new Error('Loopback API carrier rejected a non-canonical URL')
  }
  if (init?.method !== 'POST' || (input.pathname !== '/api/respond' && !API_METHOD_PATH.test(input.pathname))) {
    throw new Error('Loopback API carrier rejected an unexpected request')
  }
}
