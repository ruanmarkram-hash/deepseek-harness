/** Lifecycle checks for the FD199-gated existing configured DSH graph mode. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { RemoteDeviceId } from '../../../packages/mobile/remote-devices/src/types.ts'
import { directoryFixture } from '../../../packages/mobile/remote-devices/tests/fixture.ts'
import type { RemoteHostV3Route } from '../../../packages/mobile/remote-host-v3/src/types.ts'
import type { RemoteWireId } from '../../../packages/mobile/remote-wire/src/types.ts'
import type { SealedHostDshServices } from './host-owned-dsh-runtime.ts'
import type { QuiescedWebOwnerExportFile } from './offline-web-owner-handoff.ts'
import {
  NativeOwnedConfiguredDshHandoffError,
  prepareConfiguredDshWebOwnerHandoff,
  startActivatedConfiguredDshHostRuntime,
} from './native-owned-configured-dsh-handoff.ts'

function hostServices(): Omit<SealedHostDshServices, 'apiProxy'> {
  const routeAllocator = {
    async hostEnrollmentId(): Promise<string> { return 'host_enrollment_001' },
    get(_deviceId: RemoteDeviceId): RemoteHostV3Route | undefined { return undefined },
    async create(): Promise<RemoteHostV3Route> { throw new Error('not reached') },
    async beginConnection(): Promise<RemoteHostV3Route> { throw new Error('not reached') },
    async commitConnection(): Promise<RemoteHostV3Route> { throw new Error('not reached') },
    async remove(): Promise<RemoteHostV3Route | undefined> { return undefined },
  }
  return {
    remoteDevices: directoryFixture({ get: () => undefined }),
    routeAllocator,
    now: () => '2026-08-21T08:00:00.000Z', newId: () => 'gateway_event_0001' as RemoteWireId, audit: () => {},
  }
}

test('the configured Web owner quiesces, exports, then lets one native transaction release, attest, and stage', async () => {
  const calls: string[] = []
  const files: readonly QuiescedWebOwnerExportFile[] = [{
    name: 'sessions/session_00000001.jsonl', bytes: new TextEncoder().encode('{"id":"same-session"}\n'), sha256: 'b'.repeat(64),
  }]
  await prepareConfiguredDshWebOwnerHandoff({
    async quiesce() { calls.push('quiesce') },
    async exportStoppedState() { calls.push('export'); return files },
    async releaseStoreOwnership() { calls.push('release') },
  }, {
    kind: 'native-attested-fd199-configured-web-owner-v2',
    async prepareReleasedStoppedExport(input) {
      calls.push('native-transaction')
      assert.strictEqual(input.files, files)
      await input.releaseStoreOwnership()
      assert.deepEqual(calls, ['quiesce', 'export', 'native-transaction', 'release'])
      calls.push('attest-and-stage')
    },
  })
  assert.deepEqual(calls, ['quiesce', 'export', 'native-transaction', 'release', 'attest-and-stage'])
})

test('the owner cannot supply a graph identity or observe a proof-bearing prepared state', async () => {
  let released = false
  await prepareConfiguredDshWebOwnerHandoff({
    async quiesce() {}, async exportStoppedState() { return [{ name: 'sessions/session_00000001.jsonl', bytes: new Uint8Array([1]), sha256: 'b'.repeat(64) }] },
    async releaseStoreOwnership() { released = true },
  }, {
    kind: 'native-attested-fd199-configured-web-owner-v2',
    async prepareReleasedStoppedExport(input) { await input.releaseStoreOwnership() },
  })
  assert.equal(released, true)
})

test('only native may atomically consume activation and retain the exact desktop graph for fixed remote work', async () => {
  const session = { id: 'same-session', model: { provider: 'configured', model: 'existing-model' } }
  const events = [{ type: 'session/event', sessionId: session.id, data: { text: 'already configured' } }]
  const desktopApi = {
    sessions: {
      async list() { return { rpcId: 'desktop-list', result: { ok: true as const, value: { sessions: [session] } } } },
      async history() { return { rpcId: 'desktop-history', result: { ok: true as const, value: { session, events } } } },
    },
    events: { async *mux() { yield events[0] }, async *host() {} },
  }
  let stopped = false
  const fixedServices = hostServices()
  const lease = await startActivatedConfiguredDshHostRuntime({
    kind: 'native-activated-configured-dsh-v2',
    async startActivatedFixedRemoteGateway(received) {
      assert.strictEqual(received, fixedServices)
      // This call represents native binding RemoteGateway to the same graph;
      // the caller receives neither this ApiProxy nor a mutable activation id.
      const remote = await desktopApi.sessions.list()
      assert.equal(remote.result.value.sessions[0]?.id, session.id)
      assert.deepEqual(remote.result.value.sessions[0]?.model, session.model)
      const iterator = desktopApi.events.mux()[Symbol.asyncIterator]()
      assert.deepEqual((await iterator.next()).value, events[0])
      return { apiProxy: desktopApi, activationProof: 'must not escape', async stop() { stopped = true } }
    },
  }, fixedServices)
  assert.deepEqual(Object.keys(lease), ['stop'])
  assert.equal(Object.isFrozen(lease), true)
  await lease.stop()
  assert.equal(stopped, true)
})

test('a native capability that cannot atomically acquire an activated lease fails closed', async () => {
  let called = false
  await assert.rejects(startActivatedConfiguredDshHostRuntime({
    kind: 'native-activated-configured-dsh-v2',
    async startActivatedFixedRemoteGateway() { called = true; throw new Error('FD199 is prepared or stale') },
  }, hostServices()), NativeOwnedConfiguredDshHandoffError)
  assert.equal(called, true)
})
