/**
 * Hosted FD199 mirror proof, end to end across two real `dsh web` children:
 * the launcher accepts the hosted argv contract with descriptors inflated to
 * exactly 198/199, the scripted authority walks prepare→release→activate,
 * the child binds descriptor 198 to its remote gateway, and a session created
 * through the desktop HTTP carrier is returned identically through the V3
 * remote path — one configured Host serving both surfaces.
 */

import { spawn, type StdioOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, readdir, lstat, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import net from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeFrame, encodeAuthorityFrame } from '../../../packages/mobile/remote-host-fd199/src/protocol.ts'
import {
  parseWebRuntimeBootstrap, parseWebRuntimeRegistry, webRuntimeBootstrapPath, type WebRuntimeRegistryRecord,
} from '../src/web-runtime-registry.ts'
import { parseHostedSettings } from '../src/hosted-settings.ts'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

const HOST_APP_PATH = '/tmp/dsh-host-fd199-mirror.app/Contents/MacOS/DSH Host'
const DEVICE = 'remote_device_0001'
const ROUTE = 'remote_route_fd19901'
const CONNECTION = 'remote_connection_fd1'
const DEVICE_ENROLLMENT = 'device_enrollmentfd1'
const HOST_ENROLLMENT = 'host_enrollment_fd1'
const SIGNING_KEY = Buffer.from(new Uint8Array(32).fill(1)).toString('base64url')
const AGREEMENT_KEY = Buffer.from(new Uint8Array(32).fill(2)).toString('base64url')
const COPIED_STATE_ONLY = process.env.DSH_FD199_COPIED_STATE_ONLY === '1'

const WIRE_KIND = {
  'runtime.ready': 1,
  'route.upsert': 2,
  'epoch.begin': 4,
  'epoch.begun': 5,
  'epoch.commit': 6,
  'epoch.committed': 7,
  'connection.open': 8,
  'connection.frame': 9,
  'connection.send': 11,
  'device.enroll': 14,
  'device.enrolled': 15,
  'enrollment.seed': 16,
} as const

type WireKind = keyof typeof WIRE_KIND

interface IncomingRecord {
  readonly kind: number
  readonly metadata: Record<string, unknown>
  readonly payload: Buffer
}

type AuthorityMessageForTest = Parameters<typeof encodeAuthorityFrame>[0]

/** One connected socketpair as two real sockets. */
async function connectedSocketPair(): Promise<[net.Socket, net.Socket]> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  const client = net.connect(address.port, '127.0.0.1')
  const connections = await once(server, 'connection')
  const serverSide = connections[0] as net.Socket
  server.close()
  return [client, serverSide]
}

/**
 * Scripted authority answering exactly like the Swift service: strict digest
 * verification over streamed export entries, release barrier, prepared at the
 * baseline generation, and the activation consume.
 */
class ScriptedAuthority {
  readonly manifest: Array<{ name: string; sha256: string; size: number }> = []
  private buffer = Buffer.alloc(0)
  private readonly queue: Buffer[] = []
  private sawRecover = false
  private sawPrepared = false

  private readonly socket: net.Socket

  constructor(
    socket: net.Socket,
    private readonly recoveredSnapshot: Extract<AuthorityMessageForTest, { kind: 'snapshot' }> = {
      kind: 'snapshot', status: 'none', generation: 0,
    },
  ) {
    this.socket = socket
    socket.on('data', (chunk) => { this.receive(chunk) })
  }

  private receive(chunk: Buffer): void {
    if (process.env.DSH_FD199_MIRROR_DEBUG !== undefined) {
      console.error(`[mirror] authority chunk ${chunk.byteLength}B: ${chunk.toString('utf8').slice(0, 120)}`)
    }
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const bodyLength = this.buffer.readUInt32BE(0)
      if (bodyLength <= 2 || this.buffer.length < 4 + bodyLength) break
      this.queue.push(Buffer.from(this.buffer.subarray(4, 4 + bodyLength)))
      this.buffer = this.buffer.subarray(4 + bodyLength)
    }
  }

  /** Decodes and answers every queued frame; call repeatedly while waiting. */
  drain(): void {
    while (this.queue.length > 0) {
      const body = this.queue.shift()
      if (body === undefined) return
      const message = decodeFrame('client', body)
      switch (message.kind) {
        case 'hello':
          this.send({ kind: 'ready', protocolVersion: 1, hostAppPath: HOST_APP_PATH })
          break
        case 'recover':
          this.sawRecover = true
          this.send(this.recoveredSnapshot)
          break
        case 'prepare-file': {
          if (message.kind !== 'prepare-file') break
          const bytes = Buffer.from(message.bytesBase64, 'base64url')
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(message.sha256)
          this.manifest.push({ name: message.name, sha256: message.sha256, size: bytes.byteLength })
          break
        }
        case 'prepare-complete':
          expect(this.manifest.length).toBeGreaterThan(0)
          break
        case 'releasing':
          this.sawPrepared = true
          this.send({ kind: 'release-authorized' })
          break
        case 'activate':
          this.send({ kind: 'activated', generation: 1 })
          break
        default:
          break
      }
    }
  }

  get recovered(): boolean { return this.sawRecover }
  get staged(): boolean { return this.sawPrepared }

  send(message: AuthorityMessageForTest): void {
    const body = encodeAuthorityFrame(message)
    const frame = Buffer.alloc(4 + body.byteLength)
    frame.writeUInt32BE(body.byteLength, 0)
    frame.set(body, 4)
    this.socket.write(frame)
  }

  instruct(action: 'prepare' | 'activate'): void {
    this.send({ kind: 'instruct', action })
  }
}

interface HostedChild {
  readonly child: ReturnType<typeof spawn>
  readonly stderr: Buffer[]
  readonly stdout: () => string
  readonly closeSockets: () => void
}

/** Spawn one hosted Web generation with its authority and relay channels on exactly 198/199. */
async function spawnHostedChild(
  generation: 'generation-1' | 'generation-2',
  home: string,
  relayChild: net.Socket,
  authorityChild: net.Socket,
): Promise<HostedChild> {
  // Hosted mode accepts the native-attested RC8 compatibility snapshot only.
  // The source proof supplies an equivalent fixed overlay explicitly so it
  // exercises the same fail-closed loader boundary without a real install.
  const hostedPatch = join(home, 'rc8-core.patch.yml')
  const hostedPatchBody = '- id: openbrain-mcp\n  disabled: true\n- id: brave-search-mcp\n  disabled: true\n- id: web-search-brave\n  disabled: true\n'
  await writeFile(hostedPatch, hostedPatchBody)
  const hostedPatchHash = createHash('sha256').update(hostedPatchBody).digest('hex')
  const packagedNode = process.env.DSH_FD199_HOSTED_NODE
  const packagedEntrypoint = process.env.DSH_FD199_HOSTED_ENTRYPOINT
  const packagedWebArgs = process.env.DSH_FD199_HOSTED_WEB_ARGS
  if ((packagedNode === undefined) !== (packagedEntrypoint === undefined)) {
    throw new Error('packaged hosted-child smoke requires node and entrypoint together')
  }
  // Filler stdio entries occupy child descriptors 3..197 (each opens
  // /dev/null) so the two real channels land on exactly 198 and 199.
  const fillers: StdioOptions = Array.from({ length: 195 }, () => 'ignore')
  // The 200-slot stdio layout (fillers + the two real channels on exactly
  // 198/199) exceeds Node's tuple stdio overloads; the runtime accepts any
  // per-index entry list.
  const childStdio: StdioOptions = ['ignore', 'pipe', 'pipe', ...fillers, relayChild, authorityChild]
  const sourceLaunch = packagedNode === undefined
  let hostedArgs: string[] | undefined
  if (!sourceLaunch && packagedWebArgs !== undefined) {
    try {
      const decoded: unknown = JSON.parse(packagedWebArgs)
      if (!Array.isArray(decoded) || !decoded.every(value => typeof value === 'string') || decoded[0] !== 'web') throw new Error()
      hostedArgs = decoded.map(value => value.replaceAll('{DSH_HOME}', home))
    } catch {
      throw new Error('DSH_FD199_HOSTED_WEB_ARGS must be a JSON string array beginning with web')
    }
  }
  const tsxLoader = sourceLaunch ? import.meta.resolve('tsx/esm') : undefined
  const launchPrefix = sourceLaunch
    // The post-bind HMR fallback needs Node internals; ordinary dev launches get it from the pnpm wrapper.
    ? ['--expose-internals', '--import', tsxLoader!, dshBinScript]
    // This is also the signed native supervisor's sole Node runtime flag.
    : ['--expose-internals', packagedEntrypoint!]
  const child = spawn(packagedNode ?? process.execPath, [
    ...launchPrefix,
    ...(hostedArgs ?? ['web', '--patch', hostedPatch, '--port', '0', '--no-open', '--private-relay-fd', '198', '--private-authority-fd', '199']),
  ], {
    stdio: childStdio,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_HOSTED_PATCH_RELATIVE: 'rc8-core.patch.yml',
      DSH_HOSTED_PATCH_SHA256: hostedPatchHash,
      DEEPSEEK_API_KEY: 'keyless-fd199-mirror-no-call',
      DSH_TELEMETRY_DISABLED: '1',
      ...(sourceLaunch ? { TSX_TSCONFIG_PATH: tsconfigPath } : {}),
    },
  })
  const stderr: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => { stderr.push(Buffer.from(chunk)) })
  let childOutput = ''
  child.stdout?.on('data', (chunk) => { childOutput += String(chunk) })
  child.once('exit', (code, signal) => {
    console.error(`[mirror] ${generation} exit code=${String(code)} signal=${String(signal)}`)
  })
  child.once('close', (code, signal) => {
    console.error(`[mirror] ${generation} close code=${String(code)} signal=${String(signal)}`)
  })
  return {
    child,
    stderr,
    stdout: () => childOutput,
    closeSockets: () => {
      relayChild.destroy()
      authorityChild.destroy()
    },
  }
}

/** Await natural child exit, escalating only when a broken test leaves it alive. */
async function stopHostedChild(hosted: HostedChild): Promise<void> {
  const { child } = hosted
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
    timer.unref?.()
    child.kill('SIGTERM')
    await exited
    clearTimeout(timer)
  }
  hosted.closeSockets()
}

// ---------- V3 wire helpers (byte format shared with Swift RemoteHostWire) ----------

class WirePeer {
  private readonly socket: net.Socket
  private buffer = Buffer.alloc(0)
  readonly records: IncomingRecord[] = []

  constructor(socket: net.Socket) {
    this.socket = socket
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      while (this.buffer.length >= 4) {
        const bodyLength = this.buffer.readUInt32BE(0)
        if (bodyLength < 3 || this.buffer.length < 4 + bodyLength) break
        const metadataLength = this.buffer.readUInt16BE(5)
        const metadata = metadataLength === 0
          ? {}
          : JSON.parse(this.buffer.subarray(7, 7 + metadataLength).toString('utf8')) as Record<string, unknown>
        const payload = Buffer.from(this.buffer.subarray(7 + metadataLength, 4 + bodyLength))
        this.records.push({ kind: this.buffer[4] as number, metadata, payload })
        this.buffer = this.buffer.subarray(4 + bodyLength)
      }
    })
    socket.on('error', () => {})
  }

  send(kind: WireKind, metadata: Record<string, unknown> = {}, payload: Uint8Array = new Uint8Array()): void {
    const json = Buffer.from(JSON.stringify(metadata), 'utf8')
    const head = Buffer.alloc(7)
    head.writeUInt32BE(3 + json.byteLength + payload.byteLength, 0)
    head[4] = WIRE_KIND[kind]
    head.writeUInt16BE(json.byteLength, 5)
    this.socket.write(Buffer.concat([head, json, Buffer.from(payload)]))
  }
}

function hasFrame(records: IncomingRecord[], kind: WireKind, match?: (record: IncomingRecord) => boolean): boolean {
  return records.some(record => record.kind === WIRE_KIND[kind] && (match === undefined || match(record)))
}

async function eventually(condition: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function assertChildAlive(hosted: HostedChild, phase: string): void {
  if (hosted.child.exitCode !== null || hosted.child.signalCode !== null) {
    throw new Error(`${phase}: child exited code=${String(hosted.child.exitCode)} signal=${String(hosted.child.signalCode)} stderr=${Buffer.concat(hosted.stderr).toString('utf8').slice(-1500)}`)
  }
}

let rpcCounter = 0

async function browserCookie(hosted: HostedChild, home: string, owner: WebRuntimeRegistryRecord): Promise<string> {
  const bootstrapPath = webRuntimeBootstrapPath(home)
  await eventually(() => {
    assertChildAlive(hosted, 'browser bootstrap')
    return existsSync(bootstrapPath)
  }, 15_000, 'hosted browser bootstrap was not published')
  const bootstrap = parseWebRuntimeBootstrap(await readFile(bootstrapPath, 'utf8'), owner)
  if (bootstrap === undefined) throw new Error('hosted browser bootstrap does not match its runtime owner')
  expect((await fetch(owner.url, { redirect: 'manual' })).status).toBe(401)
  const response = await fetch(bootstrap.authenticatedUrl, { redirect: 'manual' })
  expect(response.status).toBe(303)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('hosted browser token exchange did not issue a cookie')
  return cookie
}

async function api<T>(base: string, method: 'session/create' | 'session/list', payload: unknown, cookie: string): Promise<T> {
  rpcCounter += 1
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `desktop-${String(rpcCounter)}`, method, payload: { args: { [method === 'session/list' ? '_request' : 'request']: payload } } }),
  })
  expect(response.status).toBe(200)
  const envelope = await response.json() as { result: { ok: boolean; value?: T; error?: unknown } }
  expect(envelope.result.ok, `desktop ${method} failed: ${JSON.stringify(envelope.result)}`).toBe(true)
  return envelope.result.value as T
}

describe.skipIf(COPIED_STATE_ONLY)('hosted FD199 mirror across real dsh web children', () => {
  it('mirrors a desktop-created session identically to the v3 remote path after an attested activation', { timeout: 2_700_000, retry: 0 }, async () => {
    const configuredHome = process.env.DSH_FD199_HOSTED_DSH_HOME
    const home = configuredHome ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-fd199-mirror-home-')))
    const [firstRelayParent, firstRelayChild] = await connectedSocketPair()
    const [firstAuthorityParent, firstAuthorityChild] = await connectedSocketPair()
    const first = await spawnHostedChild('generation-1', home, firstRelayChild, firstAuthorityChild)
    const firstAuthority = new ScriptedAuthority(firstAuthorityParent)
    const drainFirst = (): void => { firstAuthority.drain() }
    let second: HostedChild | undefined
    let secondRelayParent: net.Socket | undefined
    let secondAuthorityParent: net.Socket | undefined

    try {
      // 1. The first child proves the hosted channel, recovers an empty
      // journal, and owns the configured desktop graph.
      // This is an e2e phase cap, not an open-ended process watchdog.
      console.error('[mirror] waiting for FD199 handshake')
      await eventually(() => { assertChildAlive(first, 'FD199 handshake'); drainFirst(); return firstAuthority.recovered }, 15_000,
        `the first child never completed its FD199 handshake; stderr=${Buffer.concat(first.stderr).toString('utf8').slice(-1500)}`)
      console.error('[mirror] handshake complete')

      // 2. Desktop surface up: the launcher publishes the bound loopback URL.
      const registryPath = join(home, 'runtime', 'web.json')
      const registryText = await (async () => {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          drainFirst()
          assertChildAlive(first, 'web runtime registry')
          try {
            return await readFile(registryPath, 'utf8')
          } catch {
            await new Promise(resolve => setTimeout(resolve, 200))
          }
        }
        throw new Error('web runtime registry was never published')
      })()
      const registry = parseWebRuntimeRegistry(registryText)
      if (registry === undefined) throw new Error('hosted registry is invalid')
      console.error(`[mirror] registry published: ${registry.url}`)
      expect(registry.pid).toBe(first.child.pid)
      const base = registry.url

      // 3. Desktop creates the session that both surfaces must mirror.
      const cookie = await browserCookie(first, home, registry)
      const created = await api<{ sessionId: string }>(base, 'session/create', {}, cookie)
      console.error(`[mirror] desktop session created: ${created.sessionId}`)
      expect(created.sessionId).toMatch(/^session-/)

      // 4. Attested transition: prepare streams the store export through the
      // native release barrier, then activation consumes the journal.
      console.error('[mirror] instructing prepare')
      firstAuthority.instruct('prepare')
      await eventually(() => {
        drainFirst()
        return firstAuthority.manifest.some(entry => entry.name === `sessions/${created.sessionId}.jsonl`)
      }, 120_000, 'the prepared manifest never contained the created session artifact')
      console.error(`[mirror] manifest entries: ${firstAuthority.manifest.length}`)
      await eventually(() => {
        drainFirst()
        return firstAuthority.staged
      }, 30_000, 'the release barrier never settled into prepared')
      // The release acknowledgement is durable before the former owner exits.
      // A fresh child, rather than the release-side process, must adopt the
      // prepared graph and receive the activation consume.
      console.error('[mirror] waiting for generation-1 root disposal and exit')
      await eventually(() => first.child.exitCode !== null || first.child.signalCode !== null, 30_000,
        `the prepared child did not exit; stderr=${Buffer.concat(first.stderr).toString('utf8').slice(-1500)}`)
      expect(first.child.exitCode).toBe(0)
      first.closeSockets()
      firstRelayParent.destroy()
      firstAuthorityParent.destroy()

      const [relayParent, relayChild] = await connectedSocketPair()
      const [authorityParent, authorityChild] = await connectedSocketPair()
      secondRelayParent = relayParent
      secondAuthorityParent = authorityParent
      second = await spawnHostedChild('generation-2', home, relayChild, authorityChild)
      const authority = new ScriptedAuthority(authorityParent, { kind: 'snapshot', status: 'prepared', generation: 0 })
      const wire = new WirePeer(relayParent)
      const drainSecond = (): void => { authority.drain() }

      console.error('[mirror] waiting for prepared child adoption')
      await eventually(() => { assertChildAlive(second!, 'prepared adoption'); drainSecond(); return authority.recovered }, 15_000,
        `the adopting child never completed its FD199 handshake; stderr=${Buffer.concat(second.stderr).toString('utf8').slice(-1500)}`)
      const adoptedRegistryText = await (async () => {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          drainSecond()
          assertChildAlive(second, 'adopted web runtime registry')
          try {
            return await readFile(registryPath, 'utf8')
          } catch {
            await new Promise(resolve => setTimeout(resolve, 200))
          }
        }
        throw new Error('adopting web runtime registry was never published')
      })()
      const adoptedRegistry = parseWebRuntimeRegistry(adoptedRegistryText)
      if (adoptedRegistry === undefined) throw new Error('adopted hosted registry is invalid')
      expect(adoptedRegistry.pid).toBe(second.child.pid)
      const adoptedBase = adoptedRegistry.url

      console.error('[mirror] instructing activate on adopting child')
      authority.instruct('activate')
      await eventually(() => {
        drainSecond()
        return hasFrame(wire.records, 'runtime.ready')
      }, 120_000, 'the relay gateway never became ready after activation')
      console.error('[mirror] relay ready')

      // 5. Phone-equivalent path: enroll, provision the route, commit an
      // epoch, open the connection, and request the session list over v3.
      // The native Host preserves the exact local enrollment receipt through
      // the respawn before it sends its ordinary idempotent enrollment write.
      wire.send('enrollment.seed', {
        deviceId: DEVICE, label: 'Mirror Phone', signingPublicKey: SIGNING_KEY, agreementPublicKey: AGREEMENT_KEY,
        deviceEnrollmentId: DEVICE_ENROLLMENT, hostEnrollmentId: HOST_ENROLLMENT,
      })
      wire.send('device.enroll', {
        deviceId: DEVICE, label: 'Mirror Phone', signingPublicKey: SIGNING_KEY, agreementPublicKey: AGREEMENT_KEY,
      })
      await eventually(() => hasFrame(wire.records, 'device.enrolled'), 30_000, 'device enrollment was never receipted')
      const enrolled = wire.records.find(record => record.kind === WIRE_KIND['device.enrolled'])
      const deviceEnrollmentId = enrolled?.metadata.deviceEnrollmentId as string
      const hostEnrollmentId = enrolled?.metadata.hostEnrollmentId as string
      expect(deviceEnrollmentId).toBe(DEVICE_ENROLLMENT)
      expect(hostEnrollmentId).toBe(HOST_ENROLLMENT)

      wire.send('route.upsert', {
        routeId: ROUTE, deviceId: DEVICE, deviceEnrollmentId,
        hostDeviceId: 'host_device_fd1991', hostEnrollmentId, generation: 1,
      })
      wire.send('epoch.begin', { deviceId: DEVICE })
      await eventually(() => hasFrame(wire.records, 'epoch.begun'), 30_000, 'epoch was never begun')
      wire.send('epoch.commit', { deviceId: DEVICE, connectionEpoch: 1 })
      await eventually(() => hasFrame(wire.records, 'epoch.committed'), 30_000, 'epoch was never committed')
      wire.send('connection.open', {
        connectionId: CONNECTION, deviceId: DEVICE, enrollmentId: deviceEnrollmentId,
        signingPublicKey: SIGNING_KEY, agreementPublicKey: AGREEMENT_KEY, routeId: ROUTE, generation: 1, connectionEpoch: 1,
      })
      wire.send('connection.frame', { connectionId: CONNECTION }, new TextEncoder().encode(JSON.stringify({
        version: 3, type: 'request', connectionEpoch: 1, requestId: 'remote_request_fd19901',
        idempotencyKey: 'remote_retry_fd19901', method: 'session.list', payload: {},
      })))

      console.error('[mirror] driving v3 enrollment and session.list')
      await eventually(
        () => hasFrame(wire.records, 'connection.send'),
        120_000,
        'the remote session.list request was never answered',
      )
      console.error('[mirror] v3 response received')
      const response = wire.records.find(record => record.kind === WIRE_KIND['connection.send'])
      expect(response?.metadata).toEqual({ connectionId: CONNECTION })
      const remoteEnvelope = JSON.parse(response!.payload.toString('utf8')) as {
        version: number
        type: string
        requestId: string
        result: { ok: boolean; value: { items: Array<{ sessionId: string }> }; error?: unknown }
      }
      expect(remoteEnvelope.version).toBe(3)
      expect(remoteEnvelope.type).toBe('response')
      expect(remoteEnvelope.requestId).toBe('remote_request_fd19901')
      expect(remoteEnvelope.result.ok, `remote session.list failed: ${JSON.stringify(remoteEnvelope.result)}`).toBe(true)

      // 6. The browser uses current Typert RPC while the released phone uses
      // the compatibility wire. Both project the same durable session owner.
      const adoptedCookie = await browserCookie(second, home, adoptedRegistry)
      const desktopList = await api<{ items: Array<{ sessionId: string }> }>(adoptedBase, 'session/list', {}, adoptedCookie)
      const desktopIds = desktopList.items.map(session => session.sessionId)
      expect(desktopIds).toContain(created.sessionId)
      const remoteIds = remoteEnvelope.result.value.items.map(session => session.sessionId)
      expect(remoteIds.sort()).toEqual([...desktopIds].sort())
    } finally {
      if (second !== undefined) await stopHostedChild(second)
      secondRelayParent?.destroy()
      secondAuthorityParent?.destroy()
      await stopHostedChild(first)
      firstRelayParent.destroy()
      firstAuthorityParent.destroy()
      if (configuredHome === undefined) await rm(home, { recursive: true, force: true }).catch(() => {})
      if (process.env.DSH_FD199_MIRROR_DEBUG !== undefined) {
        console.error('first child stdout tail:', first.stdout().slice(-2000))
        console.error('first child stderr tail:', Buffer.concat(first.stderr).toString('utf8').slice(-4000))
        if (second !== undefined) {
          console.error('second child stdout tail:', second.stdout().slice(-2000))
          console.error('second child stderr tail:', Buffer.concat(second.stderr).toString('utf8').slice(-4000))
        }
      }
    }
  })
})

/** Hash copied artifacts without logging their paths, content, or identifiers. */
async function copiedSessionArtifacts(home: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('copied session artifacts must not contain symlinks')
      if (info.isDirectory()) await visit(path)
      else if (info.isFile() && /\.jsonl(?:\.zstd)?$/.test(entry.name)) {
        files.set(path, createHash('sha256').update(await readFile(path)).digest('hex'))
      }
    }
  }
  await visit(join(home, 'sessions'))
  return files
}

describe.runIf(COPIED_STATE_ONLY)('hosted upgrade over an isolated copied state', () => {
  it('reads existing sessions and migrates data-only settings without changing original artifacts', { timeout: 120_000, retry: 0 }, async () => {
    const home = process.env.DSH_FD199_HOSTED_DSH_HOME
    if (home === undefined || await realpath(home) !== home) throw new Error('copied-state proof requires an explicit canonical isolated home')
    const originalArtifacts = await copiedSessionArtifacts(home)
    expect(originalArtifacts.size > 0).toBe(true)
    const originalSessions = new Set([...originalArtifacts.keys()].map(path => basename(dirname(path))))
    const legacyPath = join(home, 'settings.yaml')
    const legacySettings = await readFile(legacyPath, 'utf8')
    const legacyDigest = createHash('sha256').update(legacySettings).digest('hex')
    const [relayParent, relayChild] = await connectedSocketPair()
    const [authorityParent, authorityChild] = await connectedSocketPair()
    const hosted = await spawnHostedChild('generation-1', home, relayChild, authorityChild)
    const authority = new ScriptedAuthority(authorityParent)
    try {
      await eventually(() => {
        assertChildAlive(hosted, 'copied-state handshake')
        authority.drain()
        return authority.recovered
      }, 30_000, 'copied-state hosted authority handshake did not complete')
      let owner: WebRuntimeRegistryRecord | undefined
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && owner === undefined) {
        assertChildAlive(hosted, 'copied-state readiness')
        authority.drain()
        try {
          const candidate = parseWebRuntimeRegistry(await readFile(join(home, 'runtime', 'web.json'), 'utf8'))
          if (candidate?.pid === hosted.child.pid) owner = candidate
        } catch { /* A copied discovery record may be replaced during startup. */ }
        if (owner === undefined) await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (owner === undefined) throw new Error('copied-state runtime did not publish its own registry')
      const cookie = await browserCookie(hosted, home, owner)
      const listed = await api<{ items: Array<{ sessionId: string }> }>(owner.url, 'session/list', {}, cookie)
      const listedIds = new Set(listed.items.map(item => item.sessionId))
      expect(listedIds.size).toBe(originalSessions.size)
      expect([...originalSessions].every(id => listedIds.has(id))).toBe(true)
      const hostedSettings: unknown = JSON.parse(await readFile(join(home, 'hosted-settings.json'), 'utf8'))
      // Boolean comparisons keep credential-bearing settings out of assertion diagnostics.
      expect(isDeepStrictEqual(hostedSettings, parseHostedSettings(legacySettings))).toBe(true)
    } finally {
      await stopHostedChild(hosted)
      relayParent.destroy()
      authorityParent.destroy()
    }
    const after = await copiedSessionArtifacts(home)
    expect([...originalArtifacts].every(([path, digest]) => after.get(path) === digest)).toBe(true)
    expect(createHash('sha256').update(await readFile(legacyPath)).digest('hex') === legacyDigest).toBe(true)
    expect(after.size).toBe(originalArtifacts.size)
  })
})
