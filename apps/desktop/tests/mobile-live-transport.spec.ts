import { describe, expect, it } from 'vitest'
import {
  confirmPairingKey,
  createMobilePairingProof,
  createMobileSessionCipher,
  createPairingEphemeralKeyPair,
  parseDesktopPairingAccept,
  parsePairingBootstrap,
  verifyDesktopPairingProof,
} from '@deepseek-ai/dsh-pairing-protocol'
import { LocalSessionApi } from '../src/local-session-api.ts'
import { DesktopMobileTransport, type DesktopRelaySocket } from '../src/mobile-live-transport.ts'
import { DesktopPairingBridge } from '../src/mobile-pairing.ts'

const NOW = 1_800_000_000_000

class FakeSocket implements DesktopRelaySocket {
  onclose: ((event: { readonly code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onopen: (() => void) | null = null
  readonly sent: string[] = []

  close(): void {}
  send(data: string): void { this.sent.push(data) }
  open(): void { this.onopen?.() }
  deliver(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
}

function bytes(): (size: number) => Uint8Array {
  let next = 1
  return size => Uint8Array.from({ length: size }, () => next++)
}

function response(value: unknown): Response {
  return Response.json({ type: 'server-response', rpcId: 'r', result: { ok: true, value } })
}

function userEvent(text: string): unknown {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function assistantEvent(text: string): unknown {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

function mobileHandshake(bootstrapWire: { readonly qrValue: string }): {
  readonly init: Record<string, unknown>
  readonly mobileCipher: ReturnType<typeof createMobileSessionCipher>
} {
  const bootstrap = parsePairingBootstrap(bootstrapWire.qrValue, NOW)
  const random = { randomBytes: bytes() }
  const mobileKey = createPairingEphemeralKeyPair(random)
  const proof = createMobilePairingProof({
    bootstrap,
    mobileDeviceId: 'mobile-device-0001' as never,
    capabilities: bootstrap.capabilities,
    mobileKeyPair: mobileKey,
    random,
  })
  const init = {
    type: 'mobile-init',
    version: 2,
    pairingId: bootstrap.pairingId,
    mobileDeviceId: 'mobile-device-0001',
    mobileEphemeralPublicKey: proof.mobileEphemeralPublicKey,
    capabilities: bootstrap.capabilities,
    encryptedProof: proof.encryptedProof,
  }
  return {
    init,
    mobileCipher: createMobileSessionCipher({
      endpoint: 'mobile',
      bootstrap,
      init: init as never,
      localSecretKey: mobileKey.secretKey,
      confirmation: confirmPairingKey(),
      random,
    }),
  }
}

describe('DesktopMobileTransport', () => {
  it('keeps the relay credential in Electron main, requires both approvals, and invokes only the selected local session', async () => {
    const socket = new FakeSocket()
    const calls: unknown[] = []
    let completed = false
    const local = new LocalSessionApi(new URL('http://127.0.0.1:3080/'), async (input, init) => {
      const request = new Request(input, init)
      const body = await request.json()
      calls.push(body)
      if (request.url.endsWith('/api/session.history')) {
        return response({ events: [
          { event: userEvent('Desktop text') },
          ...(completed ? [{ event: assistantEvent('Completed desktop response') }, { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } }] : []),
        ] })
      }
      if (request.url.endsWith('/api/session.prompt')) completed = true
      return response({ accepted: true })
    })
    const pairing = new DesktopPairingBridge({
      relayBaseUrl: 'https://relay.example/',
      now: () => NOW,
      randomBytes: bytes(),
      fetch: async (_input, init) => Response.json({ expiresAt: JSON.parse(init?.body as string).expiresAt }, { status: 201 }),
    })
    const transport = new DesktopMobileTransport(
      pairing,
      local,
      { approvePairing: async () => true, approvePrompt: async () => true },
      (_url, protocols) => {
        expect(protocols).toEqual([
          'dsh-pairing-v2',
          expect.stringMatching(/^dsh-desktop\.[A-Za-z0-9_-]{32,256}$/u),
        ])
        return socket
      },
    )

    const bootstrapWire = await transport.start({ key: 'desktop-session' })
    socket.open()
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'desktop-hello', version: 2 })
    socket.deliver({ type: 'desktop-ready', version: 2, pairingId: bootstrapWire.pairingId, expiresAt: bootstrapWire.expiresAt })

    const bootstrap = parsePairingBootstrap(bootstrapWire.qrValue, NOW)
    const random = { randomBytes: bytes() }
    const mobileKey = createPairingEphemeralKeyPair(random)
    const mobileDeviceId = 'mobile-device-0001'
    const proof = createMobilePairingProof({
      bootstrap,
      mobileDeviceId: mobileDeviceId as never,
      capabilities: bootstrap.capabilities,
      mobileKeyPair: mobileKey,
      random,
    })
    const init = {
      type: 'mobile-init' as const,
      version: 2,
      pairingId: bootstrap.pairingId,
      mobileDeviceId,
      mobileEphemeralPublicKey: proof.mobileEphemeralPublicKey,
      capabilities: bootstrap.capabilities,
      encryptedProof: proof.encryptedProof,
    }
    socket.deliver(init)
    await tick()

    const accept = parseDesktopPairingAccept(JSON.parse(socket.sent.find(value => JSON.parse(value).type === 'desktop-accept')!))
    verifyDesktopPairingProof({ bootstrap, init: init as never, accept, mobileSecretKey: mobileKey.secretKey })
    const mobileCipher = createMobileSessionCipher({
      endpoint: 'mobile',
      bootstrap,
      init: init as never,
      localSecretKey: mobileKey.secretKey,
      confirmation: confirmPairingKey(),
      random,
    })
    const firstFrame = socket.sent.map(value => JSON.parse(value)).find(value => value.ciphertext !== undefined)
    const snapshot = mobileCipher.open(firstFrame)
    expect(snapshot).toMatchObject({ type: 'session-snapshot', messages: [{ text: 'Desktop text' }] })
    if (snapshot.type !== 'session-snapshot') throw new Error('expected snapshot')

    socket.deliver(mobileCipher.seal({
      type: 'send-text',
      sessionHandle: snapshot.sessionHandle,
      requestId: 'request-id-000001',
      text: 'approved mobile text',
    }))
    await tick()
    expect(calls.map(call => (call as { method: string }).method)).toContain('session.prompt')
    expect(calls.find(call => (call as { method: string }).method === 'session.prompt')).toMatchObject({
      payload: { sessionId: 'desktop-session', mode: 'queue', content: [{ type: 'text', text: 'approved mobile text' }] },
    })
    const outgoing = socket.sent.map(value => JSON.parse(value)).filter(value => value.ciphertext !== undefined)
    const completion = mobileCipher.open(outgoing[1])
    expect(completion).toMatchObject({
      type: 'session-snapshot',
      activeTurn: null,
    })
    if (completion.type !== 'session-snapshot') throw new Error('expected completion snapshot')
    expect(completion.messages).toEqual(expect.arrayContaining([{ id: expect.any(String), role: 'assistant', text: 'Completed desktop response' }]))

    socket.deliver(mobileCipher.seal({
      type: 'cancel-turn',
      sessionHandle: snapshot.sessionHandle,
      requestId: 'cancel-request-01',
      turnId: 'turn-id-00000001',
    }))
    await tick()
    const rejected = mobileCipher.open(socket.sent.map(value => JSON.parse(value)).filter(value => value.ciphertext !== undefined)[2])
    expect(rejected).toMatchObject({ type: 'error', code: 'TURN_REJECTED' })
    expect(calls.map(call => (call as { method: string }).method)).not.toContain('session.cancel')
    transport.close()
  })

  it('fails closed and erases pairing state when the native pairing approval rejects', async () => {
    const socket = new FakeSocket()
    const local = new LocalSessionApi(new URL('http://127.0.0.1:3080/'), async (input) => {
      const request = new Request(input)
      return request.url.endsWith('/api/session.history')
        ? response({ events: [] })
        : response({ accepted: true })
    })
    const pairing = new DesktopPairingBridge({
      relayBaseUrl: 'https://relay.example/',
      now: () => NOW,
      randomBytes: bytes(),
      fetch: async (_input, init) => Response.json({ expiresAt: JSON.parse(init?.body as string).expiresAt }, { status: 201 }),
    })
    const transport = new DesktopMobileTransport(
      pairing,
      local,
      { approvePairing: async () => { throw new Error('native dialog unavailable') } },
      () => socket,
    )

    const bootstrapWire = await transport.start({ key: 'desktop-session' })
    const secret = pairing.connection().ephemeralKeyPair.secretKey
    socket.open()
    socket.deliver({ type: 'desktop-ready', version: 2, pairingId: bootstrapWire.pairingId, expiresAt: bootstrapWire.expiresAt })
    const bootstrap = parsePairingBootstrap(bootstrapWire.qrValue, NOW)
    const random = { randomBytes: bytes() }
    const mobileKey = createPairingEphemeralKeyPair(random)
    const proof = createMobilePairingProof({
      bootstrap,
      mobileDeviceId: 'mobile-device-0001' as never,
      capabilities: bootstrap.capabilities,
      mobileKeyPair: mobileKey,
      random,
    })
    socket.deliver({
      type: 'mobile-init',
      version: 2,
      pairingId: bootstrap.pairingId,
      mobileDeviceId: 'mobile-device-0001',
      mobileEphemeralPublicKey: proof.mobileEphemeralPublicKey,
      capabilities: bootstrap.capabilities,
      encryptedProof: proof.encryptedProof,
    })
    await tick()

    expect(transport.state()).toEqual({ status: 'closed', reason: 'failed' })
    expect([...secret]).toEqual(Array.from({ length: secret.byteLength }, () => 0))
    expect(socket.sent.map(value => JSON.parse(value).type)).not.toContain('desktop-accept')
  })

  it('ignores a late frame from a replaced relay socket', async () => {
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const sockets = [firstSocket, secondSocket]
    const local = new LocalSessionApi(new URL('http://127.0.0.1:3080/'), async () => response({ events: [] }))
    const pairing = new DesktopPairingBridge({
      relayBaseUrl: 'https://relay.example/', now: () => NOW, randomBytes: bytes(),
      fetch: async (_input, init) => Response.json({ expiresAt: JSON.parse(init?.body as string).expiresAt }, { status: 201 }),
    })
    const transport = new DesktopMobileTransport(pairing, local, {}, () => sockets.shift()!)

    await transport.start({ key: 'first-session' })
    transport.close()
    await transport.start({ key: 'second-session' })
    firstSocket.deliver({ type: 'relay-error' })
    await tick()

    expect(transport.state()).toEqual({ status: 'creating' })
  })

  it('ignores a late pairing approval after the pairing is replaced', async () => {
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const sockets = [firstSocket, secondSocket]
    let resolveApproval: ((allowed: boolean) => void) | undefined
    const pendingApproval = new Promise<boolean>((resolve) => { resolveApproval = resolve })
    let approvalRequested = false
    const local = new LocalSessionApi(new URL('http://127.0.0.1:3080/'), async () => response({ events: [] }))
    const pairing = new DesktopPairingBridge({
      relayBaseUrl: 'https://relay.example/', now: () => NOW, randomBytes: bytes(),
      fetch: async (_input, init) => Response.json({ expiresAt: JSON.parse(init?.body as string).expiresAt }, { status: 201 }),
    })
    const transport = new DesktopMobileTransport(pairing, local, {
      approvePairing: () => { approvalRequested = true; return pendingApproval },
    }, () => sockets.shift()!)

    const firstWire = await transport.start({ key: 'first-session' })
    firstSocket.open()
    firstSocket.deliver({ type: 'desktop-ready', version: 2, pairingId: firstWire.pairingId, expiresAt: firstWire.expiresAt })
    const { init } = mobileHandshake(firstWire)
    firstSocket.deliver(init)
    await tick()
    expect(approvalRequested).toBe(true)

    transport.close()
    await transport.start({ key: 'second-session' })
    resolveApproval?.(true)
    await tick()

    expect(firstSocket.sent.map(value => JSON.parse(value).type)).not.toContain('desktop-accept')
    expect(transport.state()).toEqual({ status: 'creating' })
  })

  it('does not let a replaced start completion reset the newer pairing', async () => {
    let resolveFirstHistory: ((value: Response) => void) | undefined
    let historyCalls = 0
    const local = new LocalSessionApi(new URL('http://127.0.0.1:3080/'), async () => {
      historyCalls += 1
      if (historyCalls === 1) return new Promise<Response>((resolve) => { resolveFirstHistory = resolve })
      return response({ events: [] })
    })
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const sockets = [firstSocket, secondSocket]
    const pairing = new DesktopPairingBridge({
      relayBaseUrl: 'https://relay.example/', now: () => NOW, randomBytes: bytes(),
      fetch: async (_input, init) => Response.json({ expiresAt: JSON.parse(init?.body as string).expiresAt }, { status: 201 }),
    })
    const transport = new DesktopMobileTransport(pairing, local, {}, () => sockets.shift()!)

    const firstStart = transport.start({ key: 'first-session' })
    await tick()
    transport.close()
    await transport.start({ key: 'second-session' })
    resolveFirstHistory?.(response({ events: [] }))
    await expect(firstStart).rejects.toThrow('was replaced')

    expect(transport.state()).toEqual({ status: 'creating' })
  })

  it('does not let a replaced pairing-creation completion reset the newer pairing', async () => {
    let resolveFirstCreation: ((value: Response) => void) | undefined
    let creationCalls = 0
    const local = new LocalSessionApi(new URL('http://127.0.0.1:3080/'), async () => response({ events: [] }))
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const sockets = [firstSocket, secondSocket]
    const pairing = new DesktopPairingBridge({
      relayBaseUrl: 'https://relay.example/', now: () => NOW, randomBytes: bytes(),
      fetch: async (_input, init) => {
        creationCalls += 1
        const responseValue = Response.json({ expiresAt: JSON.parse(init?.body as string).expiresAt }, { status: 201 })
        if (creationCalls === 1) return new Promise<Response>((resolve) => { resolveFirstCreation = resolve })
        return responseValue
      },
    })
    const transport = new DesktopMobileTransport(pairing, local, {}, () => sockets.shift()!)

    const firstStart = transport.start({ key: 'first-session' })
    await tick()
    transport.close()
    await transport.start({ key: 'second-session' })
    resolveFirstCreation?.(Response.json({ expiresAt: NOW + 240_000 }, { status: 201 }))
    await expect(firstStart).rejects.toThrow('creation was closed')

    expect(transport.state()).toEqual({ status: 'creating' })
  })

  it('ignores late poll history from a replaced pairing attempt', async () => {
    let historyCalls = 0
    let resolveOldPollHistory: ((value: Response) => void) | undefined
    const local = new LocalSessionApi(new URL('http://127.0.0.1:3080/'), async () => {
      historyCalls += 1
      if (historyCalls === 3) return new Promise<Response>((resolve) => { resolveOldPollHistory = resolve })
      return response({ events: [] })
    })
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const sockets = [firstSocket, secondSocket]
    const pairing = new DesktopPairingBridge({
      relayBaseUrl: 'https://relay.example/', now: () => NOW, randomBytes: bytes(),
      fetch: async (_input, init) => Response.json({ expiresAt: JSON.parse(init?.body as string).expiresAt }, { status: 201 }),
    })
    const transport = new DesktopMobileTransport(pairing, local, { approvePairing: async () => true }, () => sockets.shift()!)

    const firstWire = await transport.start({ key: 'first-session' })
    firstSocket.open()
    firstSocket.deliver({ type: 'desktop-ready', version: 2, pairingId: firstWire.pairingId, expiresAt: firstWire.expiresAt })
    firstSocket.deliver(mobileHandshake(firstWire).init)
    await tick()
    expect(transport.state()).toEqual({ status: 'paired' })

    const internals = transport as unknown as {
      currentAttempt(): unknown
      refreshSnapshot(attempt: unknown): Promise<void>
    }
    const oldPoll = internals.refreshSnapshot(internals.currentAttempt())
    await tick()
    transport.close()
    await transport.start({ key: 'second-session' })
    resolveOldPollHistory?.(response({ events: [] }))
    await oldPoll

    expect(transport.state()).toEqual({ status: 'creating' })
  })

  it('does not queue a stale prompt after its pairing is closed and replaced', async () => {
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const sockets = [firstSocket, secondSocket]
    const calls: unknown[] = []
    let resolvePromptApproval: ((allowed: boolean) => void) | undefined
    const pendingPromptApproval = new Promise<boolean>((resolve) => { resolvePromptApproval = resolve })
    let promptApprovalRequested = false
    const local = new LocalSessionApi(new URL('http://127.0.0.1:3080/'), async (input, init) => {
      const request = new Request(input, init)
      const body = await request.json()
      calls.push(body)
      if (request.url.endsWith('/api/session.history')) return response({ events: [] })
      return response({ accepted: true })
    })
    const pairing = new DesktopPairingBridge({
      relayBaseUrl: 'https://relay.example/',
      now: () => NOW,
      randomBytes: bytes(),
      fetch: async (_input, init) => Response.json({ expiresAt: JSON.parse(init?.body as string).expiresAt }, { status: 201 }),
    })
    const transport = new DesktopMobileTransport(
      pairing,
      local,
      {
        approvePairing: async () => true,
        approvePrompt: () => {
          promptApprovalRequested = true
          return pendingPromptApproval
        },
      },
      () => {
        const socket = sockets.shift()
        if (socket === undefined) throw new Error('expected a relay socket')
        return socket
      },
    )

    const firstWire = await transport.start({ key: 'first-session' })
    firstSocket.open()
    firstSocket.deliver({ type: 'desktop-ready', version: 2, pairingId: firstWire.pairingId, expiresAt: firstWire.expiresAt })
    const firstBootstrap = parsePairingBootstrap(firstWire.qrValue, NOW)
    const random = { randomBytes: bytes() }
    const mobileKey = createPairingEphemeralKeyPair(random)
    const proof = createMobilePairingProof({
      bootstrap: firstBootstrap,
      mobileDeviceId: 'mobile-device-0001' as never,
      capabilities: firstBootstrap.capabilities,
      mobileKeyPair: mobileKey,
      random,
    })
    const init = {
      type: 'mobile-init' as const,
      version: 2,
      pairingId: firstBootstrap.pairingId,
      mobileDeviceId: 'mobile-device-0001',
      mobileEphemeralPublicKey: proof.mobileEphemeralPublicKey,
      capabilities: firstBootstrap.capabilities,
      encryptedProof: proof.encryptedProof,
    }
    firstSocket.deliver(init)
    await tick()
    const mobileCipher = createMobileSessionCipher({
      endpoint: 'mobile',
      bootstrap: firstBootstrap,
      init: init as never,
      localSecretKey: mobileKey.secretKey,
      confirmation: confirmPairingKey(),
      random,
    })
    const initialFrame = firstSocket.sent.map(value => JSON.parse(value)).find(value => value.ciphertext !== undefined)
    const initialSnapshot = mobileCipher.open(initialFrame)
    if (initialSnapshot.type !== 'session-snapshot') throw new Error('expected snapshot')

    firstSocket.deliver(mobileCipher.seal({
      type: 'send-text',
      sessionHandle: initialSnapshot.sessionHandle,
      requestId: 'old-request-id-000001',
      text: 'stale mobile text',
    }))
    await tick()
    expect(promptApprovalRequested).toBe(true)

    transport.close()
    await transport.start({ key: 'second-session' })
    resolvePromptApproval?.(true)
    await tick()

    expect(calls.filter(call => (call as { method: string }).method === 'session.prompt')).toEqual([])
    expect(transport.state()).toEqual({ status: 'creating' })
  })
})

async function tick(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}
