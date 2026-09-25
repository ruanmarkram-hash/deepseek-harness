/** Dependency-closed fixed DSH core for the signed Host runtime. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApiProxy } from '../../../packages/mobile/remote-api/src/api/index.ts'
import type { ClientResponse, RpcId, RpcReceipt, RpcResponse } from '../../../packages/mobile/remote-api/src/api/rpc.ts'
import { SessionId } from '../../../packages/core/session/src/types.ts'
import { unavailableApi } from './unavailable-api.ts'
import type { MuxFrame } from '../../../packages/mobile/remote-api/src/api/events.ts'
import type { SealedDshServiceCore, SealedDshStorage } from './sealed-dsh-service-graph.ts'
import type {
  NativeProtectedModelOperation,
  ProtectedModelApprovalRequest,
  ProtectedModelInteractions,
  ProtectedModelQuestionRequest,
} from './native-protected-model-operation.ts'

const STATE_VERSION = 1
const MAX_STATE_BYTES = 8 * 1024 * 1024
const MAX_SESSIONS = 1_024
const MAX_EVENTS_PER_SESSION = 4_096
const MAX_TEXT_BYTES = 64 * 1024
const MODEL_OPERATION_TIMEOUT_MS = 60_000
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/

interface StoredEvent { readonly seq: number; readonly type: 'user/message' | 'assistant/message'; readonly time: number; readonly data: Record<string, unknown> }
interface StoredSession { readonly sessionId: string; readonly createdAt: number; readonly updatedAt: number; readonly events: readonly StoredEvent[] }
interface StoredState { readonly version: typeof STATE_VERSION; readonly sessions: Record<string, StoredSession> }
interface PendingApproval { readonly sessionId: string; readonly approvalId: string; resolve(value: 'allowed-once' | 'rejected'): void }
interface PendingQuestion { readonly sessionId: string; resolve(value: unknown): void }

/** Closed error used by the static core's bounded durable store. */
export class SealedDshServiceCoreError extends Error {
  constructor() { super('sealed DSH service core is unavailable'); this.name = 'SealedDshServiceCoreError' }
}

/** Creates a fixed core over a Keychain-only native model operation. */
export function createSealedDshServiceCore(operation: NativeProtectedModelOperation): SealedDshServiceCore {
  if (operation.capability !== 'signed-host-keychain-model-operation-v1' || !validModel(operation.model)) {
    throw new SealedDshServiceCoreError()
  }
  let runtime: FixedCoreRuntime | undefined
  return {
    composition: 'dsh-sealed-host-core-v1',
    async createApiProxy(storage) {
      if (runtime !== undefined) throw new SealedDshServiceCoreError()
      runtime = await FixedCoreRuntime.open(storage, operation)
      return runtime.api()
    },
    async dispose() { await runtime?.dispose(); runtime = undefined },
  }
}

class FixedCoreRuntime {
  private readonly events = new EventQueue()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly abort = new AbortController()
  private readonly completions = new Set<Promise<void>>()
  private state: StoredState
  private writes = Promise.resolve()
  private stopped = false

  private constructor(private readonly filename: string, private readonly operation: NativeProtectedModelOperation, state: StoredState) { this.state = state }

  static async open(storage: SealedDshStorage, operation: NativeProtectedModelOperation): Promise<FixedCoreRuntime> {
    try {
      await mkdir(storage.sessionsRoot, { recursive: true, mode: 0o700 })
      const filename = join(storage.sessionsRoot, 'sealed-sessions.json')
      let state: StoredState
      try {
        const content = await readFile(filename)
        if (content.byteLength > MAX_STATE_BYTES) throw new SealedDshServiceCoreError()
        state = parseState(content.toString('utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        state = { version: STATE_VERSION, sessions: Object.create(null) as Record<string, StoredSession> }
        await persist(filename, state)
      }
      return new FixedCoreRuntime(filename, operation, state)
    } catch {
      throw new SealedDshServiceCoreError()
    }
  }

  api(): ApiProxy {
    const defaults = unavailableApi()
    const ok = <T>(rpcId: RpcId, value: T): RpcResponse<T> => ({ rpcId, result: { ok: true, value } })
    const missing = (rpcId: RpcId, sessionId: string): RpcResponse<never> => ({ rpcId, result: { ok: false, error: { code: 'session-not-found', message: 'session not found', details: { sessionId: SessionId(sessionId) } } } })
    return {
      ...defaults,
      sessions: {
        ...defaults.sessions,
        list: async request => ok(request.rpcId, { items: Object.values(this.state.sessions).map(session => ({ sessionId: SessionId(session.sessionId), updatedAt: session.updatedAt, running: false, blank: session.events.length === 0 })) }),
        create: async request => {
          const requested = request.payload.sessionId
          const sessionId = requested ?? SessionId(`session-${randomUUID()}`)
          if (!SESSION_ID.test(sessionId)) return missing(request.rpcId, sessionId)
          await this.update(state => {
            if (state.sessions[sessionId] !== undefined) return state
            if (Object.keys(state.sessions).length >= MAX_SESSIONS) throw new SealedDshServiceCoreError()
            const now = Date.now()
            return { ...state, sessions: { ...state.sessions, [sessionId]: { sessionId, createdAt: now, updatedAt: now, events: [] } } }
          })
          return ok(request.rpcId, { sessionId })
        },
        history: async request => {
          const payload = request.payload
          const session = this.state.sessions[payload.sessionId]
          if (session === undefined) return missing(request.rpcId, payload.sessionId)
          const before = payload.beforeSeq ?? session.events.length
          const maximum = Math.min(payload.maxMessages ?? 50, 100)
          const events = session.events.filter(event => event.seq < before).slice(-maximum).map(event => ({ event }))
          return ok(request.rpcId, { events, hasMore: events.length < session.events.filter(event => event.seq < before).length })
        },
        prompt: async request => this.prompt(request, ok, missing),
      },
      events: {
        mux: (_request, signal) => this.events.read(signal),
        host: async function* () {},
      },
      respond: async message => this.respond(message),
    }
  }

  private async prompt(
    request: Parameters<ApiProxy['sessions']['prompt']>[0],
    ok: <T>(rpcId: RpcId, value: T) => RpcResponse<T>,
    missing: (rpcId: RpcId, sessionId: string) => RpcResponse<never>,
  ): ReturnType<ApiProxy['sessions']['prompt']> {
    const session = this.state.sessions[request.payload.sessionId]
    if (session === undefined) return missing(request.rpcId, request.payload.sessionId)
    if (!Array.isArray(request.payload.content) || request.payload.content.length === 0 || request.payload.content.some(part => part.type !== 'text' || typeof part.text !== 'string')) {
      return { rpcId: request.rpcId, result: { ok: false, error: { code: 'attachment-error', message: 'only text prompts are available on the sealed Host', details: { reason: 'TEXT_ONLY' } } } }
    }
    const text = request.payload.content.map(part => part.type === 'text' ? part.text : '').join('')
    if (Buffer.byteLength(text) === 0 || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new SealedDshServiceCoreError()
    const event = await this.append(session.sessionId, 'user/message', { id: `message-${randomUUID()}`, content: [{ type: 'text', text }], source: { kind: 'user', rpcId: request.rpcId } })
    this.events.push({ rpcId: randomUUID(), payload: { type: 'session/event', sessionId: session.sessionId, event } })
    this.startCompletion(session.sessionId, text)
    return ok(request.rpcId, { accepted: true as const })
  }

  private startCompletion(sessionId: string, text: string): void {
    const completion = this.complete(sessionId, text)
    this.completions.add(completion)
    void completion.finally(() => { this.completions.delete(completion) })
  }

  private async complete(sessionId: string, text: string): Promise<void> {
    const deadline = new AbortController()
    const forwardAbort = (): void => deadline.abort()
    this.abort.signal.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(() => deadline.abort(), MODEL_OPERATION_TIMEOUT_MS)
    try {
      const completion = await this.operation.complete({ sessionId, model: this.operation.model, text }, this.interactions(sessionId), deadline.signal)
      if (this.stopped || Buffer.byteLength(completion.text) > MAX_TEXT_BYTES) return
      const event = await this.append(sessionId, 'assistant/message', { id: `message-${randomUUID()}`, content: [{ type: 'text', text: completion.text }] })
      this.events.push({ rpcId: randomUUID(), payload: { type: 'session/event', sessionId, event } })
    } catch {
      if (!this.stopped) this.events.push({ rpcId: randomUUID(), payload: { type: 'stream/error', error: { code: 'internal', message: 'the protected model operation failed', details: {} } } })
    } finally {
      clearTimeout(timeout)
      this.abort.signal.removeEventListener('abort', forwardAbort)
    }
  }

  private interactions(sessionId: string): ProtectedModelInteractions {
    return {
      requestApproval: request => this.requestApproval(sessionId, request),
      requestQuestion: request => this.requestQuestion(sessionId, request),
    }
  }

  private requestApproval(sessionId: string, request: ProtectedModelApprovalRequest): Promise<'allowed-once' | 'rejected'> {
    if (request.sessionId !== sessionId || !validTool(request.toolName) || (request.reason !== undefined && Buffer.byteLength(request.reason) > 4_096)) return Promise.reject(new SealedDshServiceCoreError())
    const rpcId = randomUUID(); const approvalId = `approval-${randomUUID()}`
    return new Promise(resolve => { this.pendingApprovals.set(rpcId, { sessionId, approvalId, resolve }); this.events.push({ rpcId, payload: { type: 'approval/requested', sessionId, approvalId, toolName: request.toolName, ...(request.reason === undefined ? {} : { reason: request.reason }) } }) })
  }

  private requestQuestion(sessionId: string, request: ProtectedModelQuestionRequest): Promise<unknown> {
    if (request.sessionId !== sessionId || !Array.isArray(request.questions) || request.questions.length === 0 || request.questions.length > 8 || request.questions.some(question => !validQuestion(question))) return Promise.reject(new SealedDshServiceCoreError())
    const rpcId = randomUUID()
    return new Promise(resolve => { this.pendingQuestions.set(rpcId, { sessionId, resolve }); this.events.push({ rpcId, payload: { type: 'question/requested', sessionId, questions: request.questions } }) })
  }

  private async respond(message: ClientResponse): Promise<RpcReceipt> {
    if (message.type !== 'client-response') return { accepted: false, reason: 'bad-response' }
    const approval = this.pendingApprovals.get(message.rpcId)
    if (approval !== undefined) {
      const value = message.result.ok ? message.result.value as Record<string, unknown> : undefined
      if (value?.sessionId !== approval.sessionId || value.approvalId !== approval.approvalId || (value.outcome !== 'allowed-once' && value.outcome !== 'rejected')) return { accepted: false, reason: 'bad-response' }
      this.pendingApprovals.delete(message.rpcId); approval.resolve(value.outcome); return { accepted: true }
    }
    const question = this.pendingQuestions.get(message.rpcId)
    if (question !== undefined) {
      const value = message.result.ok ? message.result.value as Record<string, unknown> : undefined
      if (value?.sessionId !== question.sessionId || !Object.hasOwn(value, 'answer')) return { accepted: false, reason: 'bad-response' }
      this.pendingQuestions.delete(message.rpcId); question.resolve(value.answer); return { accepted: true }
    }
    return { accepted: false, reason: 'not-pending' }
  }

  private async append(sessionId: string, type: StoredEvent['type'], data: Record<string, unknown>): Promise<StoredEvent> {
    let emitted: StoredEvent | undefined
    await this.update(state => {
      const session = state.sessions[sessionId]
      if (session === undefined || session.events.length >= MAX_EVENTS_PER_SESSION) throw new SealedDshServiceCoreError()
      emitted = { seq: session.events.length, type, time: Date.now(), data }
      return { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, updatedAt: emitted.time, events: [...session.events, emitted] } } }
    })
    return emitted!
  }

  private async update(mutator: (state: StoredState) => StoredState): Promise<void> {
    const task = this.writes.then(async () => { const next = mutator(this.state); await persist(this.filename, next); this.state = next })
    this.writes = task.then(() => undefined, () => undefined)
    await task
  }

  async dispose(): Promise<void> {
    if (this.stopped) return
    this.stopped = true; this.abort.abort(); this.events.close()
    for (const pending of this.pendingApprovals.values()) pending.resolve('rejected')
    for (const pending of this.pendingQuestions.values()) pending.resolve(undefined)
    this.pendingApprovals.clear(); this.pendingQuestions.clear()
    await Promise.allSettled([...this.completions])
    await this.writes
  }
}

class EventQueue {
  private readonly values: unknown[] = []; private notify: (() => void) | undefined; private ended = false
  push(value: unknown): void { if (this.values.length === 256) this.values.shift(); this.values.push(value); this.notify?.(); this.notify = undefined }
  close(): void { this.ended = true; this.notify?.(); this.notify = undefined }
  async *read(signal: AbortSignal): AsyncIterable<never> { while (!this.ended && !signal.aborted) { const value = this.values.shift(); if (value !== undefined) { yield value as never; continue } await new Promise<void>(resolve => { this.notify = resolve; signal.addEventListener('abort', () => { resolve() }, { once: true }) }) } }
}

async function persist(filename: string, state: StoredState): Promise<void> {
  const output = `${JSON.stringify(state)}\n`
  if (Buffer.byteLength(output) > MAX_STATE_BYTES) throw new SealedDshServiceCoreError()
  const temporary = `${filename}.${randomUUID()}.tmp`
  await writeFile(temporary, output, { flag: 'wx', mode: 0o600 }); await rename(temporary, filename)
}

function parseState(input: string): StoredState {
  let state: unknown; try { state = JSON.parse(input) } catch { throw new SealedDshServiceCoreError() }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new SealedDshServiceCoreError()
  const result = state as Partial<StoredState>
  if (result.version !== STATE_VERSION || result.sessions === null || typeof result.sessions !== 'object' || Array.isArray(result.sessions) || Object.keys(result.sessions).length > MAX_SESSIONS) throw new SealedDshServiceCoreError()
  return result as StoredState
}
function validModel(value: { readonly provider: string; readonly model: string }): boolean { return validToken(value.provider) && validToken(value.model) }
function validTool(value: string): boolean { return validToken(value) }
function validToken(value: string): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._/-]+$/.test(value) }
function validQuestion(value: { readonly id: string; readonly question: string }): boolean { return validToken(value.id) && typeof value.question === 'string' && value.question.length > 0 && Buffer.byteLength(value.question) <= 4_096 }
