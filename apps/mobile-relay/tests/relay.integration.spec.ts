import { env } from 'cloudflare:workers'
import { reset, runInDurableObject, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/index.ts'
import { routeV3 } from '../src/v3.ts'
import { routeV3Pairing } from '../src/v3-pairing.ts'

const PAIRING_ID = 'pairing_identifier_123'
const DESKTOP_ID = 'desktop_identifier_123'
const MOBILE_ID = 'mobile__identifier_123'
const DESKTOP_RELAY_TOKEN = 'desktop_relay_token_that_is_long_123'
const MOBILE_RELAY_TOKEN = 'mobile_relay_token_that_is_long__123'
const DESKTOP_PUBLIC_KEY = 'WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns'
const MOBILE_PUBLIC_KEY = 'Yl6XjlyOjwJNHQsA0eAsiEvRiHPylqY14_qLUTMZxCI'
const MOBILE_PROOF = 'A'.repeat(55)
const DESKTOP_PROOF = 'A'.repeat(55)
const ROUTE_ID = 'remote_route_identifier_123'
const HOST_ID = 'host_device_identifier_123'
const DEVICE_ID = 'device_identifier_123'
const HOST_ENROLLMENT_ID = 'host_enrollment_identifier_123'
const DEVICE_ENROLLMENT_ID = 'device_enrollment_identifier_123'
const HOST_TOKEN = 'host_route_token_that_is_long_123456'
const DEVICE_TOKEN = 'device_route_token_that_is_long_123'
const NEXT_HOST_TOKEN = 'next_host_route_token_that_is_long_123'
const NEXT_DEVICE_TOKEN = 'next_device_route_token_that_is_long_12'
const ANYWHERE_PAIRING_ID = 'anywhere_pairing_identifier'
const ANYWHERE_PAIRING_CODE = 'anywhere_pairing_code_that_is_long_123456'
const ANYWHERE_HOST_TOKEN = 'anywhere_host_token_that_is_long_123456789'

afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

describe('V3 anywhere pairing rendezvous', () => {
  it('cancels an oversized chunked public creation body at the fixed byte bound', async () => {
    const chunks = [new Uint8Array(5 * 1024), new Uint8Array(4 * 1024), new Uint8Array([1])]
    let cancelled: unknown
    const request = new Request(anywhereUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + (env as unknown as Env).V3_PROVISIONING_TOKEN },
      body: new ReadableStream<Uint8Array>({
        pull(controller): void {
          const chunk = chunks.shift()
          if (chunk === undefined) controller.close()
          else controller.enqueue(chunk)
        },
        cancel(reason): void { cancelled = reason },
      }, { highWaterMark: 0 }),
    })
    expect(request.headers.get('content-length')).toBeNull()
    const response = await routeV3Pairing(request, env as unknown as Env)
    expect(response.status).toBe(400)
    expect(cancelled).toBe('body-too-large')
    expect(chunks).toHaveLength(1)
  })

  it('rejects a wrong pairing code without consuming the public offer body', async () => {
    const relayEnv = env as unknown as Env
    await SELF.fetch(anywhereUrl(), {
      method: 'POST', headers: { authorization: 'Bearer ' + relayEnv.V3_PROVISIONING_TOKEN },
      body: JSON.stringify({ code: ANYWHERE_PAIRING_CODE, hostToken: ANYWHERE_HOST_TOKEN, expiresAt: Date.now() + 60_000 }),
    })
    const serialized = new TextEncoder().encode(JSON.stringify({
      deviceId: DEVICE_ID,
      label: 'Test iPhone',
      signingPublicKey: MOBILE_PUBLIC_KEY,
      agreementPublicKey: DESKTOP_PUBLIC_KEY,
    }))
    let reads = 0
    const response = await routeV3Pairing(new Request(anywhereUrl('/offer'), {
      method: 'POST',
      headers: { 'x-dsh-pairing-code': 'wrong_pairing_code_that_is_long_1234567' },
      body: new ReadableStream<Uint8Array>({
        pull(controller): void {
          reads += 1
          controller.enqueue(serialized)
          controller.close()
        },
      }, { highWaterMark: 0 }),
    }), relayEnv)
    expect(response.status).toBe(401)
    expect(reads).toBe(0)
  })

  it('rejects absent, malformed, and wrong Host credentials without consuming an invitation body', async () => {
    const relayEnv = env as unknown as Env
    await SELF.fetch(anywhereUrl(), {
      method: 'POST', headers: { authorization: 'Bearer ' + relayEnv.V3_PROVISIONING_TOKEN },
      body: JSON.stringify({ code: ANYWHERE_PAIRING_CODE, hostToken: ANYWHERE_HOST_TOKEN, expiresAt: Date.now() + 60_000 }),
    })
    for (const attempt of [
      { authorization: undefined, status: 400 },
      { authorization: 'Bearer short', status: 400 },
      { authorization: 'Bearer wrong_host_token_that_is_long_123456', status: 401 },
    ]) {
      const counted = countedBody(JSON.stringify(anywhereInvitation()))
      const headers = new Headers()
      if (attempt.authorization !== undefined) headers.set('authorization', attempt.authorization)
      const response = await routeV3Pairing(new Request(anywhereUrl('/invitation'), {
        method: 'POST', headers, body: counted.stream,
      }), relayEnv)
      expect(response.status).toBe(attempt.status)
      expect(counted.reads()).toBe(0)
    }
  })

  it('rechecks pairing state when invitation publication races with deletion after preflight', async () => {
    const relayEnv = env as unknown as Env
    const pairing = relayEnv.V3_PAIRINGS.getByName(ANYWHERE_PAIRING_ID)
    await SELF.fetch(anywhereUrl(), {
      method: 'POST', headers: { authorization: 'Bearer ' + relayEnv.V3_PROVISIONING_TOKEN },
      body: JSON.stringify({ code: ANYWHERE_PAIRING_CODE, hostToken: ANYWHERE_HOST_TOKEN, expiresAt: Date.now() + 60_000 }),
    })
    let raced = false
    const racingEnv = {
      ...relayEnv,
      V3_PAIRINGS: {
        getByName(): { fetch(request: Request): Promise<Response> } {
          return {
            async fetch(request): Promise<Response> {
              const response = await pairing.fetch(request)
              if (request.headers.get('x-dsh-v3-pairing-action') === 'authorize-invitation' && response.status === 204) {
                await runInDurableObject(pairing, async (_, state) => state.storage.deleteAll())
                raced = true
              }
              return response
            },
          }
        },
      },
    } as unknown as Env
    const response = await routeV3Pairing(new Request(anywhereUrl('/invitation'), {
      method: 'POST', headers: { authorization: 'Bearer ' + ANYWHERE_HOST_TOKEN },
      body: JSON.stringify(anywhereInvitation()),
    }), racingEnv)
    expect(raced).toBe(true)
    expect(response.status).toBe(404)
  })

  it('rejects absent, malformed, and wrong pairing codes without consuming an acknowledgement body', async () => {
    const relayEnv = env as unknown as Env
    await createAnywherePairing(relayEnv)
    for (const attempt of [
      { code: undefined, status: 400 },
      { code: 'short', status: 400 },
      { code: 'wrong_pairing_code_that_is_long_1234567', status: 401 },
    ]) {
      const counted = countedBody('')
      const headers = new Headers()
      if (attempt.code !== undefined) headers.set('x-dsh-pairing-code', attempt.code)
      const response = await routeV3Pairing(new Request(anywhereUrl('/invitation'), {
        method: 'POST', headers, body: counted.stream,
      }), relayEnv)
      expect(response.status).toBe(attempt.status)
      expect(counted.reads()).toBe(0)
    }
  })

  it('acknowledges an invitation through credential preflight and reauthentication', async () => {
    const relayEnv = env as unknown as Env
    await publishAnywhereInvitation(relayEnv)
    const counted = countedBody('')
    const response = await routeV3Pairing(new Request(anywhereUrl('/invitation'), {
      method: 'POST', headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE }, body: counted.stream,
    }), relayEnv)
    expect(response.status).toBe(204)
    expect(counted.reads()).toBe(1)
    expect((await SELF.fetch(anywhereUrl('/invitation'), {
      headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE },
    })).status).toBe(404)
  })

  it('rechecks pairing state when acknowledgement races with deletion after preflight', async () => {
    const relayEnv = env as unknown as Env
    await publishAnywhereInvitation(relayEnv)
    const pairing = relayEnv.V3_PAIRINGS.getByName(ANYWHERE_PAIRING_ID)
    let raced = false
    const racingEnv = {
      ...relayEnv,
      V3_PAIRINGS: {
        getByName(): { fetch(request: Request): Promise<Response> } {
          return {
            async fetch(request): Promise<Response> {
              const response = await pairing.fetch(request)
              if (request.headers.get('x-dsh-v3-pairing-action') === 'authorize-acknowledgement'
                && response.status === 204) {
                await runInDurableObject(pairing, async (_, state) => state.storage.deleteAll())
                raced = true
              }
              return response
            },
          }
        },
      },
    } as unknown as Env
    const counted = countedBody('')
    const response = await routeV3Pairing(new Request(anywhereUrl('/invitation'), {
      method: 'POST', headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE }, body: counted.stream,
    }), racingEnv)
    expect(raced).toBe(true)
    expect(counted.reads()).toBe(1)
    expect(response.status).toBe(404)
  })

  it('exchanges only a public offer and a phone-safe invitation using one short-lived QR/code capability', async () => {
    const expiry = Date.now() + 60_000
    const created = await SELF.fetch(anywhereUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + (env as unknown as Env).V3_PROVISIONING_TOKEN },
      body: JSON.stringify({ code: ANYWHERE_PAIRING_CODE, hostToken: ANYWHERE_HOST_TOKEN, expiresAt: expiry }),
    })
    expect(created.status).toBe(201)

    const submitted = await SELF.fetch(anywhereUrl('/offer'), {
      method: 'POST', headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE },
      body: JSON.stringify({ deviceId: DEVICE_ID, label: 'Ruan’s iPhone', signingPublicKey: MOBILE_PUBLIC_KEY, agreementPublicKey: DESKTOP_PUBLIC_KEY }),
    })
    expect(submitted.status).toBe(204)

    const receivedOffer = await SELF.fetch(anywhereUrl('/offer'), { headers: { authorization: 'Bearer ' + ANYWHERE_HOST_TOKEN } })
    expect(await receivedOffer.json()).toEqual({ deviceId: DEVICE_ID, label: 'Ruan’s iPhone', signingPublicKey: MOBILE_PUBLIC_KEY, agreementPublicKey: DESKTOP_PUBLIC_KEY })

    const invitation = anywhereInvitation()
    const published = await SELF.fetch(anywhereUrl('/invitation'), {
      method: 'POST', headers: { authorization: 'Bearer ' + ANYWHERE_HOST_TOKEN }, body: JSON.stringify(invitation),
    })
    expect(published.status).toBe(204)
    const fetched = await SELF.fetch(anywhereUrl('/invitation'), { headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE } })
    expect(await fetched.json()).toEqual(invitation)

    expect((await SELF.fetch(anywhereUrl('/invitation'), { headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE } })).status).toBe(200)
    expect((await SELF.fetch(anywhereUrl('/invitation'), { method: 'POST', headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE } })).status).toBe(204)
    expect((await SELF.fetch(anywhereUrl('/invitation'), { headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE } })).status).toBe(404)
  })

  it('accepts exactly one of two concurrent valid offers', async () => {
    const relayEnv = env as unknown as Env
    await createAnywherePairing(relayEnv)
    const pairing = relayEnv.V3_PAIRINGS.getByName(ANYWHERE_PAIRING_ID)
    const offer = (label: string): string => JSON.stringify({
      deviceId: DEVICE_ID,
      label,
      signingPublicKey: MOBILE_PUBLIC_KEY,
      agreementPublicKey: DESKTOP_PUBLIC_KEY,
    })
    const bodies = concurrentBodies(offer('Candidate A'), offer('Candidate B'))
    const result = await runInDurableObject(pairing, async (instance, state) => {
      const subject = instance as unknown as {
        submitOffer(request: Request, pairingId: string): Promise<Response>
      }
      const responses = await Promise.all(bodies.map(body => subject.submitOffer(new Request('https://relay.test/internal', {
        method: 'POST', headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE }, body,
      }), ANYWHERE_PAIRING_ID)))
      const stored = await state.storage.get<{ offer: { label: string } }>('pairing')
      return { statuses: responses.map(response => response.status).sort(), label: stored?.offer.label }
    })
    expect(result.statuses).toEqual([204, 409])
    expect(['Candidate A', 'Candidate B']).toContain(result.label)
  })

  it('accepts exactly one of two concurrent valid invitation publications', async () => {
    const relayEnv = env as unknown as Env
    await submitAnywhereOffer(relayEnv)
    const pairing = relayEnv.V3_PAIRINGS.getByName(ANYWHERE_PAIRING_ID)
    const first = JSON.stringify(anywhereInvitation())
    const second = JSON.stringify({ ...anywhereInvitation(), ciphertext: 'C'.repeat(160) })
    const bodies = concurrentBodies(first, second)
    const result = await runInDurableObject(pairing, async (instance, state) => {
      const subject = instance as unknown as {
        publishInvitation(request: Request, pairingId: string): Promise<Response>
      }
      const responses = await Promise.all(bodies.map(body => subject.publishInvitation(new Request('https://relay.test/internal', {
        method: 'POST', headers: { authorization: 'Bearer ' + ANYWHERE_HOST_TOKEN }, body,
      }), ANYWHERE_PAIRING_ID)))
      const stored = await state.storage.get<{ invitation: { ciphertext: string } }>('pairing')
      return { statuses: responses.map(response => response.status).sort(), ciphertext: stored?.invitation.ciphertext }
    })
    expect(result.statuses).toEqual([204, 409])
    expect(['B'.repeat(160), 'C'.repeat(160)]).toContain(result.ciphertext)
  })

  it('does not let a stale invitation publication resurrect acknowledged pairing state', async () => {
    const relayEnv = env as unknown as Env
    await submitAnywhereOffer(relayEnv)
    const pairing = relayEnv.V3_PAIRINGS.getByName(ANYWHERE_PAIRING_ID)
    const result = await runInDurableObject(pairing, async (instance, state) => {
      const subject = instance as unknown as {
        publishInvitation(request: Request, pairingId: string): Promise<Response>
        acknowledgeInvitation(request: Request, pairingId: string): Promise<Response>
      }
      let entered!: () => void
      const bodyEntered = new Promise<void>((resolve) => { entered = resolve })
      let release!: () => void
      const bodyRelease = new Promise<void>((resolve) => { release = resolve })
      const stale = subject.publishInvitation(new Request('https://relay.test/internal', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + ANYWHERE_HOST_TOKEN },
        body: new ReadableStream<Uint8Array>({
          async pull(controller): Promise<void> {
            entered()
            await bodyRelease
            controller.enqueue(new TextEncoder().encode(JSON.stringify(anywhereInvitation())))
            controller.close()
          },
        }, { highWaterMark: 0 }),
      }), ANYWHERE_PAIRING_ID)
      await bodyEntered
      const published = await subject.publishInvitation(new Request('https://relay.test/internal', {
        method: 'POST', headers: { authorization: 'Bearer ' + ANYWHERE_HOST_TOKEN },
        body: JSON.stringify({ ...anywhereInvitation(), ciphertext: 'C'.repeat(160) }),
      }), ANYWHERE_PAIRING_ID)
      const acknowledged = await subject.acknowledgeInvitation(new Request('https://relay.test/internal', {
        method: 'POST', headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE },
      }), ANYWHERE_PAIRING_ID)
      release()
      const staleResponse = await stale
      return {
        published: published.status,
        acknowledged: acknowledged.status,
        stale: staleResponse.status,
        stored: await state.storage.get('pairing'),
      }
    })
    expect(result).toEqual({ published: 204, acknowledged: 204, stale: 404, stored: undefined })
  })

  it('retains neither pairing capability nor a usable device route credential', async () => {
    const relayEnv = env as unknown as Env
    await SELF.fetch(anywhereUrl(), {
      method: 'POST', headers: { authorization: 'Bearer ' + relayEnv.V3_PROVISIONING_TOKEN },
      body: JSON.stringify({ code: ANYWHERE_PAIRING_CODE, hostToken: ANYWHERE_HOST_TOKEN, expiresAt: Date.now() + 60_000 }),
    })
    const stored = await runInDurableObject(relayEnv.V3_PAIRINGS.getByName(ANYWHERE_PAIRING_ID), async (_, state) => state.storage.get<Record<string, unknown>>('pairing'))
    expect(JSON.stringify(stored)).not.toContain(ANYWHERE_PAIRING_CODE)
    expect(JSON.stringify(stored)).not.toContain(ANYWHERE_HOST_TOKEN)
    expect(JSON.stringify(stored)).not.toContain(DEVICE_TOKEN)
    await SELF.fetch(anywhereUrl('/offer'), { method: 'POST', headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE }, body: JSON.stringify({ deviceId: DEVICE_ID, label: 'Ruan’s iPhone', signingPublicKey: MOBILE_PUBLIC_KEY, agreementPublicKey: DESKTOP_PUBLIC_KEY }) })
    const invitation = anywhereInvitation()
    expect((await SELF.fetch(anywhereUrl('/invitation'), { method: 'POST', headers: { authorization: 'Bearer ' + ANYWHERE_HOST_TOKEN }, body: JSON.stringify(invitation) })).status).toBe(204)
    const published = await runInDurableObject(relayEnv.V3_PAIRINGS.getByName(ANYWHERE_PAIRING_ID), async (_, state) => state.storage.get<Record<string, unknown>>('pairing'))
    expect(JSON.stringify(published)).not.toContain(DEVICE_TOKEN)
  })
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

function remoteRouteBody(generation?: number, hostToken = HOST_TOKEN, deviceToken = DEVICE_TOKEN): string {
  return JSON.stringify({
    version: 3, hostDeviceId: HOST_ID, hostEnrollmentId: HOST_ENROLLMENT_ID, deviceId: DEVICE_ID, deviceEnrollmentId: DEVICE_ENROLLMENT_ID,
    hostToken, deviceToken,
    ...(generation === undefined ? {} : { generation }),
  })
}

function countedBody(serialized: string): { readonly stream: ReadableStream<Uint8Array>; reads(): number } {
  const bytes = new TextEncoder().encode(serialized)
  let count = 0
  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller): void {
        count += 1
        controller.enqueue(bytes)
        controller.close()
      },
    }, { highWaterMark: 0 }),
    reads: () => count,
  }
}

function concurrentBodies(first: string, second: string): readonly [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>] {
  let arrivals = 0
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const stream = (serialized: string): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      arrivals += 1
      if (arrivals === 2) release()
      await barrier
      controller.enqueue(new TextEncoder().encode(serialized))
      controller.close()
    },
  }, { highWaterMark: 0 })
  return [stream(first), stream(second)]
}

function remoteRouteRequest(action: 'create' | 'rotate' | 'revoke', body?: string): Request {
  return new Request('https://relay.test/internal', {
    method: action === 'revoke' ? 'DELETE' : 'POST',
    headers: {
      'x-dsh-remote-action': action,
      'x-dsh-remote-route-id': ROUTE_ID,
      ...(action === 'create' ? {} : { authorization: 'Bearer ' + HOST_TOKEN }),
    },
    ...(body === undefined ? {} : { body }),
  })
}

function remoteConnectRequest(peer: 'host' | 'device', token?: string): Request {
  const value = token ?? (peer === 'host' ? HOST_TOKEN : DEVICE_TOKEN)
  return new Request('https://relay.test/v3/routes/' + ROUTE_ID + '/connect', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'dsh-remote-v3, dsh-' + peer + '.' + value },
  })
}

async function openRemote(peer: 'host' | 'device'): Promise<WebSocket> {
  const response = await SELF.fetch(remoteConnectRequest(peer))
  expect(response.status).toBe(101)
  const socket = response.webSocket
  expect(socket).not.toBeNull()
  socket!.accept()
  return socket!
}

function relayFrame(
  type: 'hello' | 'welcome' | 'ready' | 'finish' | 'ack' | 'commit' | 'confirm' | 'receipt' | 'ciphertext',
  senderDeviceId: string,
  recipientDeviceId: string,
  sequence?: number,
  epoch = 1,
): Record<string, unknown> {
  const base = {
    version: 3, type, routeId: ROUTE_ID, generation: 1, connectionEpoch: epoch,
    senderDeviceId, senderEnrollmentId: senderDeviceId === HOST_ID ? HOST_ENROLLMENT_ID : DEVICE_ENROLLMENT_ID,
    recipientDeviceId, recipientEnrollmentId: recipientDeviceId === HOST_ID ? HOST_ENROLLMENT_ID : DEVICE_ENROLLMENT_ID,
  }
  if (type === 'hello' || type === 'welcome') return { ...base, ephemeralPublicKey: DESKTOP_PUBLIC_KEY, nonce: 'A'.repeat(16) }
  if (type === 'ready' || type === 'finish' || type === 'ack' || type === 'commit' || type === 'confirm' || type === 'receipt') return { ...base, nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(23) }
  return { ...base, sequence, nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(23) }
}

async function establishRemote(host: WebSocket, device: WebSocket, epoch = 1): Promise<void> {
  const hello = onceMessage(host)
  device.send(JSON.stringify(relayFrame('hello', DEVICE_ID, HOST_ID, undefined, epoch)))
  await hello
  const welcome = onceMessage(device)
  host.send(JSON.stringify(relayFrame('welcome', HOST_ID, DEVICE_ID, undefined, epoch)))
  await welcome
  const ready = onceMessage(host)
  device.send(JSON.stringify(relayFrame('ready', DEVICE_ID, HOST_ID, undefined, epoch)))
  await ready
  const finish = onceMessage(device)
  host.send(JSON.stringify(relayFrame('finish', HOST_ID, DEVICE_ID, undefined, epoch)))
  await finish
  const ack = onceMessage(host)
  device.send(JSON.stringify(relayFrame('ack', DEVICE_ID, HOST_ID, undefined, epoch)))
  await ack
  const commit = onceMessage(device)
  host.send(JSON.stringify(relayFrame('commit', HOST_ID, DEVICE_ID, undefined, epoch)))
  await commit
  const confirm = onceMessage(host)
  device.send(JSON.stringify(relayFrame('confirm', DEVICE_ID, HOST_ID, undefined, epoch)))
  await confirm
  const receipt = onceMessage(device)
  host.send(JSON.stringify(relayFrame('receipt', HOST_ID, DEVICE_ID, undefined, epoch)))
  await receipt
}

function anywhereUrl(path = ''): string {
  return 'https://relay.test/v3/pairings/' + ANYWHERE_PAIRING_ID + path
}

function anywhereInvitation(): Record<string, unknown> {
  return {
    version: 1, hostStaticAgreementPublicKey: DESKTOP_PUBLIC_KEY,
    nonce: 'A'.repeat(16), ciphertext: 'B'.repeat(160),
  }
}

async function createAnywherePairing(relayEnv: Env): Promise<void> {
  const response = await SELF.fetch(anywhereUrl(), {
    method: 'POST', headers: { authorization: 'Bearer ' + relayEnv.V3_PROVISIONING_TOKEN },
    body: JSON.stringify({ code: ANYWHERE_PAIRING_CODE, hostToken: ANYWHERE_HOST_TOKEN, expiresAt: Date.now() + 60_000 }),
  })
  expect(response.status).toBe(201)
}

async function publishAnywhereInvitation(relayEnv: Env): Promise<void> {
  await submitAnywhereOffer(relayEnv)
  expect((await SELF.fetch(anywhereUrl('/invitation'), {
    method: 'POST', headers: { authorization: 'Bearer ' + ANYWHERE_HOST_TOKEN },
    body: JSON.stringify(anywhereInvitation()),
  })).status).toBe(204)
}

async function submitAnywhereOffer(relayEnv: Env): Promise<void> {
  await createAnywherePairing(relayEnv)
  expect((await SELF.fetch(anywhereUrl('/offer'), {
    method: 'POST', headers: { 'x-dsh-pairing-code': ANYWHERE_PAIRING_CODE },
    body: JSON.stringify({
      deviceId: DEVICE_ID,
      label: 'Test iPhone',
      signingPublicKey: MOBILE_PUBLIC_KEY,
      agreementPublicKey: DESKTOP_PUBLIC_KEY,
    }),
  })).status).toBe(204)
}

describe('V3 credential-first body audit', () => {
  it('keeps every authenticated public body route credential-first', async () => {
    const relayEnv = env as unknown as Env
    await createAnywherePairing(relayEnv)
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    expect((await route.fetch(remoteRouteRequest('create', remoteRouteBody()))).status).toBe(201)

    const wrongCode = 'wrong_pairing_code_that_is_long_1234567'
    const wrongHost = 'wrong_host_route_token_that_is_long_12345'
    const attempts: readonly {
      readonly name: string
      readonly body: string
      readonly invoke: (body: ReadableStream<Uint8Array>) => Promise<Response>
    }[] = [
      {
        name: 'pairing creation', body: '{}',
        invoke: body => routeV3Pairing(new Request(anywhereUrl(), {
          method: 'POST', headers: { authorization: 'Bearer wrong_provisioning_token_that_is_long_12' }, body,
        }), relayEnv),
      },
      {
        name: 'offer submission', body: '{}',
        invoke: body => routeV3Pairing(new Request(anywhereUrl('/offer'), {
          method: 'POST', headers: { 'x-dsh-pairing-code': wrongCode }, body,
        }), relayEnv),
      },
      {
        name: 'invitation publication', body: '{}',
        invoke: body => routeV3Pairing(new Request(anywhereUrl('/invitation'), {
          method: 'POST', headers: { authorization: 'Bearer ' + wrongHost }, body,
        }), relayEnv),
      },
      {
        name: 'invitation acknowledgement', body: '',
        invoke: body => routeV3Pairing(new Request(anywhereUrl('/invitation'), {
          method: 'POST', headers: { 'x-dsh-pairing-code': wrongCode }, body,
        }), relayEnv),
      },
      {
        name: 'route creation', body: '{}',
        invoke: body => routeV3(new Request('https://relay.test/v3/routes/audit_route_identifier_123', {
          method: 'POST', headers: { authorization: 'Bearer wrong_provisioning_token_that_is_long_12' }, body,
        }), relayEnv),
      },
      {
        name: 'route rotation', body: '{}',
        invoke: body => routeV3(new Request('https://relay.test/v3/routes/' + ROUTE_ID + '/rotate', {
          method: 'POST', headers: { authorization: 'Bearer ' + wrongHost }, body,
        }), relayEnv),
      },
    ]

    for (const attempt of attempts) {
      const counted = countedBody(attempt.body)
      const response = await attempt.invoke(counted.stream)
      expect(response.status, attempt.name).toBeGreaterThanOrEqual(400)
      expect(counted.reads(), attempt.name).toBe(0)
    }
  })
})

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

describe('trusted remote relay v3', () => {
  it('keeps the oldest deadline on connect and advances it when that pending peer closes', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const now = vi.spyOn(Date, 'now')
    const startedAt = 1_800_000_000_000
    const alarms = await runInDurableObject(route, async (instance, state) => {
      const subject = instance as unknown as {
        openConnection(request: Request, id: string): Promise<Response>
        webSocketClose(socket: WebSocket): Promise<void>
      }
      now.mockReturnValue(startedAt)
      expect((await subject.openConnection(remoteConnectRequest('host'), ROUTE_ID)).status).toBe(101)
      const first = await state.storage.getAlarm()

      now.mockReturnValue(startedAt + 29_999)
      expect((await subject.openConnection(remoteConnectRequest('device'), ROUTE_ID)).status).toBe(101)
      const afterConnect = await state.storage.getAlarm()
      const host = state.getWebSockets().find((socket) => {
        const attachment = socket.deserializeAttachment() as { peer?: string } | null
        return attachment?.peer === 'host'
      })
      expect(host).toBeDefined()
      await subject.webSocketClose(host!)
      return { first, afterConnect, afterClose: await state.storage.getAlarm() }
    })
    expect(alarms).toEqual({
      first: startedAt + 30_000,
      afterConnect: startedAt + 30_000,
      afterClose: startedAt + 59_999,
    })
  })

  it('replaces an expired pending peer before delayed alarm delivery', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const now = vi.spyOn(Date, 'now')
    const startedAt = 1_800_000_000_000
    const result = await runInDurableObject(route, async (instance, state) => {
      const subject = instance as unknown as {
        openConnection(request: Request, id: string): Promise<Response>
      }
      now.mockReturnValue(startedAt)
      expect((await subject.openConnection(remoteConnectRequest('host'), ROUTE_ID)).status).toBe(101)
      now.mockReturnValue(startedAt + 30_000)
      const replacement = await subject.openConnection(remoteConnectRequest('host'), ROUTE_ID)
      return { replacement: replacement.status, alarm: await state.storage.getAlarm() }
    })
    expect(result).toEqual({ replacement: 101, alarm: startedAt + 60_000 })
  })

  it('fences a delayed expired-peer close while preserving current-peer close reset', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const now = vi.spyOn(Date, 'now')
    const startedAt = 1_800_000_000_000
    const result = await runInDurableObject(route, async (instance, state) => {
      const subject = instance as unknown as {
        openConnection(request: Request, id: string): Promise<Response>
        webSocketClose(socket: WebSocket): Promise<void>
        webSocketMessage(socket: WebSocket, raw: string): Promise<void>
      }
      const open = async (peer: 'host' | 'device'): Promise<Response> => {
        const response = await subject.openConnection(remoteConnectRequest(peer), ROUTE_ID)
        response.webSocket?.accept()
        return response
      }
      const attachment = (socket: WebSocket): { peer?: string; supersededBy?: string | null } => (
        socket.deserializeAttachment() as { peer?: string; supersededBy?: string | null }
      )

      now.mockReturnValue(startedAt)
      expect((await open('host')).status).toBe(101)
      const expiredHost = state.getWebSockets().find(socket => attachment(socket).peer === 'host')
      expect(expiredHost).toBeDefined()
      now.mockReturnValue(startedAt + 1)
      expect((await open('device')).status).toBe(101)
      now.mockReturnValue(startedAt + 30_000)
      expect((await open('host')).status).toBe(101)
      const replacementHost = state.getWebSockets().find((socket) => {
        const value = attachment(socket)
        return value.peer === 'host' && value.supersededBy === null
      })
      const device = state.getWebSockets().find((socket) => {
        const value = attachment(socket)
        return value.peer === 'device' && value.supersededBy === null
      })
      expect(replacementHost).toBeDefined()
      expect(device).toBeDefined()

      await subject.webSocketMessage(device!, JSON.stringify(relayFrame('hello', DEVICE_ID, HOST_ID)))
      const afterHello = await state.storage.get<Record<string, unknown>>('route')
      await subject.webSocketClose(expiredHost!)
      const afterStaleClose = await state.storage.get<Record<string, unknown>>('route')
      const replacementReadyState = replacementHost!.readyState
      await subject.webSocketClose(replacementHost!)
      const afterCurrentClose = await state.storage.get<Record<string, unknown>>('route')
      return { afterHello, afterStaleClose, afterCurrentClose, replacementReadyState }
    })
    expect(result.afterHello).toMatchObject({ activeEpoch: 1, handshake: 'hello' })
    expect(result.afterStaleClose).toMatchObject({ activeEpoch: 1, handshake: 'hello' })
    expect(result.replacementReadyState).toBe(WebSocket.OPEN)
    expect(result.afterCurrentClose).toMatchObject({ activeEpoch: null, handshake: 'none' })
  })

  it('expires the oldest pending peer so its replacement is no longer rejected', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const now = vi.spyOn(Date, 'now')
    const startedAt = 1_800_000_000_000
    const result = await runInDurableObject(route, async (instance, state) => {
      const subject = instance as unknown as {
        alarm(): Promise<void>
        openConnection(request: Request, id: string): Promise<Response>
      }
      now.mockReturnValue(startedAt)
      expect((await subject.openConnection(remoteConnectRequest('host'), ROUTE_ID)).status).toBe(101)
      now.mockReturnValue(startedAt + 29_999)
      expect((await subject.openConnection(remoteConnectRequest('device'), ROUTE_ID)).status).toBe(101)
      const scheduled = await state.storage.getAlarm()
      now.mockReturnValue(startedAt + 30_000)
      await subject.alarm()
      const replacement = await subject.openConnection(remoteConnectRequest('host'), ROUTE_ID)
      return { scheduled, replacement: replacement.status }
    })
    expect(result).toEqual({ scheduled: startedAt + 30_000, replacement: 101 })
  })

  it('does not let a stale-incarnation close alter the current route alarm', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const now = vi.spyOn(Date, 'now')
    const startedAt = 1_800_000_000_000
    const alarms = await runInDurableObject(route, async (instance, state) => {
      const subject = instance as unknown as {
        openConnection(request: Request, id: string): Promise<Response>
        rotate(request: Request, id: string): Promise<Response>
        webSocketClose(socket: WebSocket): Promise<void>
      }
      now.mockReturnValue(startedAt)
      expect((await subject.openConnection(remoteConnectRequest('host'), ROUTE_ID)).status).toBe(101)
      const stale = state.getWebSockets()[0]
      expect(stale).toBeDefined()
      expect((await subject.rotate(
        remoteRouteRequest('rotate', remoteRouteBody(2, NEXT_HOST_TOKEN, NEXT_DEVICE_TOKEN)),
        ROUTE_ID,
      )).status).toBe(200)

      now.mockReturnValue(startedAt + 100)
      expect((await subject.openConnection(remoteConnectRequest('host', NEXT_HOST_TOKEN), ROUTE_ID)).status).toBe(101)
      const beforeClose = await state.storage.getAlarm()
      await subject.webSocketClose(stale!)
      return { beforeClose, afterClose: await state.storage.getAlarm() }
    })
    expect(alarms).toEqual({
      beforeClose: startedAt + 30_100,
      afterClose: startedAt + 30_100,
    })
  })

  it('accepts exactly one of two concurrent route creations', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    const bodies = concurrentBodies(
      remoteRouteBody(),
      remoteRouteBody(undefined, NEXT_HOST_TOKEN, NEXT_DEVICE_TOKEN),
    )
    const statuses = await runInDurableObject(route, async (instance) => {
      const subject = instance as unknown as { create(request: Request, id: string): Promise<Response> }
      const responses = await Promise.all(bodies.map(body => subject.create(new Request('https://relay.test/internal', {
        method: 'POST', body,
      }), ROUTE_ID)))
      return responses.map(response => response.status).sort((left, right) => left - right)
    })
    expect(statuses).toEqual([201, 409])
  })

  it('does not let an old-token revoke delete a concurrently rotated route', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const statuses = await runInDurableObject(route, async (instance) => {
      const subject = instance as unknown as {
        metadata(): Promise<unknown>
        revoke(request: Request, id: string): Promise<Response>
        rotate(request: Request, id: string): Promise<Response>
      }
      const originalMetadata = subject.metadata.bind(subject)
      let entered!: () => void
      const barrierEntered = new Promise<void>((resolve) => { entered = resolve })
      let release!: () => void
      const barrierRelease = new Promise<void>((resolve) => { release = resolve })
      let first = true
      subject.metadata = async (): Promise<unknown> => {
        if (!first) return originalMetadata()
        first = false
        const stale = await originalMetadata()
        entered()
        await barrierRelease
        return stale
      }
      const staleRevoke = subject.revoke(remoteRouteRequest('revoke'), ROUTE_ID)
      await barrierEntered
      const rotated = await subject.rotate(
        remoteRouteRequest('rotate', remoteRouteBody(2, NEXT_HOST_TOKEN, NEXT_DEVICE_TOKEN)),
        ROUTE_ID,
      )
      release()
      return { rotated: rotated.status, revoked: (await staleRevoke).status }
    })
    expect(statuses).toEqual({ rotated: 200, revoked: 401 })
    expect((await SELF.fetch(remoteConnectRequest('host', NEXT_HOST_TOKEN))).status).toBe(101)
  })

  it('rejects a stale connection continuation after route rotation', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const response = await runInDurableObject(route, async (instance) => {
      const subject = instance as unknown as {
        metadata(): Promise<unknown>
        openConnection(request: Request, id: string): Promise<Response>
        rotate(request: Request, id: string): Promise<Response>
      }
      const originalMetadata = subject.metadata.bind(subject)
      const stale = await originalMetadata()
      expect((await subject.rotate(
        remoteRouteRequest('rotate', remoteRouteBody(2, NEXT_HOST_TOKEN, NEXT_DEVICE_TOKEN)),
        ROUTE_ID,
      )).status).toBe(200)
      let first = true
      subject.metadata = async (): Promise<unknown> => {
        if (first) { first = false; return stale }
        return originalMetadata()
      }
      return subject.openConnection(remoteConnectRequest('host'), ROUTE_ID)
    })
    expect(response.status).toBe(401)
  })

  it('rejects a stale connection continuation after route revocation', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const response = await runInDurableObject(route, async (instance) => {
      const subject = instance as unknown as {
        metadata(): Promise<unknown>
        openConnection(request: Request, id: string): Promise<Response>
        revoke(request: Request, id: string): Promise<Response>
      }
      const originalMetadata = subject.metadata.bind(subject)
      const stale = await originalMetadata()
      expect((await subject.revoke(remoteRouteRequest('revoke'), ROUTE_ID)).status).toBe(204)
      let first = true
      subject.metadata = async (): Promise<unknown> => {
        if (first) { first = false; return stale }
        return originalMetadata()
      }
      return subject.openConnection(remoteConnectRequest('host'), ROUTE_ID)
    })
    expect(response.status).toBe(401)
  })

  it('rejects stale socket attachments after a route is revoked and recreated', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const handshake = await runInDurableObject(route, async (instance, state) => {
      const subject = instance as unknown as {
        metadata(): Promise<Record<string, unknown> | undefined>
        create(request: Request, id: string): Promise<Response>
        revoke(request: Request, id: string): Promise<Response>
        webSocketMessage(socket: WebSocket, raw: string): Promise<void>
      }
      const stale = await subject.metadata()
      expect(stale).toBeDefined()
      expect((await subject.revoke(remoteRouteRequest('revoke'), ROUTE_ID)).status).toBe(204)
      expect((await subject.create(remoteRouteRequest('create', remoteRouteBody()), ROUTE_ID)).status).toBe(201)
      const connectedAt = Date.now()
      const attachment = (peer: 'host' | 'device'): Record<string, unknown> => ({
        version: 3,
        connectionId: 'stale_' + peer + '_connection',
        supersededBy: null,
        routeId: ROUTE_ID,
        routeVersion: 3,
        routeGeneration: 1,
        routeSalt: stale!.tokenSalt,
        peer,
        deviceId: peer === 'host' ? HOST_ID : DEVICE_ID,
        enrollmentId: peer === 'host' ? HOST_ENROLLMENT_ID : DEVICE_ENROLLMENT_ID,
        epoch: null,
        connectedAt,
        rateWindowStartedAt: connectedAt,
        messagesInWindow: 0,
      })
      const host = new WebSocketPair()[1]
      host.serializeAttachment(attachment('host'))
      state.acceptWebSocket(host)
      const device = new WebSocketPair()[1]
      device.serializeAttachment(attachment('device'))
      state.acceptWebSocket(device)
      await subject.webSocketMessage(device, JSON.stringify(relayFrame('hello', DEVICE_ID, HOST_ID)))
      return (await state.storage.get<{ handshake: string }>('route'))?.handshake
    })
    expect(handshake).toBe('none')
  })

  it('reports an already deleted route as absent when the Host retries revoke recovery', async () => {
    const relayEnv = env as unknown as Env
    const routeUrl = 'https://relay.test/v3/routes/' + ROUTE_ID
    const created = await SELF.fetch(new Request(routeUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + relayEnv.V3_PROVISIONING_TOKEN },
      body: remoteRouteBody(),
    }))
    expect(created.status).toBe(201)

    const revoke = (credential = HOST_TOKEN): Promise<Response> => SELF.fetch(new Request(routeUrl, {
      method: 'DELETE',
      headers: { authorization: 'Bearer ' + credential },
    }))
    expect((await revoke(NEXT_HOST_TOKEN)).status).toBe(401)
    expect((await revoke()).status).toBe(204)
    const recovered = await revoke()
    expect(recovered.status).toBe(404)
    expect(await recovered.json()).toEqual({ error: 'not-found' })
  })

  it('rejects a streamed route-rotation body once it crosses the fixed control bound', async () => {
    const relayEnv = env as unknown as Env
    await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    const bytes = new TextEncoder().encode('x'.repeat(9 * 1024))
    const response = await SELF.fetch(new Request('https://relay.test/v3/routes/' + ROUTE_ID + '/rotate', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + HOST_TOKEN },
      body: new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
    }))
    expect(response.status).toBe(400)
  })

  it('rejects absent, malformed, and wrong Host credentials without consuming a rotation body', async () => {
    const relayEnv = env as unknown as Env
    await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    for (const attempt of [
      { authorization: undefined, status: 401 },
      { authorization: 'Bearer short', status: 401 },
      { authorization: 'Bearer wrong_route_token_that_is_long_123456', status: 401 },
    ]) {
      const counted = countedBody(remoteRouteBody(2, NEXT_HOST_TOKEN, NEXT_DEVICE_TOKEN))
      const headers = new Headers()
      if (attempt.authorization !== undefined) headers.set('authorization', attempt.authorization)
      const response = await routeV3(new Request('https://relay.test/v3/routes/' + ROUTE_ID + '/rotate', {
        method: 'POST', headers, body: counted.stream,
      }), relayEnv)
      expect(response.status).toBe(attempt.status)
      expect(counted.reads()).toBe(0)
    }
  })

  it('rechecks the Host credential when rotation races with a successful intervening rotation', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    let raced = false
    const racingEnv = {
      ...relayEnv,
      REMOTE_ROUTES: {
        getByName(): { fetch(request: Request): Promise<Response> } {
          return {
            async fetch(request): Promise<Response> {
              const response = await route.fetch(request)
              if (request.headers.get('x-dsh-remote-action') === 'authorize-rotation' && response.status === 204) {
                expect((await route.fetch(remoteRouteRequest(
                  'rotate',
                  remoteRouteBody(2, NEXT_HOST_TOKEN, NEXT_DEVICE_TOKEN),
                ))).status).toBe(200)
                raced = true
              }
              return response
            },
          }
        },
      },
    } as unknown as Env
    const response = await routeV3(new Request('https://relay.test/v3/routes/' + ROUTE_ID + '/rotate', {
      method: 'POST', headers: { authorization: 'Bearer ' + HOST_TOKEN },
      body: remoteRouteBody(2, 'outer_host_route_token_that_is_long_123', 'outer_device_route_token_that_is_long_1'),
    }), racingEnv)
    expect(raced).toBe(true)
    expect(response.status).toBe(401)
    expect((await SELF.fetch(remoteConnectRequest('host', NEXT_HOST_TOKEN))).status).toBe(101)
  })

  it('allows exactly one concurrent rotation to commit from the same old credential snapshot', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const alternateHostToken = 'alternate_host_route_token_that_is_long_123'
    const alternateDeviceToken = 'alternate_device_route_token_that_is_long_12'
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const rotation = (hostToken: string, deviceToken: string): Request => new Request('https://relay.test/internal', {
      method: 'POST',
      headers: {
        'x-dsh-remote-action': 'rotate',
        'x-dsh-remote-route-id': ROUTE_ID,
        authorization: 'Bearer ' + HOST_TOKEN,
      },
      body: new ReadableStream<Uint8Array>({
        async pull(controller): Promise<void> {
          arrivals += 1
          if (arrivals === 2) release()
          await barrier
          controller.enqueue(new TextEncoder().encode(remoteRouteBody(2, hostToken, deviceToken)))
          controller.close()
        },
      }, { highWaterMark: 0 }),
    })

    const statuses = await runInDurableObject(route, async (instance) => {
      const subject = instance as unknown as {
        rotate(request: Request, id: string): Promise<Response>
      }
      const responses = await Promise.all([
        subject.rotate(rotation(NEXT_HOST_TOKEN, NEXT_DEVICE_TOKEN), ROUTE_ID),
        subject.rotate(rotation(alternateHostToken, alternateDeviceToken), ROUTE_ID),
      ])
      return responses.map(response => response.status).sort((left, right) => left - right)
    })
    expect(statuses).toEqual([200, 401])

    const connectionStatuses = await Promise.all([
      SELF.fetch(remoteConnectRequest('host', NEXT_HOST_TOKEN)),
      SELF.fetch(remoteConnectRequest('host', alternateHostToken)),
    ])
    expect(connectionStatuses.map(response => response.status).sort((left, right) => left - right)).toEqual([101, 401])
  })

  it('rotates a route through the public credential preflight path', async () => {
    const relayEnv = env as unknown as Env
    await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    const response = await routeV3(new Request('https://relay.test/v3/routes/' + ROUTE_ID + '/rotate', {
      method: 'POST', headers: { authorization: 'Bearer ' + HOST_TOKEN },
      body: remoteRouteBody(2, NEXT_HOST_TOKEN, NEXT_DEVICE_TOKEN),
    }), relayEnv)
    expect(response.status).toBe(200)
    expect((await SELF.fetch(remoteConnectRequest('host', NEXT_HOST_TOKEN))).status).toBe(101)
  })

  it('keeps route credentials as verifiers, forwards only opaque handshake/ciphertext messages, and retains no ciphertext', async () => {
    const relayEnv = env as unknown as Env
    const created = await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    expect(created.status).toBe(201)
    const host = await openRemote('host')
    const device = await openRemote('device')

    await establishRemote(host, device)

    const forwarded = onceMessage(host)
    device.send(JSON.stringify(relayFrame('ciphertext', DEVICE_ID, HOST_ID, 1)))
    expect(JSON.parse((await forwarded).data)).toMatchObject({ type: 'ciphertext', sequence: 1 })

    const stored = await runInDurableObject(
      relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID),
      async (_, state) => state.storage.list(),
    )
    const serialized = JSON.stringify([...stored.values()])
    expect(serialized).not.toContain(HOST_TOKEN)
    expect(serialized).not.toContain(DEVICE_TOKEN)
    expect(serialized).not.toContain('A'.repeat(23))
  })

  it('requires an established epoch and exact next ciphertext sequence', async () => {
    const relayEnv = env as unknown as Env
    await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    const host = await openRemote('host')
    const device = await openRemote('device')
    const denied = onceMessage(host)
    const closed = onceClose(host)
    host.send(JSON.stringify(relayFrame('ciphertext', HOST_ID, DEVICE_ID, 1)))
    expect(JSON.parse((await denied).data)).toMatchObject({ type: 'route-revoked', reason: 'handshake-denied' })
    await closed
    device.close()

    const hostAgain = await openRemote('host')
    const deviceAgain = await openRemote('device')
    await establishRemote(hostAgain, deviceAgain)
    const first = onceMessage(hostAgain)
    deviceAgain.send(JSON.stringify(relayFrame('ciphertext', DEVICE_ID, HOST_ID, 1)))
    await first
    const rejected = onceMessage(deviceAgain)
    deviceAgain.send(JSON.stringify(relayFrame('ciphertext', DEVICE_ID, HOST_ID, 1)))
    expect(JSON.parse((await rejected).data)).toMatchObject({ type: 'route-revoked', reason: 'sequence-denied' })
  })

  it('rotates both route credentials, changes generation, and immediately rejects old connections', async () => {
    const relayEnv = env as unknown as Env
    await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    const host = await openRemote('host')
    const device = await openRemote('device')
    const hostClosed = onceClose(host)
    const deviceClosed = onceClose(device)
    const rotated = await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(
      remoteRouteRequest('rotate', remoteRouteBody(2, NEXT_HOST_TOKEN, NEXT_DEVICE_TOKEN)),
    )
    expect(rotated.status).toBe(200)
    expect(await hostClosed).toMatchObject({ code: 4403 })
    expect(await deviceClosed).toMatchObject({ code: 4403 })
    expect((await SELF.fetch(remoteConnectRequest('host'))).status).toBe(401)
    expect((await SELF.fetch(remoteConnectRequest('host', NEXT_HOST_TOKEN))).status).toBe(101)
  })

  it('closes the surviving peer and resets the epoch when one authenticated side disconnects', async () => {
    const relayEnv = env as unknown as Env
    await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    const host = await openRemote('host')
    const device = await openRemote('device')
    await establishRemote(host, device)
    const forwarded = onceMessage(host)
    device.send(JSON.stringify(relayFrame('ciphertext', DEVICE_ID, HOST_ID, 1)))
    await forwarded

    const deviceClosed = onceClose(device)
    host.close()
    expect(await deviceClosed).toMatchObject({ code: 4403 })
    const stored = await runInDurableObject(
      relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID),
      async (_, state) => state.storage.list(),
    )
    expect([...stored.keys()].some(key => key.startsWith('v3-sequence:'))).toBe(false)

    const nextHost = await openRemote('host')
    const nextDevice = await openRemote('device')
    await establishRemote(nextHost, nextDevice, 2)
  })

  it('refuses elevated epochs and permits the exact next epoch after hostile attempts', async () => {
    const relayEnv = env as unknown as Env
    await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    const host = await openRemote('host')
    const device = await openRemote('device')
    const denied = onceMessage(device)
    const hostClosed = onceClose(host)
    device.send(JSON.stringify(relayFrame('hello', DEVICE_ID, HOST_ID, undefined, 2_147_483_647)))
    expect(JSON.parse((await denied).data)).toMatchObject({ type: 'route-revoked', reason: 'handshake-denied' })
    await hostClosed

    const nextHost = await openRemote('host')
    const nextDevice = await openRemote('device')
    await establishRemote(nextHost, nextDevice, 1)
  })

  it('does not commit an epoch when the device closes after finish but before acknowledgement', async () => {
    const relayEnv = env as unknown as Env
    await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    const host = await openRemote('host')
    const device = await openRemote('device')
    const hello = onceMessage(host)
    device.send(JSON.stringify(relayFrame('hello', DEVICE_ID, HOST_ID)))
    await hello
    const welcome = onceMessage(device)
    host.send(JSON.stringify(relayFrame('welcome', HOST_ID, DEVICE_ID)))
    await welcome
    const ready = onceMessage(host)
    device.send(JSON.stringify(relayFrame('ready', DEVICE_ID, HOST_ID)))
    await ready
    const finish = onceMessage(device)
    host.send(JSON.stringify(relayFrame('finish', HOST_ID, DEVICE_ID)))
    await finish
    const hostClosed = onceClose(host)
    device.close()
    await hostClosed

    const nextHost = await openRemote('host')
    const nextDevice = await openRemote('device')
    await establishRemote(nextHost, nextDevice, 1)
  })

  it('keeps an epoch pending when the device never confirms the Host commit', async () => {
    const relayEnv = env as unknown as Env
    await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    const host = await openRemote('host')
    const device = await openRemote('device')
    const hello = onceMessage(host)
    device.send(JSON.stringify(relayFrame('hello', DEVICE_ID, HOST_ID)))
    await hello
    const welcome = onceMessage(device)
    host.send(JSON.stringify(relayFrame('welcome', HOST_ID, DEVICE_ID)))
    await welcome
    const ready = onceMessage(host)
    device.send(JSON.stringify(relayFrame('ready', DEVICE_ID, HOST_ID)))
    await ready
    const finish = onceMessage(device)
    host.send(JSON.stringify(relayFrame('finish', HOST_ID, DEVICE_ID)))
    await finish
    const ack = onceMessage(host)
    device.send(JSON.stringify(relayFrame('ack', DEVICE_ID, HOST_ID)))
    await ack
    const commit = onceMessage(device)
    host.send(JSON.stringify(relayFrame('commit', HOST_ID, DEVICE_ID)))
    await commit
    const hostClosed = onceClose(host)
    device.close()
    await hostClosed

    const nextHost = await openRemote('host')
    const nextDevice = await openRemote('device')
    await establishRemote(nextHost, nextDevice, 1)
  })

  it('permits the Host-authoritative next epoch after an interrupted finality receipt', async () => {
    const relayEnv = env as unknown as Env
    await relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID).fetch(remoteRouteRequest('create', remoteRouteBody()))
    const host = await openRemote('host')
    const device = await openRemote('device')
    const hello = onceMessage(host)
    device.send(JSON.stringify(relayFrame('hello', DEVICE_ID, HOST_ID)))
    await hello
    const welcome = onceMessage(device)
    host.send(JSON.stringify(relayFrame('welcome', HOST_ID, DEVICE_ID)))
    await welcome
    const ready = onceMessage(host)
    device.send(JSON.stringify(relayFrame('ready', DEVICE_ID, HOST_ID)))
    await ready
    const finish = onceMessage(device)
    host.send(JSON.stringify(relayFrame('finish', HOST_ID, DEVICE_ID)))
    await finish
    const ack = onceMessage(host)
    device.send(JSON.stringify(relayFrame('ack', DEVICE_ID, HOST_ID)))
    await ack
    const commit = onceMessage(device)
    host.send(JSON.stringify(relayFrame('commit', HOST_ID, DEVICE_ID)))
    await commit
    const confirm = onceMessage(host)
    device.send(JSON.stringify(relayFrame('confirm', DEVICE_ID, HOST_ID)))
    await confirm
    const stored = await runInDurableObject(
      relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID),
      async (_, state) => state.storage.get<Record<string, unknown>>('route'),
    )
    expect(stored).toMatchObject({ pendingFinalityEpoch: 1, handshake: 'confirm' })
    const hostClosed = onceClose(host)
    device.close()
    await hostClosed

    const nextHost = await openRemote('host')
    const nextDevice = await openRemote('device')
    await establishRemote(nextHost, nextDevice, 2)
  })

  it('times out a hello-welcome stall and permits a new epoch', async () => {
    const relayEnv = env as unknown as Env
    const route = relayEnv.REMOTE_ROUTES.getByName(ROUTE_ID)
    await route.fetch(remoteRouteRequest('create', remoteRouteBody()))
    const host = await openRemote('host')
    const device = await openRemote('device')
    const hello = onceMessage(host)
    device.send(JSON.stringify(relayFrame('hello', DEVICE_ID, HOST_ID, undefined, 1)))
    await hello
    const welcome = onceMessage(device)
    host.send(JSON.stringify(relayFrame('welcome', HOST_ID, DEVICE_ID, undefined, 1)))
    await welcome

    const hostClosed = onceClose(host)
    const deviceClosed = onceClose(device)
    await runInDurableObject(route, async (instance, state) => {
      const metadata = await state.storage.get<Record<string, unknown>>('route')
      await state.storage.put('route', { ...metadata, handshakeStartedAt: Date.now() - 30_001 })
      await (instance as unknown as { alarm(): Promise<void> }).alarm()
    })
    expect(await hostClosed).toMatchObject({ code: 4403 })
    expect(await deviceClosed).toMatchObject({ code: 4403 })

    const nextHost = await openRemote('host')
    const nextDevice = await openRemote('device')
    const nextHello = onceMessage(nextHost)
    nextDevice.send(JSON.stringify(relayFrame('hello', DEVICE_ID, HOST_ID, undefined, 1)))
    expect(JSON.parse((await nextHello).data)).toMatchObject({ type: 'hello', connectionEpoch: 1 })
  })
})
