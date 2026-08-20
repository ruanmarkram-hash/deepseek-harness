import { env } from 'cloudflare:workers'
import { reset, runInDurableObject, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/index.ts'

const PAIRING_ID = 'pairing_identifier_123'
const DESKTOP_ID = 'desktop_identifier_123'
const MOBILE_ID = 'mobile__identifier_123'
const DESKTOP_RELAY_TOKEN = 'desktop_relay_token_that_is_long_123'
const MOBILE_RELAY_TOKEN = 'mobile_relay_token_that_is_long__123'
const DESKTOP_PUBLIC_KEY = 'WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns'
const MOBILE_PUBLIC_KEY = 'Yl6XjlyOjwJNHQsA0eAsiEvRiHPylqY14_qLUTMZxCI'
const MOBILE_PROOF = 'A'.repeat(55)
const DESKTOP_PROOF = 'A'.repeat(55)

afterEach(async () => {
  await reset()
})

function pairingUrl(path = ''): string {
  return 'https://relay.test/v1/pairings/' + PAIRING_ID + path
}

function creationBody(expiresAt: number): string {
  return JSON.stringify({
    version: 2,
    desktopDeviceId: DESKTOP_ID,
    desktopEphemeralPublicKey: DESKTOP_PUBLIC_KEY,
    mobileRelayToken: MOBILE_RELAY_TOKEN,
    expiresAt,
  })
}

function creationHeaders(): HeadersInit {
  return {
    authorization: 'Bearer ' + DESKTOP_RELAY_TOKEN,
    'cf-connecting-ip': '198.51.100.10',
  }
}

function connectRequest(peer: 'desktop' | 'mobile'): Request {
  const token = peer === 'desktop' ? DESKTOP_RELAY_TOKEN : MOBILE_RELAY_TOKEN
  return new Request(pairingUrl('/connect'), {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': 'dsh-pairing-v2, dsh-' + peer + '.' + token,
    },
  })
}

function onceMessage(socket: WebSocket): Promise<MessageEvent<string>> {
  return new Promise((resolve) => {
    socket.addEventListener('message', event => resolve(event as MessageEvent<string>), {
      once: true,
    })
  })
}

function onceClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener('close', event => resolve(event as CloseEvent), {
      once: true,
    })
  })
}

async function open(peer: 'desktop' | 'mobile'): Promise<WebSocket> {
  const response = await SELF.fetch(connectRequest(peer))
  expect(response.status).toBe(101)
  const socket = response.webSocket
  expect(socket).not.toBeNull()
  socket!.accept()
  return socket!
}

describe('mobile pairing relay v2', () => {
  it('stores only verifiers and bounded routing state for a v2 desktop creation', async () => {
    const expiresAt = Date.now() + 60_000
    const created = await SELF.fetch(pairingUrl(), {
      method: 'POST',
      headers: creationHeaders(),
      body: creationBody(expiresAt),
    })
    expect(created.status).toBe(201)

    const relayEnv = env as unknown as Env
    const stored = await runInDurableObject(
      relayEnv.PAIRINGS.getByName(PAIRING_ID),
      async (_, state) => state.storage.get<Record<string, unknown>>('pairing'),
    )
    expect(stored).toMatchObject({
      pairingId: PAIRING_ID,
      desktopDeviceId: DESKTOP_ID,
      expiresAt,
      status: 'pending',
    })
    expect(JSON.stringify(stored)).not.toContain(DESKTOP_RELAY_TOKEN)
    expect(JSON.stringify(stored)).not.toContain(MOBILE_RELAY_TOKEN)
    expect(JSON.stringify(stored)).not.toContain(DESKTOP_PUBLIC_KEY)
  })

  it('forwards opaque init and accept proofs, gates frames, and erases state on desktop close', async () => {
    const expiresAt = Date.now() + 60_000
    await SELF.fetch(pairingUrl(), {
      method: 'POST',
      headers: creationHeaders(),
      body: creationBody(expiresAt),
    })
    const desktop = await open('desktop')
    const mobile = await open('mobile')

    const desktopReady = onceMessage(desktop)
    desktop.send(JSON.stringify({
      type: 'desktop-hello',
      version: 2,
      pairingId: PAIRING_ID,
      desktopDeviceId: DESKTOP_ID,
    }))
    expect(JSON.parse((await desktopReady).data)).toMatchObject({
      type: 'desktop-ready',
      pairingId: PAIRING_ID,
    })

    const forwardedInit = onceMessage(desktop)
    mobile.send(JSON.stringify({
      type: 'mobile-init',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      mobileEphemeralPublicKey: MOBILE_PUBLIC_KEY,
      capabilities: ['session:read', 'turn:send'],
      encryptedProof: MOBILE_PROOF,
    }))
    expect(JSON.parse((await forwardedInit).data)).toEqual({
      type: 'mobile-init',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      mobileEphemeralPublicKey: MOBILE_PUBLIC_KEY,
      capabilities: ['session:read', 'turn:send'],
      encryptedProof: MOBILE_PROOF,
    })

    const forwardedAccept = onceMessage(mobile)
    desktop.send(JSON.stringify({
      type: 'desktop-accept',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      encryptedProof: DESKTOP_PROOF,
    }))
    expect(JSON.parse((await forwardedAccept).data)).toEqual({
      type: 'desktop-accept',
      version: 2,
      pairingId: PAIRING_ID,
      mobileDeviceId: MOBILE_ID,
      encryptedProof: DESKTOP_PROOF,
    })

    const forwardedFrame = onceMessage(mobile)
    const frame = {
      version: 2,
      pairingId: PAIRING_ID,
      senderDeviceId: DESKTOP_ID,
      recipientDeviceId: MOBILE_ID,
      sequence: 1,
      ciphertext: 'AA',
    }
    desktop.send(JSON.stringify(frame))
    expect(JSON.parse((await forwardedFrame).data)).toEqual(frame)

    const relayEnv = env as unknown as Env
    const stored = await runInDurableObject(
      relayEnv.PAIRINGS.getByName(PAIRING_ID),
      async (_, state) => state.storage.list(),
    )
    expect(JSON.stringify([...stored.values()])).not.toContain(MOBILE_PROOF)
    expect(JSON.stringify([...stored.values()])).not.toContain(DESKTOP_PROOF)
    expect(JSON.stringify([...stored.values()])).not.toContain('AA')

    const revoked = onceMessage(mobile)
    desktop.close()
    expect(JSON.parse((await revoked).data)).toMatchObject({
      type: 'pairing-revoked',
      reason: 'desktop-disconnected',
    })
    await onceClose(mobile)
    const removed = await runInDurableObject(
      relayEnv.PAIRINGS.getByName(PAIRING_ID),
      async (_, state) => state.storage.get('pairing'),
    )
    expect(removed).toBeUndefined()
  })
})
