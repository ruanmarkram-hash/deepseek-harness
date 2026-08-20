import { randomUUID } from 'node:crypto'
import { localHarnessUrl } from './runtime-url.js'

const HISTORY_MAX_MESSAGES = 256

type LocalMethod = 'session.list' | 'session.history' | 'session.prompt'

interface RpcEnvelope {
  readonly type: 'server-response'
  readonly rpcId: string
  readonly result: { readonly ok: boolean; readonly value?: unknown }
}

/** The only desktop-local session reference kept outside the local DSH API. */
export interface LocalDesktopSession {
  readonly key: string
}

/**
 * Electron-main adapter for the small mobile surface. It does not accept a
 * caller supplied path, mode, attachment, event stream, or request body.
 */
export class LocalSessionApi {
  private readonly origin: URL
  private readonly request: typeof fetch

  /** Bind this adapter to the already verified loopback DSH runtime origin. */
  constructor(origin: URL, request: typeof fetch = globalThis.fetch) {
    this.origin = localHarnessUrl(origin.href)
    this.request = request
  }

  /** List existing desktop session identifiers for the native, local-only picker. */
  async listSessions(): Promise<readonly LocalDesktopSession[]> {
    const value = await this.call('session.list', {})
    if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('DSH Desktop could not read local sessions.')
    const sessions: LocalDesktopSession[] = []
    for (const item of value.items) {
      if (!isRecord(item) || typeof item.sessionId !== 'string' || !validSessionKey(item.sessionId)) continue
      sessions.push({ key: item.sessionId })
    }
    return sessions
  }

  /** Read the bounded event history for one native-picker-selected session only. */
  async history(session: LocalDesktopSession): Promise<unknown> {
    const value = await this.call('session.history', {
      sessionId: validSession(session).key,
      maxMessages: HISTORY_MAX_MESSAGES,
    })
    if (!isRecord(value) || !Array.isArray(value.events)) throw new Error('DSH Desktop could not read the selected session.')
    return value.events.map(entry => isRecord(entry) ? entry.event : undefined).filter(entry => entry !== undefined)
  }

  /** Submit plain text through DSH's literal queued-prompt operation. */
  async queueText(session: LocalDesktopSession, text: string): Promise<void> {
    const selected = validSession(session)
    if (typeof text !== 'string' || text.length === 0) throw new Error('DSH Desktop rejected the mobile prompt.')
    await this.call('session.prompt', {
      sessionId: selected.key,
      mode: 'queue',
      content: [{ type: 'text', text }],
    })
  }

  private async call(method: LocalMethod, payload: unknown): Promise<unknown> {
    const endpoint = new URL(`/api/${method}`, this.origin)
    let response: Response
    try {
      response = await this.request(endpoint, {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
      })
    } catch {
      throw new Error('DSH Desktop lost its local Harness connection.')
    }
    if (!response.ok) throw new Error('DSH Desktop local session request was rejected.')
    let envelope: unknown
    try {
      envelope = await response.json()
    } catch {
      throw new Error('DSH Desktop received an invalid local session response.')
    }
    if (!isEnvelope(envelope) || !envelope.result.ok) throw new Error('DSH Desktop local session request was rejected.')
    return envelope.result.value
  }
}

function validSession(value: LocalDesktopSession): LocalDesktopSession {
  if (!isRecord(value) || typeof value.key !== 'string' || !validSessionKey(value.key)) {
    throw new Error('DSH Desktop rejected the selected session.')
  }
  return { key: value.key }
}

function validSessionKey(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001F\u007F-\u009F]/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnvelope(value: unknown): value is RpcEnvelope {
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string' || !isRecord(value.result)) return false
  return typeof value.result.ok === 'boolean'
}
