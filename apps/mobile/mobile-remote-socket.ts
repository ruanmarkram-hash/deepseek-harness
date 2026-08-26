/**
 * Fixed React Native WebSocket carrier for one V3 device relay connection.
 *
 * It authenticates the WebSocket upgrade with the device role token, but does
 * not parse a relay flight or expose a trusted connection.
 */

import { MAX_REMOTE_RELAY_CIPHERTEXT_BYTES, type RemoteRelaySocket } from '@deepseek-ai/dsh-remote-relay-protocol'
import type { MobileRemoteConnectionConfig, MobileRemoteSocketFactory } from './remote'

const RELAY_ORIGIN = 'wss://dshrelay.rulabs.dev'
const RELAY_PROTOCOL = 'dsh-remote-v3'
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{32,256}$/
const MAX_RELAY_TEXT_FRAME_BYTES = Math.ceil(MAX_REMOTE_RELAY_CIPHERTEXT_BYTES * 4 / 3) + 4_096
const MAX_PENDING_RELAY_FRAMES = 4
const SOCKET_OPEN = 1
const SOCKET_CLOSED = 3

interface MobileSocketEvent {
  readonly data: unknown
}

interface MobileCloseEvent {
  readonly code?: number
}

/** React Native's small WebSocket surface used by the production carrier. */
export interface MobileNativeWebSocket {
  readonly readyState: number
  onclose: ((event: MobileCloseEvent) => void) | null
  onerror: (() => void) | null
  onmessage: ((event: MobileSocketEvent) => void) | null
  onopen: (() => void) | null
  close(code?: number, reason?: string): void
  send(data: string): void
}

/** Creates a React Native WebSocket without exposing a mutable relay destination. */
export type MobileNativeWebSocketFactory = (url: string, protocols: readonly string[]) => MobileNativeWebSocket

/**
 * Production carrier for the deployed DSH V3 device endpoint.
 *
 * The bearer exists only in the role-bound WebSocket subprotocol. It is never
 * encoded into the URL or included in a thrown error.
 */
export class ReactNativeMobileRemoteSocketFactory implements MobileRemoteSocketFactory {
  constructor(
    private readonly webSocket: MobileNativeWebSocketFactory = (url, protocols) => new WebSocket(url, [...protocols]) as unknown as MobileNativeWebSocket,
  ) {}

  /** @param config - Validated invitation route material. @param abortSignal - Cancels only this opening attempt. */
  create(config: MobileRemoteConnectionConfig, abortSignal: AbortSignal): Promise<RemoteRelaySocket> {
    const routeId = relayRouteId(config.routeId)
    const clientToken = deviceToken(config.clientAuthToken)
    if (abortSignal.aborted) return Promise.reject(cancelled())
    let socket: MobileNativeWebSocket
    try {
      socket = this.webSocket(relayUrl(routeId), [RELAY_PROTOCOL, 'dsh-device.' + clientToken])
    } catch {
      return Promise.reject(new Error('Could not open the DSH relay connection'))
    }
    return openSocket(socket, abortSignal)
  }
}

/** Production factory for the fixed React Native V3 device carrier. */
export const mobileRemoteSocketFactory = new ReactNativeMobileRemoteSocketFactory()

function relayRouteId(value: string): string {
  if (!ROUTE_ID.test(value)) throw new Error('The DSH relay route is invalid')
  return value
}

function deviceToken(value: string): string {
  if (!DEVICE_TOKEN.test(value)) throw new Error('The DSH relay device credential is invalid')
  return value
}

function relayUrl(routeId: string): string {
  return RELAY_ORIGIN + '/v3/routes/' + encodeURIComponent(routeId) + '/connect'
}

function cancelled(): Error {
  return new Error('DSH relay connection cancelled')
}

function openSocket(socket: MobileNativeWebSocket, signal: AbortSignal): Promise<RemoteRelaySocket> {
  return new Promise((resolve, reject) => {
    let settled = false
    let onOpen: (() => void) | undefined
    let onError: (() => void) | undefined
    let onClose: ((event: MobileCloseEvent) => void) | undefined
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort)
      if (socket.onopen === onOpen) socket.onopen = null
      if (socket.onerror === onError) socket.onerror = null
      if (socket.onclose === onClose) socket.onclose = null
    }
    const settle = (value: RemoteRelaySocket | Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (value instanceof Error) reject(value)
      else resolve(value)
    }
    const abort = (): void => {
      settle(cancelled())
      safeClose(socket, 1000)
    }
    onOpen = () => {
      if (signal.aborted) return abort()
      settle(new ReactNativeRemoteRelaySocket(socket))
    }
    onError = () => {
      safeClose(socket, 1011)
      settle(new Error('Could not open the DSH relay connection'))
    }
    onClose = () => settle(new Error('Could not open the DSH relay connection'))
    socket.onopen = onOpen
    socket.onerror = onError
    socket.onclose = onClose
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else if (socket.readyState === SOCKET_OPEN) socket.onopen?.()
    else if (socket.readyState === SOCKET_CLOSED) socket.onclose?.({})
  })
}

class ReactNativeRemoteRelaySocket implements RemoteRelaySocket {
  private readonly pending: string[] = []
  private readonly waiters = new Set<PendingReceive>()
  private closed = false

  constructor(private readonly socket: MobileNativeWebSocket) {
    socket.onmessage = event => this.receiveMessage(event.data)
    socket.onerror = () => this.finish(1011)
    socket.onclose = () => this.finish()
  }

  send(data: string): void {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) throw new Error('DSH relay connection is closed')
    if (!relayTextFrame(data)) {
      this.finish(1009)
      throw new Error('DSH relay frame exceeds its supported size')
    }
    try {
      this.socket.send(data)
    } catch {
      this.finish(1011)
      throw new Error('Could not send a DSH relay frame')
    }
  }

  close(code = 1000, _reason?: string): void {
    this.finish(code)
  }

  async *receive(signal?: AbortSignal): AsyncIterable<string> {
    for (;;) {
      const value = await this.next(signal)
      if (value === undefined) return
      yield value
    }
  }

  private receiveMessage(value: unknown): void {
    if (this.closed) return
    if (typeof value !== 'string' || !relayTextFrame(value) || this.pending.length >= MAX_PENDING_RELAY_FRAMES) {
      this.finish(1009)
      return
    }
    const waiter = this.waiters.values().next().value as PendingReceive | undefined
    if (waiter !== undefined) {
      this.waiters.delete(waiter)
      waiter.resolve(value)
      return
    }
    this.pending.push(value)
  }

  private next(signal: AbortSignal | undefined): Promise<string | undefined> {
    if (signal?.aborted) {
      this.finish(1000)
      return Promise.resolve(undefined)
    }
    const value = this.pending.shift()
    if (value !== undefined) return Promise.resolve(value)
    if (this.closed) return Promise.resolve(undefined)
    return new Promise(resolve => {
      const abort = (): void => {
        this.waiters.delete(waiter)
        signal?.removeEventListener('abort', abort)
        this.finish(1000)
        resolve(undefined)
      }
      const waiter: PendingReceive = {
        resolve: value => {
          signal?.removeEventListener('abort', abort)
          resolve(value)
        },
      }
      this.waiters.add(waiter)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }

  private finish(code?: number): void {
    if (this.closed) return
    this.closed = true
    this.pending.length = 0
    safeClose(this.socket, code)
    for (const waiter of this.waiters) waiter.resolve(undefined)
    this.waiters.clear()
  }
}

interface PendingReceive {
  readonly resolve: (value: string | undefined) => void
}

function relayTextFrame(value: string): boolean {
  return value.length <= MAX_RELAY_TEXT_FRAME_BYTES && new TextEncoder().encode(value).byteLength <= MAX_RELAY_TEXT_FRAME_BYTES
}

function safeClose(socket: MobileNativeWebSocket, code?: number): void {
  if (socket.readyState === SOCKET_CLOSED) return
  try { socket.close(code, 'dsh-mobile-closed') } catch { /* WebSocket teardown is best effort. */ }
}
