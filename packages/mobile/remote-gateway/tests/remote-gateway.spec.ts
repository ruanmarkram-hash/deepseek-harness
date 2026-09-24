import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import { createMobileApi, RpcId as hostRpcId } from '@deepseek-ai/dsh-remote-api'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-remote-api'
import type { RemoteDeviceDirectory, RemoteDeviceId, RemoteDeviceIncarnation } from '@deepseek-ai/dsh-remote-devices'
import { parseRemoteWireId, type RemoteWireEnvelope, type RemoteWireId } from '@deepseek-ai/dsh-remote-wire'
import { directoryFixture } from '../../remote-devices/tests/fixture.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, RemoteGateway, RemoteGatewayError, isRemoteGatewayError, type TrustedRemoteConnection } from '@deepseek-ai/dsh-remote-gateway'

const DEVICE = 'remote_device_0001' as RemoteDeviceId
const FIRST_INCARNATION = 'host_incarnation_0001' as RemoteDeviceIncarnation
const SECOND_INCARNATION = 'host_incarnation_0002' as RemoteDeviceIncarnation
const SIGNING_KEY = 'A'.repeat(43)
const AGREEMENT_KEY = 'B'.repeat(43)
const ROUTE = 'relay_route_000001'
const REQUEST = 'remote_request_001' as RemoteWireId
const RETRY = 'remote_retry_key01' as RemoteWireId
const SECOND_REQUEST = 'remote_request_002' as RemoteWireId
const SECOND_RETRY = 'remote_retry_key02' as RemoteWireId
const SESSION = 'remote_session_0001' as SessionId
const REMOTE_SESSION = 'remote_session_0001' as RemoteWireId
const APPROVAL = 'remote_approval001' as RemoteWireId
const NOW = '2026-08-20T10:00:00.000Z'

class Frames<T> {
  private readonly values: T[] = []
  private notify: (() => void) | undefined
  private ended = false
  private failure: Error | undefined

  fail(): void { this.failure = new Error('stream failed'); this.notify?.() }

  push(value: T): void {
    this.values.push(value)
    this.notify?.()
    this.notify = undefined
  }

  async *read(signal: AbortSignal): AsyncIterable<T> {
    while (!this.ended && !signal.aborted) {
      if (this.failure !== undefined) throw this.failure
      const value = this.values.shift()
      if (value !== undefined) {
        yield value
        continue
      }
      await new Promise<void>((resolve) => {
        this.notify = resolve
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }
}

function request(overrides: Partial<Record<string, unknown>> = {}): RemoteWireEnvelope {
  return {
    version: 3, type: 'request', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY,
    method: 'session.list', payload: {}, ...overrides,
  }
}

interface SendBlock {
  readonly started: Promise<void>
  release(): void
}

interface PendingSendBlock extends SendBlock {
  start(): void
  wait(): Promise<void>
}

function connection(epoch = 1, incarnation = FIRST_INCARNATION, commitBeforeBlockedResolution = false): {
  connection: TrustedRemoteConnection
  sent: RemoteWireEnvelope[]
  closed: string[]
  blockNextSend(): SendBlock
} {
  const incoming = new Frames<RemoteWireEnvelope>()
  const sent: RemoteWireEnvelope[] = []
  const closed: string[] = []
  let nextSendBlock: PendingSendBlock | undefined
  return {
    connection: {
      peer: { deviceId: DEVICE, enrollmentId: incarnation, signingPublicKey: SIGNING_KEY, agreementPublicKey: AGREEMENT_KEY },
      route: { routeId: ROUTE, generation: 1, connectionEpoch: epoch },
      receive: signal => incoming.read(signal),
      send: async (envelope, fence) => {
        const block = nextSendBlock
        nextSendBlock = undefined
        if (block !== undefined) {
          block.start()
          if (commitBeforeBlockedResolution && fence.active && !fence.abortSignal.aborted) {
            sent.push(envelope)
            await block.wait()
            return { status: 'committed-before-fence' }
          }
          await block.wait()
        }
        if (!fence.active || fence.abortSignal.aborted || closed.length > 0) return { status: 'not-committed' }
        sent.push(envelope)
        return { status: 'committed-before-fence' }
      },
      close: async (reason) => { closed.push(reason) },
    },
    sent,
    closed,
    blockNextSend: () => {
      let notifyStarted: (() => void) | undefined
      let release: (() => void) | undefined
      const started = new Promise<void>((resolve) => { notifyStarted = resolve })
      const barrier = new Promise<void>((resolve) => { release = resolve })
      const block: PendingSendBlock = {
        started,
        start: () => { notifyStarted?.() },
        wait: () => barrier,
        release: () => { release?.() },
      }
      nextSendBlock = block
      return block
    },
  }
}

function api(mux = new Frames<RpcRequest<MuxFrame>>(), listBarrier?: Promise<void>) {
  const list = vi.fn(async (message: RpcRequest<{}>) => {
    await listBarrier
    return { rpcId: message.rpcId, result: { ok: true as const, value: { items: [] } } }
  })
  const describe = vi.fn<ApiProxy['host']['describe']>(async message => ({
    rpcId: message.rpcId,
    result: { ok: true, value: { version: 'test', cwd: '/', home: '/', attachedSessions: 0, canOpenPath: false } },
  }))
  const workspaceList = vi.fn(async (message: RpcRequest<{}>) => ({
    rpcId: message.rpcId,
    result: { ok: true as const, value: { items: [], archivedSessionIds: [] } },
  }))
  const respond = vi.fn<ApiProxy['respond']>(async () => ({ accepted: true as const }))
  const proxy = createMobileApi(new Context())
  proxy.sessions.list = list
  proxy.host.describe = describe
  proxy.workspace.list = workspaceList
  proxy.events = {
    mux: (_request: unknown, signal: AbortSignal) => mux.read(signal),
    host: (_request: unknown, signal: AbortSignal) => new Frames<RpcRequest<HostFrame>>().read(signal),
  }
  proxy.respond = respond
  return {
    api: proxy,
    list,
    respond,
  }
}

function gateway(apiProxy: ApiProxy, trusted = true, maxIdempotencyEntriesPerDevice = 2) {
  let counter = 0
  let allowed = trusted
  let incarnation = FIRST_INCARNATION
  const markSeen = vi.fn<RemoteDeviceDirectory['markSeen']>(async () => ({
    id: DEVICE, incarnation, label: 'Phone', signingPublicKey: SIGNING_KEY,
    agreementPublicKey: AGREEMENT_KEY, enrolledAt: NOW,
  }))
  const devices = directoryFixture({
    get: () => allowed ? {
      id: DEVICE,
      incarnation,
      label: 'Phone',
      signingPublicKey: SIGNING_KEY,
      agreementPublicKey: AGREEMENT_KEY,
      enrolledAt: NOW,
    } : undefined,
    markSeen,
  })
  const audit: unknown[] = []
  return {
    gateway: new RemoteGateway({
      api: apiProxy,
      devices,
      now: () => NOW,
      newId: () => `gateway_identifier_${++counter}` as RemoteWireId,
      audit: (entry) => { audit.push(entry) },
    }, { maxIdempotencyEntriesPerDevice, maxEventEntriesPerDevice: 2 }),
    markSeen,
    audit,
    devices,
    revokeDevice: () => { allowed = false },
    restoreDevice: () => { allowed = true; incarnation = SECOND_INCARNATION },
  }
}

async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('RemoteGateway', () => {
  it.each([NaN, -1])('preserves the constructor cache-limit behavior for %s', async (limit) => {
    const host = api()
    const fixture = gateway(host.api, true, limit)
    const peer = connection()
    const active = await fixture.gateway.attach(peer.connection)
    await active?.receive(request())
    await active?.receive(request())
    expect(host.list).toHaveBeenCalledTimes(Number.isNaN(limit) ? 1 : 2)
    await fixture.gateway.dispose()
  })

  it.each([null, [], {}, { mode: 'snapshot', cursor: -1 }, { mode: 'unknown', cursor: 0 }, { mode: 'replay' }])('does not trust synchronization metadata mutated by a provider (%j)', async (value) => {
    const fixture = gateway(api().api)
    const peer = connection()
    const active = await fixture.gateway.attach({ ...peer.connection, send: async (envelope, fence) => {
      const sent = await peer.connection.send(envelope, fence)
      if (envelope.type === 'response' && envelope.result.ok) Object.assign(envelope.result, { value })
      return sent
    } })
    await active?.receive({ version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY, deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: {} })
    expect(active?.status().synchronized).toBe(typeof value === 'object' && value !== null && 'cursor' in value && value.cursor === 0)
    await fixture.gateway.dispose()
  })

  it('refuses an oversized aggregate snapshot even if its individual results fit', async () => {
    const fixture = gateway(api().api)
    const part = { ok: true as const, value: Array.from({ length: 768 }, () => 'x'.repeat(4096)) }
    vi.spyOn(fixture.gateway, 'snapshot').mockResolvedValue({ host: part, sessions: part, workspaces: part })
    const peer = connection()
    const active = await fixture.gateway.attach(peer.connection)
    await active?.receive({ version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY, deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: {} })
    expect(peer.sent.at(-1)).toMatchObject({ result: { ok: false, error: { code: 'remote-internal' } } })
    await fixture.gateway.dispose()
  })

  it('normalizes a presence record that cannot serialize', async () => {
    const fixture = gateway(api().api)
    const peer = connection()
    const active = await fixture.gateway.attach(peer.connection)
    const record = fixture.devices.get(DEVICE)
    if (record === undefined) throw new Error('missing device')
    fixture.markSeen.mockResolvedValueOnce(Object.assign(record, { toJSON: () => undefined }))
    await active?.receive({ version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY, deviceId: parseRemoteWireId(DEVICE), action: 'device.heartbeat', payload: {} })
    expect(peer.sent.at(-1)).toMatchObject({ result: { ok: true, value: { device: {} } } })
    await fixture.gateway.dispose()
  })

  it.each(['ack', 'heartbeat'] as const)('rechecks directory authorization immediately before %s', async (operation) => {
    const fixture = gateway(api().api)
    const peer = connection()
    const active = await fixture.gateway.attach(peer.connection)
    const trust = vi.spyOn(fixture.gateway, 'isTrusted').mockReturnValue(false).mockReturnValueOnce(true)
    if (operation === 'heartbeat') trust.mockReturnValueOnce(true)
    await active?.receive(operation === 'ack'
      ? { version: 3, type: 'stream-ack', connectionEpoch: 1, cursor: 0 }
      : { version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY, deviceId: parseRemoteWireId(DEVICE), action: 'device.heartbeat', payload: {} })
    expect(peer.closed).toContain('unauthorized-device')
    await fixture.gateway.dispose()
  })

  it.each([1, 2])('rechecks event ownership at outbound boundary %i', async (allowedChecks) => {
    const mux = new Frames<RpcRequest<MuxFrame>>()
    const fixture = gateway(api(mux).api)
    const peer = connection()
    const active = await fixture.gateway.attach(peer.connection)
    await active?.receive({ version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY, deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: {} })
    const trust = vi.spyOn(fixture.gateway, 'isTrusted').mockReturnValue(false)
    for (let index = 0; index < allowedChecks; index++) trust.mockReturnValueOnce(true)
    mux.push({ rpcId: hostRpcId(REQUEST), payload: { type: 'session/queue', sessionId: SESSION, items: [] } })
    await settled()
    expect(peer.sent).toHaveLength(1)
    await fixture.gateway.dispose()
  })

  it.each([false, true])('replays only newer entries and stops when its provider closes (close=%s)', async (closeDuringReplay) => {
    const mux = new Frames<RpcRequest<MuxFrame>>()
    const fixture = gateway(api(mux).api)
    const peer = connection()
    const endpoint: TrustedRemoteConnection = { ...peer.connection, send: async (envelope, fence) => {
      const receipt = await peer.connection.send(envelope, fence)
      if (closeDuringReplay && envelope.type === 'event') await fixture.gateway.dispose()
      return receipt
    } }
    const active = await fixture.gateway.attach(endpoint)
    for (let index = 0; index < 2; index++) mux.push({ rpcId: hostRpcId(REQUEST), payload: { type: 'session/queue', sessionId: SESSION, items: [] } })
    await settled()
    await active?.receive({ version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY, deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: { cursor: closeDuringReplay ? 0 : 1 } })
    expect(peer.sent.filter(frame => frame.type === 'event')).toHaveLength(1)
    await fixture.gateway.dispose()
  })

  it('rejects non-serializable stream frames without retaining them', async () => {
    const mux = new Frames<RpcRequest<MuxFrame>>()
    const fixture = gateway(api(mux).api)
    const peer = connection()
    const active = await fixture.gateway.attach(peer.connection)
    for (const toJSON of [() => undefined, () => { throw new Error('private serialization failure') }]) {
      mux.push({ rpcId: hostRpcId(REQUEST), payload: Object.assign({ type: 'session/queue' as const, sessionId: SESSION, items: [] }, { toJSON }) })
    }
    await settled()
    expect(active?.status().latestCursor).toBe(0)
    expect(fixture.audit.filter(entry => typeof entry === 'object' && entry !== null && 'reason' in entry && entry.reason === 'frame-not-json')).toHaveLength(2)
    await fixture.gateway.dispose()
  })

  it.each(['yield', 'throw'] as const)('ignores a late source %s after closing', async (mode) => {
    const barrier = Promise.withResolvers<undefined>()
    const host = api()
    host.api.events.mux = async function* () {
      await barrier.promise
      if (mode === 'throw') throw new Error('late failure')
      yield { rpcId: hostRpcId(REQUEST), payload: { type: 'session/queue', sessionId: SESSION, items: [] } }
    }
    const fixture = gateway(host.api)
    const peer = connection()
    const active = await fixture.gateway.attach(peer.connection)
    await active?.close('transport-failed')
    barrier.resolve(undefined)
    await settled()
    expect(active?.status().latestCursor).toBe(0)
    await fixture.gateway.dispose()
  })

  it('ignores a late transport failure after closing', async () => {
    const barrier = Promise.withResolvers<undefined>()
    const fixture = gateway(api().api)
    const peer = connection()
    const active = await fixture.gateway.attach({ ...peer.connection, receive: () => ({
      [Symbol.asyncIterator]: () => ({ next: async () => { await barrier.promise; throw new Error('late read') } }),
    }) })
    await active?.close('transport-failed')
    barrier.resolve(undefined)
    await settled()
    expect(fixture.audit).not.toContainEqual(expect.objectContaining({ reason: 'transport-read-failed' }))
    await fixture.gateway.dispose()
  })

  it.each([null, [], 7, { cursor: -1 }, { cursor: 1.5 }])('uses a snapshot when the requested replay cursor is invalid (%j)', async (payload) => {
    const fixture = gateway(api().api)
    const peer = connection()
    const active = await fixture.gateway.attach(peer.connection)
    await active?.receive({ version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY, deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload })
    expect(peer.sent.at(-1)).toMatchObject({ result: { ok: true, value: { mode: 'snapshot' } } })
    await fixture.gateway.dispose()
  })

  it('recognizes only its own lifecycle errors', () => {
    expect(isRemoteGatewayError(new RemoteGatewayError('REMOTE_GATEWAY_PROTOCOL', 'closed'))).toBe(true)
    expect(isRemoteGatewayError(new Error('other'))).toBe(false)
  })

  it.each([
    { routeId: '' }, { generation: -1 }, { generation: 1.5 }, { connectionEpoch: -1 }, { connectionEpoch: 1.5 },
  ])('rejects invalid authenticated route %j', async (invalid) => {
    const { gateway: remote } = gateway(api().api)
    const peer = connection()
    await expect(remote.attach({ ...peer.connection, route: { ...peer.connection.route, ...invalid } })).resolves.toBeUndefined()
    expect(peer.closed).toEqual(['protocol-rejected'])
  })

  it('rejects failed or revoked-in-flight durable presence writes', async () => {
    for (const changeAuthorization of [false, true]) {
      const fixture = gateway(api().api)
      const record = fixture.devices.get(DEVICE)
      if (record === undefined) throw new Error('missing fixture device')
      fixture.markSeen.mockImplementationOnce(async () => {
        if (!changeAuthorization) throw new Error('presence failure')
        fixture.revokeDevice()
        return record
      })
      const peer = connection()
      await expect(fixture.gateway.attach(peer.connection)).resolves.toBeUndefined()
      expect(peer.closed).toEqual(['unauthorized-device'])
    }
  })

  it('rejects stale routes, disposes once, and refuses every later attachment', async () => {
    const fixture = gateway(api().api)
    const first = connection()
    const active = await fixture.gateway.attach(first.connection)
    await active?.close('transport-failed')
    const stale = connection()
    await expect(fixture.gateway.attach(stale.connection)).resolves.toBeUndefined()
    expect(stale.closed).toEqual(['protocol-rejected'])
    await fixture.gateway.dispose()
    await fixture.gateway.dispose()
    const later = connection(2)
    await expect(fixture.gateway.attach(later.connection)).resolves.toBeUndefined()
    expect(later.closed).toEqual(['gateway-disposed'])
    fixture.gateway.revoke('missing_device_001' as RemoteDeviceId)
  })

  it('consumes provider connections and stops on owner cancellation', async () => {
    const { gateway: remote } = gateway(api().api)
    const first = connection()
    const later = connection(2)
    const owner = new AbortController()
    await remote.serve({ async *accept() { yield first.connection; owner.abort(); yield later.connection } }, owner.signal)
    expect(later.closed).toEqual(['gateway-disposed'])
    await remote.dispose()
    expect(first.closed).toContain('gateway-disposed')
  })

  it('sanitizes thrown RPC failures and refuses invocation after directory revocation', async () => {
    const host = api()
    host.list.mockRejectedValueOnce(new Error('private failure'))
    const fixture = gateway(host.api)
    const peer = connection()
    const signal = new AbortController().signal
    await expect(fixture.gateway.invoke(peer.connection.peer, 'session.list', REQUEST, {}, signal)).resolves.toMatchObject({ ok: false, error: { code: 'remote-internal' } })
    fixture.revokeDevice()
    await expect(fixture.gateway.invoke(peer.connection.peer, 'session.list', REQUEST, {}, signal)).resolves.toMatchObject({ ok: false, error: { code: 'remote-device-unavailable' } })
    await expect(fixture.gateway.markSeen(peer.connection.peer)).rejects.toThrow('no longer trusted')
  })

  it.each([
    request({ version: 99 }),
    { version: 3, type: 'response', connectionEpoch: 1, requestId: REQUEST, result: { ok: true, value: {} } },
    { version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY, deviceId: parseRemoteWireId('foreign_device_001'), action: 'device.describe', payload: {} },
  ] satisfies RemoteWireEnvelope[])('closes invalid or forbidden incoming envelopes %#', async (envelope) => {
    const { gateway: remote } = gateway(api().api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    await active?.receive(envelope)
    expect(peer.closed).toContain('protocol-rejected')
    await remote.dispose()
  })

  it('handles heartbeat success and durable failure, then disconnects explicitly', async () => {
    const fixture = gateway(api().api)
    const peer = connection()
    const active = await fixture.gateway.attach(peer.connection)
    const control = (action: 'device.heartbeat' | 'device.disconnect', key: RemoteWireId): RemoteWireEnvelope => ({
      version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: key,
      deviceId: parseRemoteWireId(DEVICE), action, payload: {},
    })
    await active?.receive(control('device.heartbeat', RETRY))
    expect(peer.sent.at(-1)).toMatchObject({ result: { ok: true } })
    fixture.markSeen.mockRejectedValueOnce(new Error('presence failure'))
    await active?.receive(control('device.heartbeat', SECOND_RETRY))
    expect(peer.sent.at(-1)).toMatchObject({ result: { ok: false, error: { code: 'remote-device-unavailable' } } })
    await active?.receive(control('device.disconnect', parseRemoteWireId('disconnect_retry_001')))
    expect(peer.closed).toContain('transport-failed')
    await fixture.gateway.dispose()
  })

  it('acknowledges delivered cursors and rejects forward or regressing acknowledgements', async () => {
    for (const invalid of [2, 0]) {
      const mux = new Frames<RpcRequest<MuxFrame>>()
      const { gateway: remote } = gateway(api(mux).api)
      const peer = connection()
      const active = await remote.attach(peer.connection)
      mux.push({ rpcId: hostRpcId(REQUEST), payload: { type: 'session/queue', sessionId: SESSION, items: [] } })
      await settled()
      await active?.receive({ version: 3, type: 'stream-ack', connectionEpoch: 1, cursor: 1 })
      expect(active?.status().acknowledgedCursor).toBe(1)
      await active?.receive({ version: 3, type: 'stream-ack', connectionEpoch: 1, cursor: invalid })
      expect(peer.closed).toContain('protocol-rejected')
      await remote.dispose()
    }
  })

  it('evicts the oldest idempotency result and sanitizes response handler rejections', async () => {
    const host = api()
    const { gateway: remote } = gateway(host.api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    for (const idempotencyKey of [RETRY, SECOND_RETRY, parseRemoteWireId('retry_third_00001'), RETRY]) await active?.receive(request({ idempotencyKey }))
    expect(host.list).toHaveBeenCalledTimes(4)
    host.respond.mockRejectedValueOnce(new Error('private response failure'))
    await active?.receive({ version: 3, type: 'client-response', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: parseRemoteWireId('response_retry_001'), result: { ok: true, value: {} } })
    expect(peer.sent.at(-1)).toMatchObject({ result: { ok: false, error: { code: 'remote-internal' } } })
    await remote.dispose()
  })

  it('closes after a failed send even when provider close also rejects', async () => {
    const { gateway: remote } = gateway(api().api)
    const peer = connection()
    const active = await remote.attach({ ...peer.connection, send: async () => { throw new Error('send') }, close: async () => { throw new Error('close') } })
    await expect(active?.receive(request())).resolves.toBeUndefined()
    await remote.dispose()
  })

  it('mounts its plugin and reacts only to device revocations', async () => {
    const ctx = new Context()
    ctx.provide('apiProxy', api().api)
    ctx.provide('remoteDevices', gateway(api().api).devices)
    const fiber = await ctx.plugin({ apply }, { maxIdempotencyEntriesPerDevice: 2, maxEventEntriesPerDevice: 2 })
    const peer = connection()
    await ctx.remoteGateway.attach(peer.connection)
    ctx.remoteGateway.newId()
    const device = ctx.remoteDevices.get(DEVICE)
    if (device === undefined) throw new Error('missing fixture device')
    ctx.emit('remote-devices/changed', { type: 'seen', device })
    ctx.emit('remote-devices/changed', { type: 'revoked', deviceId: DEVICE })
    await fiber.dispose()
  })

  it('checks completed audit records against the live device directory', async () => {
    const ctx = new Context()
    const fixture = gateway(api().api)
    ctx.provide('remoteDevices', fixture.devices)
    const registry = await ctx.plugin(Invariants)
    const entry = { deviceId: DEVICE, route: connection().connection.route, operation: 'request' as const, reason: 'test' }
    ctx.emit('remote-gateway/audit', { ...entry, outcome: 'rejected' })
    ctx.emit('remote-gateway/audit', { ...entry, outcome: 'completed' })
    fixture.revokeDevice()
    expect(() => { ctx.emit('remote-gateway/audit', { ...entry, outcome: 'completed' }) }).toThrow('completed remote gateway operation names revoked device')
    await registry.dispose()
  })

  it.each(['not-pending', 'bad-response'] as const)('translates a refused response receipt with reason %s', async (reason) => {
    const host = api()
    host.respond.mockResolvedValue({ accepted: false, reason })
    const { gateway: remote } = gateway(host.api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    await active?.receive({ version: 3, type: 'approval', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY, sessionId: REMOTE_SESSION, approvalId: APPROVAL, outcome: 'allowed-once' })
    expect(peer.sent.at(-1)).toMatchObject({ result: { ok: false, error: { code: 'remote-response-refused' } } })
    await remote.dispose()
  })

  it.each(['approval', 'client-response', 'device-control'] as const)('fences a queued %s after revocation', async (type) => {
    const fixture = gateway(api().api)
    const peer = connection()
    const active = await fixture.gateway.attach(peer.connection)
    const common = { version: 3 as const, connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY }
    const envelope: RemoteWireEnvelope = type === 'approval'
      ? { ...common, type, sessionId: REMOTE_SESSION, approvalId: APPROVAL, outcome: 'allowed-once' }
      : type === 'client-response' ? { ...common, type, result: { ok: true, value: {} } }
        : { ...common, type, deviceId: parseRemoteWireId(DEVICE), action: 'device.heartbeat', payload: {} }
    const received = active?.receive(envelope)
    fixture.revokeDevice()
    await received
    expect(peer.sent).toEqual([])
    expect(peer.closed).toContain('unauthorized-device')
    await fixture.gateway.dispose()
  })

  it.each([false, true])('does not audit a blocked response as delivered after close (committed=%s)', async (committed) => {
    for (const type of ['request', 'approval', 'client-response', 'device-control'] as const) {
      const fixture = gateway(api().api)
      const peer = connection(1, FIRST_INCARNATION, committed)
      const active = await fixture.gateway.attach(peer.connection)
      const block = peer.blockNextSend()
      const common = { version: 3 as const, connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY }
      const envelope: RemoteWireEnvelope = type === 'request' ? request() : type === 'approval'
        ? { ...common, type, sessionId: REMOTE_SESSION, approvalId: APPROVAL, outcome: 'allowed-once' }
        : type === 'client-response' ? { ...common, type, result: { ok: true, value: {} } }
          : { ...common, type, deviceId: parseRemoteWireId(DEVICE), action: 'device.heartbeat', payload: {} }
      const received = active?.receive(envelope)
      await block.started
      await active?.close('transport-failed')
      block.release()
      await received
      expect(fixture.audit).toContainEqual(expect.objectContaining({ operation: type, outcome: 'rejected', reason: committed ? 'response-committed-before-close' : 'response-not-delivered' }))
      await fixture.gateway.dispose()
    }
  })

  it('reports RPC refusals and sanitizes a non-JSON-safe Host result', async () => {
    const host = api()
    host.api.sessions.list = async message => ({ rpcId: message.rpcId, result: { ok: false, error: { code: 'internal', message: 'refused', details: {} } } })
    const { gateway: remote } = gateway(host.api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    await active?.receive(request())
    expect(peer.sent.at(-1)).toMatchObject({ result: { ok: false } })
    host.api.host.describe = async message => ({ rpcId: message.rpcId, result: { ok: true, value: { version: 'test', cwd: '/', home: '/', attachedSessions: Infinity, canOpenPath: false } } })
    await active?.receive(request({ method: 'host.describe', idempotencyKey: SECOND_RETRY }))
    expect(peer.sent.at(-1)).toMatchObject({ result: { ok: false, error: { code: 'remote-response-invalid' } } })
    await remote.dispose()
  })

  it.each([false, true])('retains and reports source stream failures (synchronized=%s)', async (synchronized) => {
    const mux = new Frames<RpcRequest<MuxFrame>>()
    const { gateway: remote } = gateway(api(mux).api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    if (synchronized) await active?.receive({ version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY, deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: {} })
    for (let index = 0; index < 3; index++) mux.push({ rpcId: hostRpcId(REQUEST), payload: { type: 'session/queue', sessionId: SESSION, items: [] } })
    await settled()
    mux.fail()
    await settled()
    expect(active?.status().latestCursor).toBe(4)
    if (synchronized) {
      expect(peer.sent.at(-1)).toMatchObject({
        type: 'event', event: 'stream/error',
        payload: { type: 'stream/error', error: { code: 'internal', message: 'Host event stream ended unexpectedly', details: {} } },
      })
      expect(JSON.stringify(peer.sent.at(-1)).length).toBeLessThan(1024)
    }
    await remote.dispose()
    await active?.receive(request())
  })

  it('reads provider envelopes and audits a transport read failure', async () => {
    const fixture = gateway(api().api)
    const peer = connection()
    const active = await fixture.gateway.attach({ ...peer.connection, async *receive() { yield request(); throw new Error('transport') } })
    await settled()
    expect(peer.sent).toHaveLength(1)
    expect(fixture.audit).toContainEqual(expect.objectContaining({ reason: 'transport-read-failed' }))
    await active?.close('transport-failed')
    await fixture.gateway.dispose()
  })

  it('fails closed before reading frames when the authenticated identity is absent from the local device directory', async () => {
    const host = api()
    const { gateway: remote, audit } = gateway(host.api, false)
    const peer = connection()

    await expect(remote.attach(peer.connection)).resolves.toBeUndefined()
    expect(peer.closed).toEqual(['unauthorized-device'])
    expect(audit).toContainEqual(expect.objectContaining({ outcome: 'rejected', reason: 'unauthorized-enrollment' }))
  })

  it('ends an active connection when the Host device directory revokes its authenticated identity', async () => {
    const host = api()
    const { gateway: remote, revokeDevice } = gateway(host.api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    if (active === undefined) throw new Error('Expected attached remote connection')

    revokeDevice()
    remote.revoke(DEVICE)
    await settled()

    expect(peer.closed).toContain('unauthorized-device')
  })

  it('does not dispatch a frame that was admitted before its device is revoked', async () => {
    const host = api()
    const { gateway: remote, revokeDevice } = gateway(host.api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    if (active === undefined) throw new Error('Expected attached remote connection')

    const pending = active.receive(request())
    revokeDevice()
    remote.revoke(DEVICE)
    await pending

    expect(host.list).not.toHaveBeenCalled()
    expect(peer.closed).toContain('unauthorized-device')
  })

  it('does not send a response when the device is revoked while its Host request is blocked', async () => {
    let releaseList: (() => void) | undefined
    const listBarrier = new Promise<void>((resolve) => { releaseList = resolve })
    const host = api(undefined, listBarrier)
    const { gateway: remote, revokeDevice } = gateway(host.api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    if (active === undefined) throw new Error('Expected attached remote connection')

    const pending = active.receive(request())
    await vi.waitFor(() => { expect(host.list).toHaveBeenCalledOnce() })
    revokeDevice()
    remote.revoke(DEVICE)
    releaseList?.()
    await pending

    expect(peer.sent).toEqual([])
    expect(peer.closed).toContain('unauthorized-device')
  })

  it('starts a re-enrolled device with no retained idempotency result or old event replay', async () => {
    const mux = new Frames<RpcRequest<MuxFrame>>()
    const host = api(mux)
    const { gateway: remote, revokeDevice, restoreDevice } = gateway(host.api)
    const first = connection()
    const active = await remote.attach(first.connection)
    if (active === undefined) throw new Error('Expected attached remote connection')

    await active.receive({
      version: 3, type: 'device-control', connectionEpoch: 1, requestId: SECOND_REQUEST, idempotencyKey: SECOND_RETRY,
      deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: {},
    })
    mux.push({ rpcId: hostRpcId(REQUEST), payload: { type: 'session/queue', sessionId: SESSION, items: [] } })
    await settled()
    await active.receive(request())

    revokeDevice()
    remote.revoke(DEVICE)
    await settled()
    restoreDevice()
    const second = connection(1, SECOND_INCARNATION)
    const reconnected = await remote.attach(second.connection)
    if (reconnected === undefined) throw new Error('Expected re-enrolled connection')
    await reconnected.receive({
      version: 3, type: 'device-control', connectionEpoch: 1, requestId: SECOND_REQUEST, idempotencyKey: SECOND_RETRY,
      deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: { cursor: 0 },
    })
    await reconnected.receive(request())

    expect(second.sent.filter(envelope => envelope.type === 'event')).toEqual([])
    expect(host.list).toHaveBeenCalledTimes(3)
    await reconnected.close('gateway-disposed')
  })

  it('does not report queued responses or events as delivered after revocation closes an outbound send', async () => {
    const mux = new Frames<RpcRequest<MuxFrame>>()
    const host = api(mux)
    const { gateway: remote, audit, revokeDevice } = gateway(host.api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    if (active === undefined) throw new Error('Expected attached remote connection')
    await active.receive({
      version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY,
      deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: {},
    })

    const block = peer.blockNextSend()
    mux.push({ rpcId: hostRpcId(REQUEST), payload: { type: 'session/queue', sessionId: SESSION, items: [] } })
    await block.started
    const pending = active.receive(request({ requestId: SECOND_REQUEST, idempotencyKey: SECOND_RETRY }))
    await vi.waitFor(() => { expect(host.list).toHaveBeenCalledTimes(2) })
    revokeDevice()
    remote.revoke(DEVICE)
    block.release()
    await pending
    await settled()

    expect(peer.sent).not.toContainEqual(expect.objectContaining({ type: 'response', requestId: SECOND_REQUEST }))
    expect(audit).toContainEqual(expect.objectContaining({
      operation: 'event-delivery', outcome: 'rejected', reason: 'event-not-delivered',
    }))
    expect(audit).toContainEqual(expect.objectContaining({
      operation: 'request', outcome: 'rejected', reason: 'response-not-delivered', requestId: SECOND_REQUEST,
    }))
  })

  it('rejects a delayed old-enrollment connection after revocation and same-id re-enrollment', async () => {
    const host = api()
    const { gateway: remote, revokeDevice, restoreDevice, audit } = gateway(host.api)
    const first = connection(4, FIRST_INCARNATION)
    const active = await remote.attach(first.connection)
    if (active === undefined) throw new Error('Expected attached remote connection')

    revokeDevice()
    remote.revoke(DEVICE)
    restoreDevice()
    const renewed = connection(1, SECOND_INCARNATION)
    await expect(remote.attach(renewed.connection)).resolves.toBeDefined()

    const delayedOld = connection(999, FIRST_INCARNATION)
    await expect(remote.attach(delayedOld.connection)).resolves.toBeUndefined()
    expect(delayedOld.closed).toContain('unauthorized-device')
    expect(audit).toContainEqual(expect.objectContaining({ operation: 'connection', outcome: 'rejected', reason: 'unauthorized-enrollment' }))
  })

  it('does not claim an in-flight committed write was delivered after revoke closes its lease', async () => {
    const mux = new Frames<RpcRequest<MuxFrame>>()
    const host = api(mux)
    const { gateway: remote, revokeDevice, audit } = gateway(host.api)
    const peer = connection(1, FIRST_INCARNATION, true)
    const active = await remote.attach(peer.connection)
    if (active === undefined) throw new Error('Expected attached remote connection')
    await active.receive({
      version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY,
      deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: {},
    })

    const block = peer.blockNextSend()
    mux.push({ rpcId: hostRpcId(REQUEST), payload: { type: 'session/queue', sessionId: SESSION, items: [] } })
    await block.started
    revokeDevice()
    remote.revoke(DEVICE)
    block.release()
    await settled()

    expect(peer.sent).toContainEqual(expect.objectContaining({ type: 'event', event: 'session/queue' }))
    expect(audit).toContainEqual(expect.objectContaining({
      operation: 'event-delivery', outcome: 'rejected', reason: 'event-committed-before-close',
    }))
    expect(audit).not.toContainEqual(expect.objectContaining({
      operation: 'event-delivery', outcome: 'completed', reason: 'event-sent',
    }))
  })

  it('uses the checked Host API dispatcher and returns a cached result for a retry without repeating the mutation', async () => {
    const host = api()
    const { gateway: remote } = gateway(host.api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    expect(active).toBeDefined()
    if (active === undefined) throw new Error('Expected attached remote connection')

    await active.receive(request())
    await active.receive(request({ requestId: SECOND_REQUEST }))
    await active.receive(request({ requestId: 'remote_request_003', method: 'session.create' }))

    expect(host.list).toHaveBeenCalledTimes(1)
    expect(peer.sent).toMatchObject([
      { type: 'response', requestId: REQUEST, result: { ok: true } },
      { type: 'response', requestId: SECOND_REQUEST, result: { ok: true } },
      { type: 'response', result: { ok: false, error: { code: 'remote-idempotency-conflict' } } },
    ])
    await active.close('gateway-disposed')
  })

  it('routes approval and question responses through the Host pending-response entry point with the Host request id', async () => {
    const host = api()
    const { gateway: remote } = gateway(host.api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    if (active === undefined) throw new Error('Expected attached remote connection')

    await active.receive({
      version: 3, type: 'approval', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY,
      sessionId: REMOTE_SESSION, approvalId: APPROVAL, outcome: 'allowed-once',
    })
    await active.receive({
      version: 3, type: 'client-response', connectionEpoch: 1, requestId: SECOND_REQUEST, idempotencyKey: SECOND_RETRY,
      result: { ok: true, value: { sessionId: REMOTE_SESSION, answer: { answers: [] } } },
    })

    expect(host.respond).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'client-response', rpcId: REQUEST }))
    expect(host.respond).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'client-response', rpcId: SECOND_REQUEST }))
    await active.close('gateway-disposed')
  })

  it('sends a snapshot response before ordered live events, replays retained cursors after reconnect, and refuses an old epoch', async () => {
    const mux = new Frames<RpcRequest<MuxFrame>>()
    const host = api(mux)
    const { gateway: remote } = gateway(host.api)
    const first = connection(1)
    const active = await remote.attach(first.connection)
    if (active === undefined) throw new Error('Expected attached remote connection')

    await active.receive({
      version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY,
      deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: {},
    })
    mux.push({ rpcId: hostRpcId(REQUEST), payload: { type: 'session/queue', sessionId: SESSION, items: [] } })
    await settled()

    expect(first.sent[0]).toMatchObject({ type: 'response', requestId: REQUEST, result: { ok: true, value: { mode: 'snapshot' } } })
    expect(first.sent[1]).toMatchObject({ type: 'event', cursor: 1, event: 'session/queue' })

    const second = connection(2)
    const resumed = await remote.attach(second.connection)
    if (resumed === undefined) throw new Error('Expected reconnected remote connection')
    await resumed.receive({
      version: 3, type: 'device-control', connectionEpoch: 2, requestId: SECOND_REQUEST, idempotencyKey: SECOND_RETRY,
      deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: { cursor: 0 },
    })
    await settled()

    expect(first.closed).toContain('superseded')
    expect(second.sent).toMatchObject([
      { type: 'response', requestId: SECOND_REQUEST, result: { ok: true, value: { mode: 'replay' } } },
      { type: 'event', connectionEpoch: 2, cursor: 1 },
    ])
    await resumed.receive({ ...request(), connectionEpoch: 1 })
    expect(second.closed).toContain('protocol-rejected')
  })

  it('replays an event that arrives while the asynchronous Host snapshot is still reading', async () => {
    let releaseList: (() => void) | undefined
    const listBarrier = new Promise<void>((resolve) => { releaseList = resolve })
    const mux = new Frames<RpcRequest<MuxFrame>>()
    const host = api(mux, listBarrier)
    const { gateway: remote } = gateway(host.api)
    const peer = connection()
    const active = await remote.attach(peer.connection)
    if (active === undefined) throw new Error('Expected attached remote connection')

    const describing = active.receive({
      version: 3, type: 'device-control', connectionEpoch: 1, requestId: REQUEST, idempotencyKey: RETRY,
      deviceId: parseRemoteWireId(DEVICE), action: 'device.describe', payload: {},
    })
    await vi.waitFor(() => { expect(host.list).toHaveBeenCalledOnce() })
    mux.push({ rpcId: hostRpcId(REQUEST), payload: { type: 'session/queue', sessionId: SESSION, items: [] } })
    await settled()
    releaseList?.()
    await describing

    expect(peer.sent).toMatchObject([
      { type: 'response', result: { ok: true, value: { mode: 'snapshot', cursor: 0 } } },
      { type: 'event', cursor: 1, event: 'session/queue' },
    ])
    await active.close('gateway-disposed')
  })
})
