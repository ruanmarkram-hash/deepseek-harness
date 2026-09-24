/** Released mobile events projected from current Session and shared Remote event owners. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { ClientResponse, HostFrame, MuxFrame, RpcReceipt, RpcRequest } from './api/index.ts'
import { RpcId } from './api/rpc.ts'
import { approvalResponsePayloadSchema } from './api/approvals.schema.ts'
import { questionResponsePayloadSchema } from './api/questions.schema.ts'

interface Pending {
  readonly clientId: string
  readonly eventId: string
  readonly sessionId: SessionId
  readonly event: 'approval/request' | 'user-questions/request'
  readonly request: Record<string, unknown>
  readonly queue: FrameQueue<RpcRequest<MuxFrame>>
}

const EMPTY: AsyncIterable<never> = { async *[Symbol.asyncIterator]() {} }
const signalForever = new AbortController().signal

/** One compatibility service; the Gateway retains sole ownership of pending human interactions. */
export class MobileEvents {
  private readonly pending = new Map<string, Map<string, Pending>>()
  constructor(private readonly ctx: Context) {}

  /**
   * Follow session changes and shared human interactions for one phone connection.
   * @param signal - Connection lifetime; abort removes listeners and pending deliveries.
   * @returns correlated released-protocol frames until the connection closes.
   */
  async *mux(signal: AbortSignal): AsyncGenerator<RpcRequest<MuxFrame>> {
    const queue = new FrameQueue<RpcRequest<MuxFrame>>()
    const lifetime = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal])
    const frame = (payload: MuxFrame): RpcRequest<MuxFrame> => ({ rpcId: RpcId(randomUUID()), payload })
    const dispose = this.ctx.on('session/event', (session, event) => {
      queue.push(frame({ type: 'session/event', sessionId: session.id, event: mobileEvent(event) }))
    })
    const created = this.ctx.on('session/created', (session) => {
      queue.push(frame({ type: 'session/subscribed', sessionId: session.id, lastSeq: session.seq - 1 }))
    })
    const projections = this.ctx.sessionProjections.onChanged((session, key, value, seq) => {
      queue.push(frame({ type: 'session/projection', sessionId: session.id, key, value, seq }))
    })
    for (const session of this.ctx.sessions.list()) queue.push(frame({ type: 'session/subscribed', sessionId: session.id, lastSeq: session.seq - 1 }))
    const pump = this.pumpInteractions(queue, combined).catch(() => {
      if (!combined.aborted) queue.push(frame({ type: 'stream/error', error: { code: 'internal', message: 'Host interaction stream unavailable', details: {} } }))
    })
    try { yield* queue.read(combined) }
    finally { lifetime.abort(); dispose(); created(); projections(); queue.close(); await pump }
  }

  /**
   * Follow Host session and workspace notifications for one phone connection.
   * @param signal - Connection lifetime; abort removes listeners and the workspace reader.
   * @returns correlated Host frames until the connection closes.
   */
  async *host(signal: AbortSignal): AsyncGenerator<RpcRequest<HostFrame>> {
    const queue = new FrameQueue<RpcRequest<HostFrame>>()
    const frame = (payload: HostFrame): void =>{  queue.push({ rpcId: RpcId(randomUUID()), payload }) }
    const dispose = [
      this.ctx.on('api-session/added', (row) =>{  frame({ type: 'host/session-added', sessionId: row.sessionId, blank: row.blank, ...(row.cwd === undefined ? {} : { cwd: row.cwd }), ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }), ...(row.origin === undefined ? {} : { origin: row.origin }) }) }),
      this.ctx.on('api-session/removed', (sessionId) =>{  frame({ type: 'host/session-removed', sessionId }) }),
      this.ctx.on('api-session/status', (sessionId, running) =>{  frame({ type: 'host/session-status', sessionId, running }) }),
      this.ctx.on('api-session/error', (sessionId, message) =>{  frame({ type: 'host/agent-error', sessionId, message }) }),
    ]
    const lifetime = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal])
    const pump = (async () => {
      for await (const item of this.ctx.workspaceController.follow(combined)) {
        switch (item.type) {
          case 'baseline': break
          case 'upsert': frame({ type: 'host/workspace-changed', workspace: { ...item.workspace, sessionIds: [...item.workspace.sessionIds] } }); break
          case 'remove': frame({ type: 'host/workspace-removed', workspaceId: item.workspaceId }); break
          case 'order': frame({ type: 'host/workspace-order-changed', workspaceIds: [...item.workspaceIds] }); break
          case 'archived': frame({ type: 'host/archived-sessions-changed', archivedSessionIds: [...item.archivedSessionIds] }); break
          default: break
        }
      }
    })().catch(() => { if (!combined.aborted) frame({ type: 'stream/error', error: { code: 'internal', message: 'Workspace event stream unavailable', details: {} } }) })
    try { yield* queue.read(combined) }
    finally { lifetime.abort(); for (const stop of dispose) stop(); queue.close(); await pump }
  }

  /**
   * Validate the released audit correlation before returning the result to its shared Gateway owner.
   * @param message - Phone response carrying the original interaction identity.
   * @returns a receipt rejecting stale or mismatched responses without settling the interaction.
   */
  async respond(message: ClientResponse): Promise<RpcReceipt> {
    const deliveries = this.pending.get(message.rpcId)
    const pending = deliveries?.values().next().value
    if (pending === undefined) return { accepted: false, reason: 'not-pending' }
    let outcome: object
    let resolved: MuxFrame
    if (pending.event === 'approval/request') {
      if (!message.result.ok) return { accepted: false, reason: 'bad-response' }
      const parsed = approvalResponsePayloadSchema.safeParse(message.result.value)
      if (!parsed.success || parsed.data.sessionId !== pending.sessionId || parsed.data.approvalId !== pending.eventId) return { accepted: false, reason: 'bad-response' }
      outcome = { kind: 'result', value: parsed.data.outcome }
      resolved = { type: 'approval/resolved', sessionId: pending.sessionId, approvalId: ApprovalRequestId(pending.eventId), outcome: parsed.data.outcome }
    } else if (!message.result.ok) {
      if (message.result.error.code !== 'cancelled') return { accepted: false, reason: 'bad-response' }
      outcome = { kind: 'rejected', error: { name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' } }
      resolved = { type: 'question/resolved', sessionId: pending.sessionId, questionRpcId: RpcId(pending.eventId), outcome: 'cancelled' }
    } else {
      const parsed = questionResponsePayloadSchema.safeParse(message.result.value)
      if (!parsed.success || parsed.data.sessionId !== pending.sessionId) return { accepted: false, reason: 'bad-response' }
      outcome = { kind: 'result', value: parsed.data.answer }
      resolved = { type: 'question/resolved', sessionId: pending.sessionId, questionRpcId: RpcId(pending.eventId), outcome: 'answered' }
    }
    const result = await this.ctx.typertGateway.wireRpc('$events/result', { args: { clientId: pending.clientId, eventId: pending.eventId, outcome } }, signalForever)
    if (!result.ok) return { accepted: false, reason: 'not-pending' }
    pending.queue.push({ rpcId: RpcId(randomUUID()), payload: resolved })
    deliveries?.delete(pending.clientId)
    if (deliveries?.size === 0) this.pending.delete(message.rpcId)
    return { accepted: true }
  }

  private async pumpInteractions(queue: FrameQueue<RpcRequest<MuxFrame>>, signal: AbortSignal): Promise<void> {
    const source = await this.ctx.typertGateway.wireStream.open('$events', { args: {} }, EMPTY, undefined, signal)
    let clientId: string | undefined
    try {
      for await (const item of source) {
        if (!record(item)) throw new Error('invalid Host event')
        if (item.type === 'ready' && typeof item.clientId === 'string') { clientId = item.clientId; continue }
        if (item.type === 'cancel' && typeof item.eventId === 'string') {
          const pending = clientId === undefined ? undefined : this.pending.get(item.eventId)?.get(clientId)
          if (pending !== undefined) {
            this.pending.get(item.eventId)?.delete(pending.clientId)
            queue.push({ rpcId: RpcId(randomUUID()), payload: pending.event === 'approval/request'
              ? { type: 'approval/resolved', sessionId: pending.sessionId, approvalId: ApprovalRequestId(pending.eventId), outcome: 'cancelled' }
              : { type: 'question/resolved', sessionId: pending.sessionId, questionRpcId: RpcId(pending.eventId), outcome: 'cancelled' } })
          }
          continue
        }
        if (item.type !== 'waterfall') continue
        if (clientId === undefined || typeof item.eventId !== 'string' || typeof item.agentId !== 'string' || !record(item.request)) throw new Error('invalid Host interaction')
        if (item.event !== 'approval/request' && item.event !== 'user-questions/request') {
          await this.ctx.typertGateway.wireRpc('$events/result', { args: { clientId, eventId: item.eventId, outcome: { kind: 'next' } } }, signal)
          continue
        }
        const pending: Pending = { clientId, eventId: item.eventId, sessionId: item.agentId as SessionId,
          event: item.event, request: item.request, queue }
        let deliveries = this.pending.get(pending.eventId)
        if (deliveries === undefined) this.pending.set(pending.eventId, deliveries = new Map<string, Pending>())
        deliveries.set(clientId, pending)
        if (pending.event === 'approval/request') {
          if (typeof item.request.toolName !== 'string') throw new Error('invalid approval tool')
          queue.push({ rpcId: RpcId(pending.eventId), payload: { type: 'approval/requested', sessionId: pending.sessionId, approvalId: ApprovalRequestId(pending.eventId), toolName: item.request.toolName, ...(typeof item.request.reason === 'string' ? { reason: item.request.reason } : {}) } })
        } else {
          if (!Array.isArray(item.request.questions)) throw new Error('invalid question list')
          queue.push({ rpcId: RpcId(pending.eventId), payload: { type: 'question/requested', sessionId: pending.sessionId, questions: item.request.questions as AskUserQuestionItem[] } })
        }
      }
    } finally {
      if (clientId !== undefined) for (const [id, deliveries] of this.pending) {
        deliveries.delete(clientId)
        if (deliveries.size === 0) this.pending.delete(id)
      }
    }
  }
}

/** Build32 consumes flattened text fields; retain the current event and add that presentation. */
function mobileEvent(event: SessionEvent): SessionEvent {
  const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : undefined
  if (message === undefined) return event
  const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
  if (event.type === 'user/message') {
    const data = { ...event.data, text, role: 'user' as const }
    return { ...event, data }
  }
  if (event.type === 'assistant/message') {
    const data = { ...event.data, text, role: 'assistant' }
    return { ...event, data }
  }
  return event
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

class FrameQueue<T> {
  private readonly items: T[] = []
  private wake: (() => void) | undefined
  private closed = false
  push(value: T): void { if (!this.closed) { this.items.push(value); this.wake?.(); this.wake = undefined } }
  close(): void { this.closed = true; this.wake?.(); this.wake = undefined }
  async *read(signal: AbortSignal): AsyncGenerator<T> {
    const abort = (): void =>{  this.close() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        if (this.items.length > 0) { yield this.items.shift() as T; continue }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally { signal.removeEventListener('abort', abort) }
  }
}
