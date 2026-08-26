import { describe, expect, it } from 'vitest'
import type { RemoteWireEventEnvelope, RemoteWireId } from '@deepseek-ai/dsh-remote-wire'
import { EMPTY_OWNER_WORKSPACE, applyOwnerEvent, applyOwnerSessionList, replaceOwnerWorkspaceSnapshot } from '../owner-workspace'

const envelope = (event: 'host/session-added' | 'approval/requested' | 'host/session-status'): RemoteWireEventEnvelope => ({ version: 3, type: 'event', connectionEpoch: 1, cursor: 1, eventId: 'eventxxxxxxxxxxx' as RemoteWireId, requestId: 'requestxxxxxxxxx' as RemoteWireId, event: event, payload: event === 'host/session-added' ? { sessionId: 'alpha' } : event === 'host/session-status' ? { sessionId: 'alpha', running: true } : { sessionId: 'alpha', approvalId: 'approvalxxxxxxxx', toolName: 'Bash' } })

describe('owner workspace projection', () => {
  it('renders only sessions supplied by the Host list', () => {
    expect(applyOwnerSessionList(EMPTY_OWNER_WORKSPACE, { items: [{ sessionId: 'alpha', running: false, blank: true }] }).sessions).toMatchObject([{ id: 'alpha', running: false }])
    expect(applyOwnerSessionList(EMPTY_OWNER_WORKSPACE, { items: [] }).sessions).toEqual([])
  })

  it('projects Host session state and approvals without fabricating a conversation', () => {
    const added = applyOwnerEvent(EMPTY_OWNER_WORKSPACE, envelope('host/session-added'))
    const running = applyOwnerEvent(added, envelope('host/session-status'))
    const approval = applyOwnerEvent(running, envelope('approval/requested'))
    expect(approval.sessions).toMatchObject([{ id: 'alpha', running: true, messages: [] }])
    expect(approval.approvals).toMatchObject([{ toolName: 'Bash', sessionId: 'alpha' }])
  })

  it('replaces the full projection from a Host restart snapshot', () => {
    const stale = applyOwnerEvent(EMPTY_OWNER_WORKSPACE, envelope('approval/requested'))
    const reset = replaceOwnerWorkspaceSnapshot({ sessions: { items: [{ sessionId: 'beta', running: true }] } })
    expect(reset).toMatchObject({ sessions: [{ id: 'beta', running: true, messages: [], tools: [] }], approvals: [] })
    expect(reset.sessions.some(session => session.id === 'alpha')).toBe(false)
    expect(stale.approvals).toHaveLength(1)
  })
})
