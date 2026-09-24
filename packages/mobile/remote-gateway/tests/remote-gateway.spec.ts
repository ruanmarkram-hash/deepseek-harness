import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMobileApi, RpcId as hostRpcId } from '@deepseek-ai/dsh-remote-api'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-remote-api'
import type { RemoteDeviceDirectory, RemoteDeviceId, RemoteDeviceIncarnation } from '@deepseek-ai/dsh-remote-devices'
import { parseRemoteWireId, type RemoteWireEnvelope, type RemoteWireId } from '@deepseek-ai/dsh-remote-wire'
import { directoryFixture } from '../../remote-devices/tests/fixture.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteGateway, type TrustedRemoteConnection } from '@deepseek-ai/dsh-remote-gateway'

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

  push(value: T): void {
    this.values.push(value)
    this.notify?.()
    this.notify = undefined
  }

  async *read(signal: AbortSignal): AsyncIterable<T> {
    while (!this.ended && !signal.aborted) {
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
  const respond = vi.fn(async () => ({ accepted: true as const }))
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

function gateway(apiProxy: ApiProxy, trusted = true) {
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
    }, { maxIdempotencyEntriesPerDevice: 2, maxEventEntriesPerDevice: 2 }),
    markSeen,
    audit,
    revokeDevice: () => { allowed = false },
    restoreDevice: () => { allowed = true; incarnation = SECOND_INCARNATION },
  }
}

async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('RemoteGateway', () => {
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
