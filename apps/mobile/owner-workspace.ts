/** Host-derived mobile workspace projection. It keeps no synthetic or preview sessions. */

import type { RemoteWireEventEnvelope, RemoteWireJson } from '@deepseek-ai/dsh-remote-wire'

/** One text message safely projected from a Host session event. */
export interface OwnerMessage {
  readonly id: string
  readonly role: 'assistant' | 'user'
  readonly text: string
}

/** One Host-approved action card. Its body remains Host-owned. */
export interface OwnerToolCard {
  readonly id: string
  readonly label: string
  readonly kind: 'diff' | 'file' | 'terminal' | 'tool'
}

/** One current Host approval waiting for the device owner. */
export interface OwnerApproval {
  readonly approvalId: string
  readonly reason: string | undefined
  readonly requestId: string
  readonly sessionId: string
  readonly toolName: string
}

/** One live session summary projected from the Host public event/API vocabulary. */
export interface OwnerSession {
  readonly id: string
  readonly messages: readonly OwnerMessage[]
  readonly running: boolean
  readonly title: string
  readonly tools: readonly OwnerToolCard[]
}

/** Ephemeral view state. A reconnect repopulates it only from the Host. */
export interface OwnerWorkspace {
  readonly approvals: readonly OwnerApproval[]
  readonly selectedSessionId: string | undefined
  readonly sessions: readonly OwnerSession[]
}

export const EMPTY_OWNER_WORKSPACE: OwnerWorkspace = { approvals: [], selectedSessionId: undefined, sessions: [] }

function record(value: RemoteWireJson): Record<string, RemoteWireJson> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, RemoteWireJson>
    : undefined
}

function text(value: RemoteWireJson | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function titleFor(id: string): string {
  return `Session ${id.slice(-6)}`
}

function upsertSession(workspace: OwnerWorkspace, next: OwnerSession): OwnerWorkspace {
  const existing = workspace.sessions.find(session => session.id === next.id)
  const sessions = existing === undefined
    ? [next, ...workspace.sessions]
    : workspace.sessions.map(session => session.id === next.id ? next : session)
  return { ...workspace, selectedSessionId: workspace.selectedSessionId ?? next.id, sessions }
}

function ensureSession(workspace: OwnerWorkspace, id: string): OwnerWorkspace {
  const existing = workspace.sessions.find(session => session.id === id)
  return existing === undefined
    ? upsertSession(workspace, { id, messages: [], running: false, title: titleFor(id), tools: [] })
    : workspace
}

/** Fold a `session.list` value returned through V3 into a truthful empty-or-live sidebar. */
export function applyOwnerSessionList(workspace: OwnerWorkspace, value: RemoteWireJson): OwnerWorkspace {
  const items = record(value)?.items
  if (!Array.isArray(items)) return workspace
  const sessions = items.flatMap((item) => {
    const row = record(item)
    if (row === undefined) return []
    const id = text(row.sessionId)
    if (id === undefined) return []
    return [{
      id,
      messages: workspace.sessions.find(session => session.id === id)?.messages ?? [],
      running: row.running === true,
      title: titleFor(id),
      tools: workspace.sessions.find(session => session.id === id)?.tools ?? [],
    }]
  })
  const selectedSessionId = sessions.some(session => session.id === workspace.selectedSessionId)
    ? workspace.selectedSessionId
    : sessions[0]?.id
  return { ...workspace, selectedSessionId, sessions }
}

/** Replace an expired local projection with the Host synchronization snapshot. */
export function replaceOwnerWorkspaceSnapshot(value: RemoteWireJson): OwnerWorkspace {
  const snapshot = record(value)
  const sessions = snapshot?.sessions
  return applyOwnerSessionList(EMPTY_OWNER_WORKSPACE, sessions ?? value)
}

/** Fold one strict V3 host event into the ephemeral mobile workspace projection. */
export function applyOwnerEvent(workspace: OwnerWorkspace, envelope: RemoteWireEventEnvelope): OwnerWorkspace {
  const payload = record(envelope.payload)
  if (payload === undefined) return workspace
  if (envelope.event === 'host/session-added') {
    const id = text(payload.sessionId)
    return id === undefined ? workspace : ensureSession(workspace, id)
  }
  if (envelope.event === 'host/session-removed') {
    const id = text(payload.sessionId)
    if (id === undefined) return workspace
    const sessions = workspace.sessions.filter(session => session.id !== id)
    return { ...workspace, selectedSessionId: workspace.selectedSessionId === id ? sessions[0]?.id : workspace.selectedSessionId, sessions }
  }
  if (envelope.event === 'host/session-status') {
    const id = text(payload.sessionId)
    if (id === undefined || typeof payload.running !== 'boolean') return workspace
    const running = payload.running
    const withSession = ensureSession(workspace, id)
    return { ...withSession, sessions: withSession.sessions.map(session => session.id === id ? { ...session, running } : session) }
  }
  if (envelope.event === 'approval/requested') {
    const sessionId = text(payload.sessionId)
    const approvalId = text(payload.approvalId)
    const toolName = text(payload.toolName)
    if (sessionId === undefined || approvalId === undefined || toolName === undefined) return workspace
    const approval: OwnerApproval = { approvalId, requestId: envelope.requestId, reason: text(payload.reason), sessionId, toolName }
    return { ...workspace, approvals: [...workspace.approvals.filter(item => item.approvalId !== approvalId), approval] }
  }
  if (envelope.event === 'approval/resolved') {
    const approvalId = text(payload.approvalId)
    return approvalId === undefined
      ? workspace
      : { ...workspace, approvals: workspace.approvals.filter(item => item.approvalId !== approvalId) }
  }
  if (envelope.event !== 'session/event') return workspace
  const sessionId = text(payload.sessionId)
  const event = record(payload.event)
  if (sessionId === undefined || event === undefined) return workspace
  const data = record(event.data)
  const messageText = data === undefined ? undefined : text(data.text)
  const role = data?.role
  const view = record(payload.view)
  const card = view === undefined ? undefined : text(view.card)
  const withSession = ensureSession(workspace, sessionId)
  return {
    ...withSession,
    sessions: withSession.sessions.map((session) => {
      if (session.id !== sessionId) return session
      const messages: readonly OwnerMessage[] = messageText === undefined || (role !== 'assistant' && role !== 'user')
        ? session.messages
        : [...session.messages, { id: `${envelope.eventId}:${session.messages.length}`, role, text: messageText }]
      const tools: readonly OwnerToolCard[] = card === undefined
        ? session.tools
        : [...session.tools, { id: envelope.eventId, label: card, kind: card === 'diff' ? 'diff' : card === 'terminal' ? 'terminal' : card === 'file' ? 'file' : 'tool' }]
      return { ...session, messages, tools }
    }),
  }
}
