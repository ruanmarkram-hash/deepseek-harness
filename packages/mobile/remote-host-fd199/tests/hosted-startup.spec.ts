import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { RemoteHostV3Controller, RemoteHostV3RouteAllocator } from '@deepseek-ai/dsh-remote-host-v3'
import { directoryFixture, memoryTable } from '../../remote-devices/tests/fixture.ts'
import { decodeFrame, encodeAuthorityFrame, frameBytes } from '../src/protocol.ts'
import type { AuthorityMessage, ClientMessage } from '../src/protocol.ts'
import type { Fd199ExportFile } from '../src/types.ts'
import { CurrentWebFd199Lifecycle, CurrentWebFd199LifecycleError } from '../src/lifecycle.ts'
import { apply, startHostedHandoff } from '../src/index.ts'
import { adoptInheritedAuthoritySocket, validateInheritedDescriptors } from '../src/fd.ts'

vi.mock('../src/fd.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/fd.ts')>(),
  validateInheritedDescriptors: vi.fn(),
  adoptInheritedAuthoritySocket: vi.fn(),
}))

/**
 * Scripted authority peer over an in-memory duplex channel. The handshake
 * (hello → ready, recover → snapshot) is answered automatically so the
 * mounted startup completes without test-side coordination.
 */
class ScriptedAuthority extends Duplex {
  /** Snapshot answered on recover. */
  snapshot: AuthorityMessage = { kind: 'snapshot', status: 'none', generation: 0 }
  readonly sent: ClientMessage[] = []
  ackOffsetDelta = 0
  private buffer = Buffer.alloc(0)
  private currentFile: { name: string; offset: number; hash: ReturnType<typeof createHash> } | undefined

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
        this.authoritySend({ kind: 'ready', protocolVersion: 2, hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host' })
      }
      if (message.kind === 'recover') {
        this.authoritySend(this.snapshot)
      }
      if (message.kind === 'prepare-file-begin') {
        expect(this.currentFile).toBeUndefined()
        this.currentFile = { name: message.name, offset: 0, hash: createHash('sha256') }
        this.authoritySend({ kind: 'prepare-file-ack', name: message.name, offset: this.ackOffsetDelta, complete: false })
      }
      if (message.kind === 'prepare-file-chunk') {
        const file = this.currentFile
        if (file === undefined) throw new Error('chunk arrived without a begin')
        expect(message.offset).toBe(file.offset)
        const bytes = Buffer.from(message.bytesBase64, 'base64url')
        file.hash.update(bytes)
        file.offset += bytes.byteLength
        this.authoritySend({ kind: 'prepare-file-ack', name: file.name, offset: file.offset + this.ackOffsetDelta, complete: false })
      }
      if (message.kind === 'prepare-file-end') {
        const file = this.currentFile
        if (file === undefined) throw new Error('end arrived without a begin')
        expect(message.size).toBe(file.offset)
        expect(message.sha256).toBe(file.hash.digest('hex'))
        this.authoritySend({ kind: 'prepare-file-ack', name: file.name, offset: file.offset + this.ackOffsetDelta, complete: true })
        this.currentFile = undefined
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
  dispose: () => Promise<void>
}

async function harness(snapshot?: AuthorityMessage): Promise<HostFixture> {
  const authority = new ScriptedAuthority()
  if (snapshot !== undefined) authority.snapshot = snapshot
  const ctx = new Context()
  const fixture: HostFixture = { ctx, authority, served: [], exits: [], dispose: async () => {} }
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
  fixture.dispose = await startHostedHandoff(ctx, authority)
  disposers.push(fixture.dispose)
  return fixture
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000 && !condition(); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

const HOST_PATH = '/Applications/DSH Host.app/Contents/MacOS/DSH Host'

async function* byteChunks(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes }

async function* exportOneFile(bytes: Uint8Array, signal: AbortSignal): AsyncIterable<Fd199ExportFile> {
  signal.throwIfAborted()
  yield { name: 'sessions/session_00000001.jsonl', bytes: byteChunks(bytes) }
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

describe('hosted FD199 startup lifecycle', () => {
  it('awaits export generator cleanup when the mounted disposer aborts an outstanding read', async () => {
    const fixture = await harness()
    const reading = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    const releaseCleanup = Promise.withResolvers<undefined>()
    const signals: AbortSignal[] = []
    let cleaned = false
    fixture.ctx.provide('fd199WebOwner', {
      exportStoppedState: async function* (signal) {
        signals.push(signal)
        yield {
          name: 'sessions/session_00000001.jsonl',
          bytes: (async function* (): AsyncIterable<Uint8Array> {
            try {
              await new Promise<undefined>((_resolve, reject) => {
                signal.addEventListener('abort', () => { reject(new Error('read cancelled')) }, { once: true })
                reading.resolve(undefined)
              })
            } finally {
              cleanupStarted.resolve(undefined)
              await releaseCleanup.promise
              cleaned = true
            }
          })(),
        }
      },
    })
    fixture.authority.authoritySend({ kind: 'instruct', action: 'prepare' })
    await reading.promise
    const settled: string[] = []
    const first = Promise.resolve(fixture.dispose()).then(() => { settled.push('first') })
    const repeated = Promise.resolve(fixture.dispose()).then(() => { settled.push('repeated') })
    try {
      await cleanupStarted.promise
      await new Promise(resolve => setImmediate(resolve))
      expect(signals[0]?.aborted).toBe(true)
      expect(fixture.authority.destroyed).toBe(true)
      expect([...settled]).toEqual([])
      expect(cleaned).toBe(false)
      expect(fixture.exits).toEqual([])
      expect(fixture.authority.sent.map(message => message.kind)).toEqual(['hello', 'recover', 'prepare-file-begin'])
    } finally {
      releaseCleanup.resolve(undefined)
      await Promise.all([first, repeated])
    }
    expect(cleaned).toBe(true)
    expect(settled).toEqual(['first', 'repeated'])
    expect(fixture.exits).toEqual([])
  })

  it('validates descriptors before adopting the production channel', async () => {
    vi.mocked(adoptInheritedAuthoritySocket).mockImplementationOnce(() => { throw new Error('adoption sentinel') })
    await expect(apply(new Context())).rejects.toThrow('adoption sentinel')
    expect(validateInheritedDescriptors).toHaveBeenCalledOnce()
    expect(adoptInheritedAuthoritySocket).toHaveBeenCalledOnce()
  })

  it('disposes idempotently and sanitizes a non-Error instruction failure', async () => {
    const fixture = await harness()
    fixture.ctx.provide('fd199WebOwner', { exportStoppedState: () => { throw 'export sentinel' } })
    // The caller-owned transition can reject without an Error instance.
    vi.spyOn(CurrentWebFd199Lifecycle.prototype, 'releaseForNative').mockRejectedValueOnce('transition sentinel')
    fixture.authority.authoritySend({ kind: 'instruct', action: 'prepare' })
    await until(() => fixture.authority.destroyed)
    expect(fixture.authority.destroyed).toBe(true)
    await fixture.dispose()
    await fixture.dispose()
  })

  it('refuses activation when its authority service disappeared', async () => {
    const fixture = await harness({ kind: 'snapshot', status: 'prepared', generation: 1 })
    fixture.ctx.set('fd199AuthorityClient', undefined)
    fixture.authority.authoritySend({ kind: 'instruct', action: 'activate' })
    await until(() => fixture.authority.destroyed)
    expect(fixture.authority.destroyed).toBe(true)
  })

  it('refuses release without the awaited whole-root exit service', async () => {
    const fixture = await harness()
    fixture.ctx.set('fd199HostedExit', undefined)
    const bytes = new Uint8Array([1])
    fixture.ctx.provide('fd199WebOwner', { exportStoppedState: signal => exportOneFile(bytes, signal) })
    fixture.authority.authoritySend({ kind: 'instruct', action: 'prepare' })
    await until(() => fixture.authority.sent.some(message => message.kind === 'releasing'))
    fixture.authority.authoritySend({ kind: 'release-authorized' })
    await until(() => fixture.authority.destroyed)
    expect(fixture.authority.destroyed).toBe(true)
    expect(fixture.exits).toEqual([])
  })

  it('recovers a fresh journal and admits desktop work without binding the relay', async () => {
    const fixture = await harness()
    expect(fixture.served).toEqual([])
    const fence = fixture.ctx.get('fd199DesktopWriteFence')
    expect(fence).toBeDefined()
    let admitted = false
    await fence!.runDesktopOperation(async () => { admitted = true })
    expect(admitted).toBe(true)
  })

  it('offers desktop-ready only for the fresh desktop owner', async () => {
    const fixture = await harness()
    const ready = fixture.ctx.get('fd199DesktopReady') as { signal?: () => Promise<void> } | undefined
    await expect(ready?.signal?.()).resolves.toBeUndefined()
    await until(() => fixture.authority.sent.some(message => message.kind === 'desktop-ready'))
    expect(fixture.authority.sent.map(message => message.kind)).toEqual(['hello', 'recover', 'desktop-ready'])

    const adopted = await harness({ kind: 'snapshot', status: 'activated', generation: 1 })
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
      exportStoppedState: (signal) => {
        order.push('export')
        expect(signal.aborted).toBe(false)
        return exportOneFile(bytes, signal)
      },
    })
    fixture.authority.authoritySend({ kind: 'instruct', action: 'prepare' })
    await until(() => order.includes('export'))
    // The fence closed as soon as the transition began draining.
    await expect(fence!.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
    await until(() => fixture.authority.sent.some(message => message.kind === 'prepare-complete'))
    expect(fixture.authority.sent.filter(message => message.kind.startsWith('prepare-file-'))).toEqual([
      { kind: 'prepare-file-begin', name: 'sessions/session_00000001.jsonl' },
      { kind: 'prepare-file-chunk', offset: 0, bytesBase64: Buffer.from(bytes).toString('base64url') },
      { kind: 'prepare-file-end', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') },
    ])
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

  it('aborts the mounted export and retains the fence when native acknowledges the wrong offset', async () => {
    const fixture = await harness()
    fixture.authority.ackOffsetDelta = 1
    const signals: AbortSignal[] = []
    fixture.ctx.provide('fd199WebOwner', {
      exportStoppedState: (signal) => {
        signals.push(signal)
        return exportOneFile(new Uint8Array([1]), signal)
      },
    })
    fixture.authority.authoritySend({ kind: 'instruct', action: 'prepare' })
    await until(() => fixture.authority.destroyed)
    expect(fixture.authority.destroyed).toBe(true)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(fixture.authority.sent.map(message => message.kind)).toEqual(['hello', 'recover', 'prepare-file-begin'])
    expect(fixture.exits).toEqual([])
    const fence = fixture.ctx.get('fd199DesktopWriteFence')
    if (fence === undefined) throw new Error('hosted startup did not mount the desktop fence')
    await expect(fence.runDesktopOperation(async () => {})).rejects.toThrow(CurrentWebFd199LifecycleError)
  })
})
