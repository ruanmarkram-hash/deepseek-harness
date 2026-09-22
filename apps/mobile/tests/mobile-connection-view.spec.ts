import { describe, expect, it } from 'vitest'
import { mobileConnectionView } from '../mobile-connection-view'

describe('mobile connection action presentation', () => {
  it('keeps connection progress, failures and retries visible in both sheets', () => {
    expect(mobileConnectionView({ kind: 'connecting' }).disabled).toBe(true)
    expect(mobileConnectionView({ kind: 'connected', connectionEpoch: 1 }).disabled).toBe(true)
    expect(mobileConnectionView({ kind: 'error', message: 'The connection timed out.' })).toEqual({ disabled: false, label: 'Retry connection', message: 'The connection timed out.' })
    expect(mobileConnectionView({ kind: 'reconnecting', reason: 'network' }).label).toBe('Retry connection')
    expect(mobileConnectionView({ kind: 're-pair-required' }).label).toBe('Manage pairing')
    expect(mobileConnectionView({ kind: 'revoked' }).disabled).toBe(true)
    expect(mobileConnectionView({ kind: 'disconnected' }).label).toBe('Connect to Host')
    expect(mobileConnectionView({ kind: 'unconfigured' }).label).toBe('Connect to Host')
  })
})
