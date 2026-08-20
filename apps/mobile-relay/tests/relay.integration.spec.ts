import { env } from 'cloudflare:workers'
import { reset, runInDurableObject, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/index.ts'

const PAIRING_ID = 'pairing_identifier_123'
const DESKTOP_ID = 'desktop_identifier_123'
const MOBILE_ID = 'mobile__identifier_123'
const DESKTOP_RELAY_TOKEN = 'desktop_relay_token_that_is_long_123'
const MOBILE_RELAY_TOKEN = 'mobile_relay_token_that_is_long__123'

afterEach(async () => {
  await reset()
})

function pairingUrl(path = ''): string {
  return `https://relay.test/v1/pairings/${PAIRING_ID}${path}`
}

function pairingUrlFor(pairingId: string, path = ''): string {
  return `https://relay.test/v1/pairings/${pairingId}${path}`
}

function creationHeaders(clientIp = '198.51.100.10'): HeadersInit {
  return {
    authorization: `Bearer ${DESKTOP_RELAY_TOKEN}`,
    'cf-connecting-ip': clientIp,
  }
}

function connectRequest(peer: 'desktop' | 'mobile'): Request {
  const token = peer === 'desktop' ? DESKTOP_RELAY_TOKEN : MOBILE_RELAY_TOKEN
  return new Request(pairingUrl('/connect'), {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': `dsh-pairing-v1, dsh-${peer}.${token}`,
    },
  })
}

function onceMessage(socket: WebSocket): Promise<MessageEvent<string>> {
  return new Promise(resolve => socket.addEventListener('message', event => resolve(event as MessageEvent<string>), { once: true }))
}

function onceClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise(resolve => socket.addEventListener('close', event => resolve(event as CloseEvent), { once: true }))
}

async function open(peer: 'desktop' | 'mobile'): Promise<WebSocket> {
  const response = await SELF.fetch(connectRequest(peer))
  expect(response.status).toBe(101)
  const socket = response.webSocket
  expect(socket).not.toBeNull()
  socket!.accept()
  return socket!
}

describe('mobile pairing relay', () => {
  it('rate-limits one network before the third room is allocated', async () => {
    const expiresAt = Date.now() + 60_000
    const body = JSON.stringify({ version: 1, desktopDeviceId: DESKTOP_ID, mobileRelayToken: MOBILE_RELAY_TOKEN, expiresAt })
    for (const pairingId of ['pairing_identifier_001', 'pairing_identifier_002']) {
      const response = await SELF.fetch(pairingUrlFor(pairingId), { method: 'POST', headers: creationHeaders(), body })
      expect(response.status).toBe(201)
    }
    const deniedId = 'pairing_identifier_003'
    const denied = await SELF.fetch(pairingUrlFor(deniedId), { method: 'POST', headers: creationHeaders(), body })
    expect(denied.status).toBe(429)

    const relayEnv = env as unknown as Env
    const stored = await runInDurableObject(relayEnv.PAIRINGS.getByName(deniedId), async (_, state) => state.storage.get('pairing'))
    expect(stored).toBeUndefined()
  })

  it('enforces the globally serialized allocation budget across network addresses', async () => {
    const expiresAt = Date.now() + 60_000
    const body = JSON.stringify({ version: 1, desktopDeviceId: DESKTOP_ID, mobileRelayToken: MOBILE_RELAY_TOKEN, expiresAt })
    for (let index = 0; index < 20; index += 1) {
      const pairingId = `global_pairing_${String(index).padStart(4, '0')}`
      const response = await SELF.fetch(pairingUrlFor(pairingId), {
        method: 'POST',
        headers: creationHeaders(`198.51.100.${index + 20}`),
        body,
      })
      expect(response.status).toBe(201)
    }
    const denied = await SELF.fetch(pairingUrlFor('global_pairing_9999'), {
      method: 'POST',
      headers: creationHeaders('198.51.100.99'),
      body,
    })
    expect(denied.status).toBe(429)
  })

  it('rejects an oversized streamed creation body before it persists a room', async () => {
    const response = await SELF.fetch(pairingUrl(), {
      method: 'POST',
      headers: creationHeaders(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('A'.repeat(4_097)))
          controller.close()
        },
      }),
    })
    expect(response.status).toBe(413)

    const relayEnv = env as unknown as Env
    const stored = await runInDurableObject(relayEnv.PAIRINGS.getByName(PAIRING_ID), async (_, state) => state.storage.get('pairing'))
    expect(stored).toBeUndefined()
  })

  it('caps one pending connection per mobile credential and recovers after close', async () => {
    const expiresAt = Date.now() + 60_000
    await SELF.fetch(pairingUrl(), {
      method: 'POST',
      headers: creationHeaders(),
      body: JSON.stringify({ version: 1, desktopDeviceId: DESKTOP_ID, mobileRelayToken: MOBILE_RELAY_TOKEN, expiresAt }),
    })

    const first = await open('mobile')
    const denied = await SELF.fetch(connectRequest('mobile'))
    expect(denied.status).toBe(409)
    const closed = onceClose(first)
    first.send('{')
    await closed

    const recovered = await SELF.fetch(connectRequest('mobile'))
    expect(recovered.status).toBe(101)
    recovered.webSocket?.accept()
    recovered.webSocket?.close()
  })

  it('does not let the QR mobile credential identify as the desktop', async () => {
    const expiresAt = Date.now() + 60_000
    await SELF.fetch(pairingUrl(), {
      method: 'POST',
      headers: creationHeaders(),
      body: JSON.stringify({ version: 1, desktopDeviceId: DESKTOP_ID, mobileRelayToken: MOBILE_RELAY_TOKEN, expiresAt }),
    })

    const mobile = await open('mobile')
    const closed = onceClose(mobile)
    mobile.send(JSON.stringify({ type: 'desktop-hello', version: 1, pairingId: PAIRING_ID, desktopDeviceId: DESKTOP_ID }))
    expect((await closed).code).toBe(4400)
  })

  it('rejects pairing creation when desktop and QR credentials are equal', async () => {
    const response = await SELF.fetch(pairingUrl(), {
      method: 'POST',
      headers: creationHeaders(),
      body: JSON.stringify({
        version: 1,
        desktopDeviceId: DESKTOP_ID,
        mobileRelayToken: DESKTOP_RELAY_TOKEN,
        expiresAt: Date.now() + 60_000,
      }),
    })
    expect(response.status).toBe(400)
  })

  it('keeps a one-way verifier, requires desktop acceptance, forwards opaque frames, and revokes on desktop disconnect', async () => {
    const expiresAt = Date.now() + 60_000
    const created = await SELF.fetch(pairingUrl(), {
      method: 'POST',
      headers: creationHeaders(),
      body: JSON.stringify({ version: 1, desktopDeviceId: DESKTOP_ID, mobileRelayToken: MOBILE_RELAY_TOKEN, expiresAt }),
    })
    expect(created.status).toBe(201)

    const relayEnv = env as unknown as Env
    const stored = await runInDurableObject(relayEnv.PAIRINGS.getByName(PAIRING_ID), async (_, state) => state.storage.get<Record<string, unknown>>('pairing'))
    expect(stored).toMatchObject({ pairingId: PAIRING_ID, desktopDeviceId: DESKTOP_ID, expiresAt, status: 'pending' })
    expect(JSON.stringify(stored)).not.toContain(DESKTOP_RELAY_TOKEN)
    expect(JSON.stringify(stored)).not.toContain(MOBILE_RELAY_TOKEN)
    expect(stored).toHaveProperty('desktopTokenVerifier')
    expect(stored).toHaveProperty('mobileTokenVerifier')

    const desktop = await open('desktop')
    const mobile = await open('mobile')
    const desktopReady = onceMessage(desktop)
    desktop.send(JSON.stringify({ type: 'desktop-hello', version: 1, pairingId: PAIRING_ID, desktopDeviceId: DESKTOP_ID }))
    expect(JSON.parse((await desktopReady).data)).toMatchObject({ type: 'desktop-ready', pairingId: PAIRING_ID })

    const requested = onceMessage(desktop)
    mobile.send(JSON.stringify({
      type: 'mobile-request',
      version: 1,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      capabilities: ['session:read', 'turn:send'],
    }))
    expect(JSON.parse((await requested).data)).toMatchObject({ type: 'mobile-request', mobileDeviceId: MOBILE_ID, capabilities: ['session:read', 'turn:send'] })

    const accepted = onceMessage(mobile)
    desktop.send(JSON.stringify({ type: 'desktop-accept', version: 1, pairingId: PAIRING_ID, mobileDeviceId: MOBILE_ID }))
    expect(JSON.parse((await accepted).data)).toMatchObject({ type: 'pairing-accepted', pairingId: PAIRING_ID })

    const forwarded = onceMessage(mobile)
    const frame = { version: 1, pairingId: PAIRING_ID, senderDeviceId: DESKTOP_ID, recipientDeviceId: MOBILE_ID, sequence: 1, ciphertext: 'AA' }
    desktop.send(JSON.stringify(frame))
    expect(JSON.parse((await forwarded).data)).toEqual(frame)

    const replayClosed = onceClose(desktop)
    const revoked = onceMessage(mobile)
    desktop.send(JSON.stringify(frame))
    expect((await replayClosed).code).toBe(4400)
    expect(JSON.parse((await revoked).data)).toMatchObject({ type: 'pairing-revoked', reason: 'desktop-disconnected' })
  })
})
