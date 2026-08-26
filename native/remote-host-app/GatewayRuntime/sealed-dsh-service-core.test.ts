/** Fixed sealed DSH core tests with a Keychain-operation fake. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSealedDshServiceCore } from './sealed-dsh-service-core.ts'
import type { NativeProtectedModelOperation } from './native-protected-model-operation.ts'

const SESSION = 'sealed_session_0001'

test('sealed core persists text sessions and routes a pending approval through the exact response rpc id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sealed-core-'))
  try {
    const operation: NativeProtectedModelOperation = {
      capability: 'signed-host-keychain-model-operation-v1',
      model: { provider: 'fixed-provider', model: 'fixed-model' },
      async complete(turn, interactions) {
        assert.equal(turn.sessionId, SESSION)
        assert.equal(await interactions.requestApproval({ sessionId: SESSION, toolName: 'write_file', reason: 'test' }), 'allowed-once')
        return { text: 'done' }
      },
    }
    const core = createSealedDshServiceCore(operation)
    const api = await core.createApiProxy({ root, sessionsRoot: join(root, 'sessions') })
    const created = await api.sessions.create({ rpcId: 'create_000000001', payload: { sessionId: SESSION } } as never)
    assert.deepEqual(created.result, { ok: true, value: { sessionId: SESSION } })
    const iterator = api.events.mux({ rpcId: 'mux_000000000001', payload: {} } as never, new AbortController().signal)[Symbol.asyncIterator]()
    const prompted = await api.sessions.prompt({
      rpcId: 'prompt_000000001', payload: { sessionId: SESSION, mode: 'queue', content: [{ type: 'text', text: 'hello' }] },
    } as never)
    assert.deepEqual(prompted.result, { ok: true, value: { accepted: true } })
    const user = await iterator.next()
    assert.equal((user.value as { payload: { type: string } }).payload.type, 'session/event')
    const approval = await iterator.next()
    const frame = approval.value as { rpcId: string; payload: { type: string; approvalId: string } }
    assert.equal(frame.payload.type, 'approval/requested')
    assert.deepEqual(await api.respond({
      type: 'client-response', rpcId: frame.rpcId,
      result: { ok: true, value: { sessionId: SESSION, approvalId: frame.payload.approvalId, outcome: 'allowed-once' } },
    }), { accepted: true })
    const assistant = await iterator.next()
    assert.equal((assistant.value as { payload: { type: string } }).payload.type, 'session/event')
    await core.dispose()
    const restarted = createSealedDshServiceCore(operation)
    const restartedApi = await restarted.createApiProxy({ root, sessionsRoot: join(root, 'sessions') })
    const listed = await restartedApi.sessions.list({ rpcId: 'list_00000000001', payload: {} } as never)
    assert.equal(listed.result.ok, true)
    if (!listed.result.ok) throw new Error('expected list')
    assert.equal(listed.result.value.items[0]?.sessionId, SESSION)
    await restarted.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
