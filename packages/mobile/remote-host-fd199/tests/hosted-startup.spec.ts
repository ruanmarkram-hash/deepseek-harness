import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { RemoteHostV3Controller, RemoteHostV3RouteAllocator } from '@deepseek-ai/dsh-remote-host-v3'
import { directoryFixture, memoryTable } from '../../remote-devices/tests/fixture.ts'
import { decodeFrame, encodeAuthorityFrame, frameBytes } from '../src/protocol.ts'
import type { AuthorityMessage, ClientMessage } from '../src/protocol.ts'
import { CurrentWebFd199LifecycleError } from '../src/lifecycle.ts'
import { startHostedHandoff } from '../src/index.ts'

/**
 * Scripted authority peer over an in-memory duplex channel. The handshake
 * (hello → ready, recover → snapshot) is answered automatically so the
 * mounted startup completes without test-side coordination.
 */
class ScriptedAuthority extends Duplex {
  /** Snapshot answered on recover. */
  snapshot: AuthorityMessage = { kind: 'snapshot', status: 'none', generation: 0 }
  readonly sent: ClientMessage[] = []
  private buffer = Buffer.alloc(0)

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    while (true) {
      if (this.buffer.byteLength < 4) break
      const bodyLength = this.buffer.readUInt32BE(0)
      if (this.buffer.byteLength < 4 + bodyLength) break
      const body = this.buffer.subarray(4, 4 + bodyLength)
      this.buffer = this.buffer.subarray(4 + bodyLength)
      const message = decodeFrame('client', body) as ClientMessage
      this.sent.push(message)
      if (message.kind === 'hello') {
        this.authoritySend({ kind: 'ready', protocolVersion: 1, hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host' })
      }
      if (message.kind === 'recover') {
        this.authoritySend(this.snapshot)
      }
    }
    callback()
  }

  authoritySend(message: AuthorityMessage): void {
    this.push(Buffer.from(frameBytes(encodeAuthorityFrame(message))))
  }
}

interface HostFixture {
  ctx: Context
  authority: ScriptedAuthority
  served: string[]
  exits: number[]
}

async function harness(snapshot?: AuthorityMessage): Promise<HostFixture> {
  const authority = new ScriptedAuthority()
  if (snapshot !== undefined) authority.snapshot = snapshot
  const ctx = new Context()
  const fixture: HostFixture = { ctx, authority, served: [], exits: [] }
  ctx.provide('fd199HostedExit', async (code: number) => { fixture.exits.push(code) })
  // The V3 route composition the hosted plugin injects; recorded instead of real.
  const controller = new RemoteHostV3Controller(ctx,
    new RemoteHostV3RouteAllocator(memoryTable(), memoryTable()), directoryFixture({}),
    undefined, { enabled: true, hostAppPath: '' })
  ctx.provide('remoteHostV3', Object.assign(controller, {
    createInheritedNativeProvider(descriptor: number, hostAppPath: string) {
      fixture.served.push(`provider:${descriptor}:${hostAppPath}`)
      return { hostAppPath, runtimePipe: { kind: 'inherited-private-pipe' as const, async *accept() {} } }
    },
    startWithNative(native: { hostAppPath: string }) {
      fixture.served.push(`serve:${native.hostAppPath}`)
    },
  }))
  await startHostedHandoff(ctx, authority)
  return fixture
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000 && !condition(); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

const HOST_PATH = '/Applications/DSH Host.app/Contents/MacOS/DSH Host'

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

describe('hosted FD199 startup lifecycle', () => {
  it('recovers a fresh journal and admits desktop work without binding the relay', async () => {
    const fixture = await harness()
    disposers.push(() => { void fixture.ctx.get('fd199AuthorityClient')?.close() })
    expect(fixture.served).toEqual([])
    const fence = fixture.ctx.get('fd199DesktopWriteFence')
    expect(fence).toBeDefined()
    let admitted = false
    await fence!.runDesktopOperation(async () => { admitted = true })
    expect(admitted).toBe(true)
  })

  it('offers desktop-ready only for the fresh desktop owner', async () => {
    const fixture = await harness()
    disposers.push(() => { void fixture.ctx.get('fd199AuthorityClient')?.close() })
    const ready = fixture.ctx.get('fd199DesktopReady') as { signal?: () => Promise<void> } | undefined
    await expect(ready?.signal?.()).resolves.toBeUndefined()
    await until(() => fixture.authority.sent.some(message => message.kind === 'desktop-ready'))
    expect(fixture.authority.sent.map(message => message.kind)).toEqual(['hello', 'recover', 'desktop-ready'])

    const adopted = await harness({ kind: 'snapshot', status: 'activated', generation: 1 })
    disposers.push(() => { void adopted.ctx.get('fd199AuthorityClient')?.close() })
    const restartedReady = adopted.ctx.get('fd199DesktopReady') as { signal?: () => Promise<void> } | undefined
    await expect(restartedReady?.signal?.()).resolves.toBeUndefined()
    await until(() => adopted.authority.sent.some(message => message.kind === 'desktop-ready'))
    expect(adopted.authority.sent.map(message => message.kind)).toEqual(['hello', 'recover', 'desktop-ready'])
  })

  it('stays fenced on a prepared journal until the activation gate completes', async () => {
    const fixture = await harness({ kind: 'snapshot', status: 'prepared', generation: 3 })
    const fence = fixture.ctx.get('fd199DesktopWriteFence')
    await until(() => fence !== undefined)
    await expect(fence!.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
    // The Host gate passes: the authority instructs activation and consumes.
    fixture.authority.authoritySend({ kind: 'instruct', action: 'activate' })
    await until(() => fixture.authority.sent.some(message => message.kind === 'activate'))
    fixture.authority.authoritySend({ kind: 'activated', generation: 4 })
    await until(() => fixture.served.includes(`serve:${HOST_PATH}`))
    expect(fixture.served).toEqual([`provider:198:${HOST_PATH}`, `serve:${HOST_PATH}`])
    let admitted = false
    await fence!.runDesktopOperation(async () => { admitted = true })
    expect(admitted).toBe(true)
    expect(fixture.authority.sent.map(message => message.kind)).toEqual(['hello', 'recover', 'activate'])
  })

  it('rebinds the relay without another transition when recovery reports activation', async () => {
    const fixture = await harness({ kind: 'snapshot', status: 'activated', generation: 1 })
    await until(() => fixture.served.length >= 2)
    expect(fixture.served).toEqual([`provider:198:${HOST_PATH}`, `serve:${HOST_PATH}`])
    const fence = fixture.ctx.get('fd199DesktopWriteFence')
    let admitted = false
    await fence!.runDesktopOperation(async () => { admitted = true })
    expect(admitted).toBe(true)
    expect(fixture.authority.sent.map(message => message.kind)).toEqual(['hello', 'recover'])
  })

  it('runs the prepare instruction through the mounted Web owner and closes the fence', async () => {
    const fixture = await harness({ kind: 'snapshot', status: 'activated', generation: 1 })
    await until(() => fixture.served.length >= 2)
    const fence = fixture.ctx.get('fd199DesktopWriteFence')
    await fence!.runDesktopOperation(async () => {})
    const order: string[] = []
    const bytes = new TextEncoder().encode('{"id":"same-session"}\n')
    fixture.ctx.provide('fd199WebOwner', {
      exportStoppedState: async () => {
        order.push('export')
        return [{ name: 'sessions/session_00000001.jsonl', sha256: createHash('sha256').update(bytes).digest('hex'), bytes }]
      },
    })
    fixture.authority.authoritySend({ kind: 'instruct', action: 'prepare' })
    await until(() => order.includes('export'))
    // The fence closed as soon as the transition began draining.
    await expect(fence!.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
    await until(() => fixture.authority.sent.some(message => message.kind === 'prepare-complete'))
    expect(fixture.authority.sent.find(message => message.kind === 'prepare-file')).toEqual({
      kind: 'prepare-file',
      name: 'sessions/session_00000001.jsonl',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytesBase64: Buffer.from(bytes).toString('base64url'),
    })
    await until(() => fixture.authority.sent.some(message => message.kind === 'releasing'))
    fixture.authority.authoritySend({ kind: 'release-authorized' })
    await until(() => fixture.exits.length === 1)
    expect(fixture.exits).toEqual([0])
    // Settled: desktop work stays fenced for the life of the process.
    let blocked: Error | undefined
    try {
      await fence!.runDesktopOperation(async () => {})
    } catch (error) {
      blocked = error as Error
    }
    expect(blocked).toBeInstanceOf(CurrentWebFd199LifecycleError)
  })

  it('fails the prepare instruction closed when no Web owner is mounted', async () => {
    const fixture = await harness()
    const fence = fixture.ctx.get('fd199DesktopWriteFence')
    await fence!.runDesktopOperation(async () => {})
    fixture.authority.authoritySend({ kind: 'instruct', action: 'prepare' })
    // The instruction failure disposes the authority channel permanently.
    await until(() =>  fixture.authority.destroyed || fixture.authority.readableEnded)
    let admitted = false
    await fence!.runDesktopOperation(async () => { admitted = true })
    expect(admitted).toBe(true)
  })
})
