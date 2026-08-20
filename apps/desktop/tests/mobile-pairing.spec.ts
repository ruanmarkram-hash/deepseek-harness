import { describe, expect, it } from 'vitest'
import { parsePairingBootstrap } from '@deepseek-ai/dsh-pairing-protocol'
import { DesktopPairingBridge, desktopPairingRelayUrls } from '../src/mobile-pairing.ts'

const RELAY_BASE_URL = 'https://dsh-mobile-relay.example.workers.dev/'
const NOW = 1_800_000_000_000

function byteSource(): (size: number) => Uint8Array {
  let value = 1
  return size => Uint8Array.from({ length: size }, () => value++)
}

function decodeQr(qrValue: string): Record<string, unknown> {
  const payload = qrValue.slice('dsh-pairing:v2:'.length)
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

function pairingInternals(bridge: DesktopPairingBridge): {
  active?: { ephemeralKeyPair: { secretKey: Uint8Array } }
  pending?: { ephemeralKeyPair: { secretKey: Uint8Array } }
} {
  return bridge as unknown as {
    active?: { ephemeralKeyPair: { secretKey: Uint8Array } }
    pending?: { ephemeralKeyPair: { secretKey: Uint8Array } }
  }
}

function expectErased(value: Uint8Array): void {
  expect([...value]).toEqual(Array.from({ length: value.byteLength }, () => 0))
}

describe('desktopPairingRelayUrls', () => {
  it('derives HTTPS creation and WSS QR URLs from one configured relay origin', () => {
    expect(desktopPairingRelayUrls(RELAY_BASE_URL)).toEqual({
      createUrl: new URL('https://dsh-mobile-relay.example.workers.dev/v1/pairings/'),
      qrRelayUrl: 'wss://dsh-mobile-relay.example.workers.dev/',
    })
  })

  it.each([
    'http://relay.example/',
    'https://relay.example/route',
    'https://user@relay.example/',
    'https://relay.example/?token=secret',
  ])('rejects an unsafe relay base URL: %s', (value) => {
    expect(() => desktopPairingRelayUrls(value)).toThrow('requires an HTTPS relay origin')
  })
})

describe('DesktopPairingBridge', () => {
  it('keeps the desktop credential private and returns a protocol-compatible mobile QR bootstrap', async () => {
    let request: Request | undefined
    let requestBody: unknown
    const bridge = new DesktopPairingBridge({
      relayBaseUrl: RELAY_BASE_URL,
      now: () => NOW,
      randomBytes: byteSource(),
      fetch: async (input, init) => {
        request = new Request(input, init)
        requestBody = await request.json()
        return Response.json({ expiresAt: (requestBody as { expiresAt: number }).expiresAt }, { status: 201 })
      },
    })

    expect(bridge.state()).toEqual({ status: 'idle' })
    const bootstrap = await bridge.create()
    const qr = decodeQr(bootstrap.qrValue)
    const creation = requestBody as {
      desktopEphemeralPublicKey: string
      mobileRelayToken: string
    }
    const mobileRelayToken = creation.mobileRelayToken

    expect(request?.url).toBe(`https://dsh-mobile-relay.example.workers.dev/v1/pairings/${bootstrap.pairingId}`)
    expect(request?.redirect).toBe('error')
    expect(request?.headers.get('authorization')).toMatch(/^Bearer [A-Za-z0-9_-]{32,256}$/u)
    expect(requestBody).toEqual({
      version: 2,
      desktopDeviceId: bootstrap.desktopDeviceId,
      desktopEphemeralPublicKey: creation.desktopEphemeralPublicKey,
      mobileRelayToken,
      expiresAt: NOW + 240_000,
    })
    expect(qr).toEqual({
      version: 2,
      relayUrl: 'wss://dsh-mobile-relay.example.workers.dev/',
      pairingId: bootstrap.pairingId,
      desktopDeviceId: bootstrap.desktopDeviceId,
      desktopEphemeralPublicKey: expect.stringMatching(/^[A-Za-z0-9_-]{32,256}$/u),
      relayToken: expect.stringMatching(/^[A-Za-z0-9_-]{32,256}$/u),
      expiresAt: NOW + 240_000,
      capabilities: ['session:read', 'session:subscribe', 'turn:send', 'turn:cancel'],
    })
    expect(requestBody).not.toHaveProperty('desktopRelayToken')
    expect(request?.headers.get('authorization')).not.toContain(mobileRelayToken)
    expect(qr.relayToken).toBe(mobileRelayToken)
    expect(qr.desktopEphemeralPublicKey).toBe(creation.desktopEphemeralPublicKey)
    expect(parsePairingBootstrap(bootstrap.qrValue, NOW)).toMatchObject({
      pairingId: bootstrap.pairingId,
      desktopDeviceId: bootstrap.desktopDeviceId,
      desktopEphemeralPublicKey: creation.desktopEphemeralPublicKey,
      relayToken: mobileRelayToken,
      expiresAt: NOW + 240_000,
    })
    expect(bridge.state()).toEqual({
      status: 'ready',
      pairingId: bootstrap.pairingId,
      desktopDeviceId: bootstrap.desktopDeviceId,
      expiresAt: NOW + 240_000,
    })
    expect(JSON.stringify(bridge.state())).not.toContain(qr.relayToken as string)
  })

  it('fails closed on relay rejection, has no overlapping creation, and clears the retained desktop credential', async () => {
    let resolveRequest: (() => void) | undefined
    const bridge = new DesktopPairingBridge({
      relayBaseUrl: RELAY_BASE_URL,
      now: () => NOW,
      randomBytes: byteSource(),
      fetch: async () => new Promise<Response>((resolve) => {
        resolveRequest = () => {
          resolve(Response.json({ expiresAt: NOW + 240_000 }, { status: 201 }))
        }
      }),
    })

    const creation = bridge.create()
    expect(bridge.state()).toEqual({ status: 'creating' })
    await expect(bridge.create()).rejects.toThrow('already being created')
    const pendingSecret = pairingInternals(bridge).pending?.ephemeralKeyPair.secretKey
    expect(pendingSecret).toBeDefined()
    bridge.close()
    expectErased(pendingSecret!)
    resolveRequest?.()
    await expect(creation).rejects.toThrow('creation was closed')
    expect(bridge.state()).toEqual({ status: 'idle' })

    let failedSecret: Uint8Array | undefined
    const rejected = new DesktopPairingBridge({
      relayBaseUrl: RELAY_BASE_URL,
      now: () => NOW,
      randomBytes: byteSource(),
      fetch: async () => {
        failedSecret = pairingInternals(rejected).pending?.ephemeralKeyPair.secretKey
        return Response.json({ error: 'rate-limited' }, { status: 429 })
      },
    })
    await expect(rejected.create()).rejects.toThrow('was rejected by the relay')
    expect(failedSecret).toBeDefined()
    expectErased(failedSecret!)
    expect(rejected.state()).toEqual({ status: 'failed', reason: 'relay-rejected' })
  })

  it('expires and clears the retained credential before creating another pairing', async () => {
    let now = NOW
    let requests = 0
    const bridge = new DesktopPairingBridge({
      relayBaseUrl: RELAY_BASE_URL,
      now: () => now,
      randomBytes: byteSource(),
      fetch: async (_, init) => {
        requests += 1
        const body = JSON.parse(init?.body as string) as { expiresAt: number }
        return Response.json({ expiresAt: body.expiresAt }, { status: 201 })
      },
    })

    await bridge.create()
    const activeSecret = pairingInternals(bridge).active?.ephemeralKeyPair.secretKey
    expect(activeSecret).toBeDefined()
    now += 240_000
    expect(bridge.state()).toEqual({ status: 'idle' })
    expectErased(activeSecret!)
    await bridge.create()
    expect(requests).toBe(2)
  })

  it('rejects a relay response that arrives after the QR bootstrap expires', async () => {
    let now = NOW
    const bridge = new DesktopPairingBridge({
      relayBaseUrl: RELAY_BASE_URL,
      now: () => now,
      randomBytes: byteSource(),
      fetch: async (_, init) => {
        const body = JSON.parse(init?.body as string) as { expiresAt: number }
        now = body.expiresAt
        return Response.json({ expiresAt: body.expiresAt }, { status: 201 })
      },
    })

    await expect(bridge.create()).rejects.toThrow('expired before the relay responded')
    expect(bridge.state()).toEqual({ status: 'failed', reason: 'relay-response-invalid' })
  })
})
