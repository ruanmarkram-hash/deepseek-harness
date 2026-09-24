import { describe, expect, it, vi } from 'vitest'
import { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'
import { decodeFrame, encodeAuthorityFrame, frameBytes } from '../src/protocol.ts'
import type { AuthorityMessage, ClientMessage } from '../src/protocol.ts'
import { Fd199AuthorityError } from '../src/error.ts'
import { Fd199ChannelClient } from '../src/client.ts'
import type { Fd199ExportFile } from '../src/types.ts'

/** Test-side channel collecting everything the client writes and feeding scripted authority bytes. */
class TestChannel extends Duplex {
  readonly sent: Buffer[] = []
  private readonly pending = new Array<Buffer>()
  private flowing = true
  autoAck = false
  autoRelease = false
  retainChunks = true
  private name = ''
  private offset = 0

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const message = decodeFrame('client', chunk.subarray(4)) as ClientMessage
    if (this.retainChunks || message.kind !== 'prepare-file-chunk') this.sent.push(Buffer.from(chunk))
    if (this.autoRelease && message.kind === 'releasing') this.authoritySend({ kind: 'release-authorized' })
    if (this.autoAck) {
      if (message.kind === 'prepare-file-begin') {
        this.name = message.name
        this.offset = 0
        this.authoritySend({ kind: 'prepare-file-ack', name: this.name, offset: 0, complete: false })
      } else if (message.kind === 'prepare-file-chunk') {
        this.offset += Buffer.from(message.bytesBase64, 'base64url').byteLength
        this.authoritySend({ kind: 'prepare-file-ack', name: this.name, offset: this.offset, complete: false })
      } else if (message.kind === 'prepare-file-end') {
        this.authoritySend({ kind: 'prepare-file-ack', name: this.name, offset: this.offset, complete: true })
      }
    }
    callback()
  }

  /** Feeds one authority frame toward the client. */
  authoritySend(message: AuthorityMessage): void {
    this.receive(frameBytes(encodeAuthorityFrame(message)))
  }

  /** Delivers raw bytes; held when the client paused reading mid-transaction tests. */
  receive(value: Uint8Array): void {
    const chunk = Buffer.from(value)
    if (!this.flowing) { this.pending.push(chunk); return }
    this.push(chunk)
  }

  hold(): void { this.flowing = false }
  resumeFlow(): void {
    this.flowing = true
    while (this.pending.length > 0) this.push(this.pending.shift())
  }

  eof(): void { this.push(null) }

  /** @returns every decoded client message written so far. */
  written(): ClientMessage[] {
    const buffer = Buffer.concat(this.sent)
    const messages: ClientMessage[] = []
    let cursor = 0
    while (cursor + 4 <= buffer.byteLength) {
      const bodyLength = buffer.readUInt32BE(cursor)
      messages.push(decodeFrame('client', buffer.subarray(cursor + 4, cursor + 4 + bodyLength)) as ClientMessage)
      cursor += 4 + bodyLength
    }
    return messages
  }
}

const SESSION_BYTES = new TextEncoder().encode('{"id":"same-session"}\n')

function exportFile(name = 'sessions/session_00000001.jsonl', bytes = SESSION_BYTES): Fd199ExportFile {
  return { name, bytes: chunks([bytes]) }
}

async function* chunks<T>(values: readonly T[]): AsyncGenerator<T> {
  yield* values
}

function exported(files: readonly Fd199ExportFile[]): { exportStoppedState: () => AsyncIterable<Fd199ExportFile> } {
  return { exportStoppedState: () => chunks(files) }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

describe('Fd199ChannelClient', () => {
  it.each([false, true])('enforces the unchanged 128 MiB aggregate, overflow=%s', async (overflow) => {
    const channel = new TestChannel()
    channel.autoAck = true
    channel.autoRelease = true
    channel.retainChunks = false
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    const chunk = new Uint8Array(262144)
    const operation = client.prepareReleasedStore(exported([{
      name: 'sessions/large.jsonl',
      bytes: (async function* () {
        for (let index = 0; index < 512; index += 1) yield chunk
        if (overflow) yield new Uint8Array([1])
      })(),
    }]))
    if (overflow) {
      await expect(operation).rejects.toThrow(Fd199AuthorityError)
      expect(channel.written().some(message => message.kind === 'prepare-complete')).toBe(false)
    } else {
      await operation
      expect(channel.written().find(message => message.kind === 'prepare-file-end')).toMatchObject({ size: 134217728 })
    }
    await client.close()
  }, 45_000)

  it('rejects the 8193rd distinct artifact before beginning it', async () => {
    const channel = new TestChannel()
    channel.autoAck = true
    channel.retainChunks = false
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    await expect(client.prepareReleasedStore({ exportStoppedState: () => (async function* () {
      for (let index = 0; index < 8193; index += 1) yield exportFile(`sessions/session_${index}.jsonl`, new Uint8Array([1]))
    })() })).rejects.toThrow(Fd199AuthorityError)
    expect(channel.written().filter(message => message.kind === 'prepare-file-begin')).toHaveLength(8192)
    expect(channel.written().some(message => message.kind === 'prepare-complete')).toBe(false)
  }, 30_000)

  it('aborts before awaiting signal-aware producer cleanup on a malformed ACK', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    let signal: AbortSignal | undefined
    let cleanupStarted = false
    const prepared = client.prepareReleasedStore({ exportStoppedState: received => (async function* () {
      signal = received
      try { yield exportFile() } finally {
        cleanupStarted = true
        if (!received.aborted) await new Promise<void>((resolve) => { received.addEventListener('abort', () => { resolve() }, { once: true }) })
      }
    })() })
    const rejected = expect(prepared).rejects.toThrow(Fd199AuthorityError)
    try {
      await until(() => channel.sent.length === 1)
      channel.authoritySend({ kind: 'prepare-file-ack', name: 'sessions/wrong.jsonl', offset: 0, complete: false })
      await until(() => cleanupStarted)
      expect(signal?.aborted).toBe(true)
    } finally {
      await client.close()
      await rejected
    }
  })

  it.each([
    { name: 'sessions/wrong.jsonl', offset: 0, complete: false },
    { name: 'sessions/session_00000001.jsonl', offset: 1, complete: false },
    { name: 'sessions/session_00000001.jsonl', offset: 0, complete: true },
  ])('refuses an ACK with mismatched fields %j', async (ack) => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    const assertion = expect(client.prepareReleasedStore(exported([exportFile()]))).rejects.toThrow(Fd199AuthorityError)
    await until(() => channel.sent.length === 1)
    channel.authoritySend({ kind: 'prepare-file-ack', ...ack })
    await assertion
    expect(channel.written()).toHaveLength(1)
    expect(channel.destroyed).toBe(true)
  })

  it.each(['bad-ack', 'quota'] as const)('aborts before byte iterator cleanup on %s', async (problem) => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    let cleaned = false
    let signal: AbortSignal | undefined
    const operation = client.prepareReleasedStore({ exportStoppedState: (received) => {
      signal = received
      return chunks([{
        name: 'sessions/session_00000001.jsonl',
        bytes: (async function* () {
          try { yield problem === 'quota' ? new Uint8Array(262145) : SESSION_BYTES } finally {
            if (!received.aborted) await new Promise<void>((resolve) => { received.addEventListener('abort', () => { resolve() }, { once: true }) })
            cleaned = true
          }
        })(),
      }])
    } })
    const rejected = expect(operation).rejects.toThrow(Fd199AuthorityError)
    try {
      await until(() => channel.sent.length === 1)
      channel.authoritySend({ kind: 'prepare-file-ack', name: 'sessions/session_00000001.jsonl', offset: 0, complete: false })
      if (problem === 'bad-ack') {
        await until(() => channel.sent.length === 2)
        channel.authoritySend({ kind: 'prepare-file-ack', name: 'sessions/session_00000001.jsonl', offset: 1, complete: false })
      }
      await until(() => cleaned)
      expect(signal?.aborted).toBe(true)
      expect(cleaned).toBe(true)
    } finally {
      await client.close()
      await rejected
    }
  })

  it('fails a pending write callback even when its response already arrived', async () => {
    vi.useFakeTimers()
    try {
      const channel = new TestChannel()
      vi.spyOn(channel, '_write').mockImplementation(() => {
        channel.authoritySend({ kind: 'ready', protocolVersion: 2, hostAppPath: '/Host' })
      })
      const client = new Fd199ChannelClient(channel)
      const assertion = expect(client.connect()).rejects.toThrow(Fd199AuthorityError)
      await vi.advanceTimersByTimeAsync(10_001)
      await assertion
      expect(channel.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed on asynchronous write errors and ignores a callback after close', async () => {
    for (const late of [false, true]) {
      const channel = new TestChannel()
      let finish: ((error?: Error | null) => void) | undefined
      vi.spyOn(channel, '_write').mockImplementation((_chunk, _encoding, callback) => { finish = callback })
      const client = new Fd199ChannelClient(channel)
      const assertion = expect(client.connect()).rejects.toThrow(Fd199AuthorityError)
      if (late) await client.close()
      finish!(late ? undefined : new Error('write failed'))
      await assertion
      expect(channel.destroyed).toBe(true)
    }
  })

  it('does not pull bytes or write another frame before the write callback even after ACK', async () => {
    const channel = new TestChannel()
    channel.autoAck = true
    let releaseWrite: (() => void) | undefined
    const write = channel._write.bind(channel)
    vi.spyOn(channel, '_write').mockImplementation((chunk, encoding, callback) => {
      write(chunk, encoding, () => { releaseWrite = () => { callback() } })
    })
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    let pulls = 0
    const prepared = client.prepareReleasedStore(exported([{
      name: 'sessions/session_00000001.jsonl',
      bytes: (async function* () { pulls += 1; yield SESSION_BYTES })(),
    }]))
    const rejected = expect(prepared).rejects.toThrow(Fd199AuthorityError)
    await until(() => releaseWrite !== undefined)
    await Promise.resolve()
    expect(pulls).toBe(0)
    expect(channel.sent).toHaveLength(1)
    releaseWrite!()
    await until(() => pulls === 1)
    expect(channel.sent).toHaveLength(2)
    await client.close()
    await rejected
  })

  it('aborts a pending producer read and awaits its handle cleanup before close resolves', async () => {
    const channel = new TestChannel()
    channel.autoAck = true
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    let reading = false
    let cleaned = false
    let receivedSignal: AbortSignal | undefined
    const prepared = client.prepareReleasedStore({
      exportStoppedState: signal => (async function* () {
        receivedSignal = signal
        try {
          yield {
            name: 'sessions/session_00000001.jsonl',
            bytes: (async function* () {
              reading = true
              await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Fd199AuthorityError()) }, { once: true }) })
              yield SESSION_BYTES
            })(),
          }
        } finally {
          await Promise.resolve()
          cleaned = true
        }
      })(),
    })
    const rejected = expect(prepared).rejects.toThrow(Fd199AuthorityError)
    await until(() => reading)
    await client.close()
    await rejected
    expect(receivedSignal?.aborted).toBe(true)
    expect(cleaned).toBe(true)
    expect(channel.written().map(message => message.kind)).toEqual(['prepare-file-begin'])
  })

  it('claims the transaction before a reentrant export factory can start another', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    let nested: Promise<void> | undefined
    const operation = client.prepareReleasedStore({ exportStoppedState: () => {
      nested = expect(client.prepareReleasedStore(exported([]))).rejects.toThrow(Fd199AuthorityError)
      return chunks([])
    } })
    await expect(operation).rejects.toThrow(Fd199AuthorityError)
    await nested
  })

  it.each(['empty-file', 'empty-chunk', 'large-chunk', 'duplicate-name', 'producer-error'] as const)('fails closed on %s without completing the export', async (problem) => {
    const channel = new TestChannel()
    channel.autoAck = true
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    const bytes = problem === 'empty-file' ? [] : [problem === 'empty-chunk' ? new Uint8Array() : problem === 'large-chunk' ? new Uint8Array(262145) : SESSION_BYTES]
    const file: Fd199ExportFile = { name: 'sessions/session_00000001.jsonl', bytes: chunks(bytes) }
    const exportStoppedState = problem === 'producer-error'
      ? (): AsyncIterable<Fd199ExportFile> => { throw new Error('read failure') }
      : (): AsyncIterable<Fd199ExportFile> => chunks(problem === 'duplicate-name' ? [file, file] : [file])
    await expect(client.prepareReleasedStore({ exportStoppedState })).rejects.toThrow(Fd199AuthorityError)
    expect(channel.written().some(message => message.kind === 'prepare-complete')).toBe(false)
    expect(channel.destroyed).toBe(true)
  })

  it('hashes one complete logical file above 10 MiB across bounded chunks', async () => {
    const channel = new TestChannel()
    channel.autoAck = true
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    const bytes = Buffer.from('🙂'.repeat(2_700_000) + '\n')
    const pieces = []
    for (let offset = 0; offset < bytes.byteLength; offset += 262144) pieces.push(bytes.subarray(offset, offset + 262144))
    const prepared = client.prepareReleasedStore(exported([{ name: 'sessions/large.jsonl', bytes: chunks(pieces) }]))
    await until(() => channel.written().some(message => message.kind === 'releasing'))
    const messages = channel.written()
    const sentChunks = messages.filter(message => message.kind === 'prepare-file-chunk')
    expect(Buffer.concat(sentChunks.map(message => Buffer.from(message.bytesBase64, 'base64url'))).equals(bytes)).toBe(true)
    expect(messages.find(message => message.kind === 'prepare-file-end')).toEqual({ kind: 'prepare-file-end', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
    channel.authoritySend({ kind: 'release-authorized' })
    await prepared
    await client.close()
  }, 30_000)

  it('safely drains a frame synchronously received by an instruction handler', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const actions: string[] = []
    client.onInstruction((action) => {
      actions.push(action)
      if (action === 'prepare') channel.emit('data', Buffer.from(frameBytes(encodeAuthorityFrame({ kind: 'instruct', action: 'activate' }))))
    })
    channel.emit('data', Buffer.from(frameBytes(encodeAuthorityFrame({ kind: 'instruct', action: 'prepare' }))))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(actions).toEqual(['prepare', 'activate'])
    expect(channel.destroyed).toBe(false)
    await client.close()
  })

  it('lets a reentrant registration drain the remaining startup instructions', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const prepare = Buffer.from(frameBytes(encodeAuthorityFrame({ kind: 'instruct', action: 'prepare' })))
    const activate = Buffer.from(frameBytes(encodeAuthorityFrame({ kind: 'instruct', action: 'activate' })))
    channel.emit('data', Buffer.concat([prepare, activate]))
    await Promise.resolve()
    await Promise.resolve()
    const actions: string[] = []
    client.onInstruction((action) => {
      actions.push(`first:${action}`)
      client.onInstruction((next) => { actions.push(`replacement:${next}`) })
    })
    expect(actions).toEqual(['first:prepare', 'replacement:activate'])
    await client.close()
  })

  it('does not dispatch a queued frame after the channel closes', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const handler = vi.fn()
    client.onInstruction(handler)
    channel.emit('data', Buffer.from(frameBytes(encodeAuthorityFrame({ kind: 'instruct', action: 'prepare' }))))
    await client.close()
    await Promise.resolve()
    expect(handler).not.toHaveBeenCalled()
  })

  it('assembles a frame split across both its prefix and body', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const connected = client.connect()
    const frame = Buffer.from(frameBytes(encodeAuthorityFrame({ kind: 'ready', protocolVersion: 2, hostAppPath: '/Host' })))
    channel.emit('data', frame.subarray(0, 2))
    channel.emit('data', frame.subarray(2, 7))
    channel.emit('data', frame.subarray(7))
    await expect(connected).resolves.toEqual({ protocolVersion: 2, hostAppPath: '/Host' })
    await client.close()
    channel.emit('data', frame)
  })

  it.each([0, 2, 16 * 1024 * 1024 + 1])('rejects invalid advertised frame length %i', async (length) => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const assertion = expect(client.connect()).rejects.toThrow(Fd199AuthorityError)
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(length)
    channel.emit('data', prefix)
    await assertion
    expect(channel.destroyed).toBe(true)
  })

  it('rejects malformed complete bodies and excessive buffered bytes', async () => {
    for (const bytes of [Buffer.from(frameBytes(new TextEncoder().encode('bad'))), Buffer.alloc(16 * 1024 * 1024 + 5)]) {
      const channel = new TestChannel()
      const client = new Fd199ChannelClient(channel)
      const assertion = expect(client.connect()).rejects.toThrow(Fd199AuthorityError)
      channel.emit('data', bytes)
      await assertion
    }
  })

  it('limits queued frames before the paced dispatcher runs', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const frame = Buffer.from(frameBytes(encodeAuthorityFrame({ kind: 'instruct', action: 'prepare' })))
    channel.emit('data', Buffer.concat(Array.from({ length: 17 }, () => frame)))
    await Promise.resolve()
    expect(channel.destroyed).toBe(true)
    await expect(client.desktopReady()).rejects.toThrow(Fd199AuthorityError)
  })

  it('queues pre-wiring instructions in order and fails the third one closed', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const send = (action: 'prepare' | 'activate'): void => { channel.emit('data', Buffer.from(frameBytes(encodeAuthorityFrame({ kind: 'instruct', action })))) }
    send('prepare')
    send('activate')
    await Promise.resolve()
    await Promise.resolve()
    const received: string[] = []
    client.onInstruction((action) => { received.push(action) })
    expect(received).toEqual(['prepare', 'activate'])
    await client.close()

    const overflow = new TestChannel()
    new Fd199ChannelClient(overflow)
    const frame = Buffer.from(frameBytes(encodeAuthorityFrame({ kind: 'instruct', action: 'prepare' })))
    overflow.emit('data', Buffer.concat([frame, frame, frame]))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(overflow.destroyed).toBe(true)
  })

  it('refuses unwired and concurrently pending transitions', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    await expect(client.prepareReleasedStore(exported([exportFile()]))).rejects.toThrow(Fd199AuthorityError)
    client.onInstruction(() => {})
    const pending = client.connect()
    const assertion = expect(pending).rejects.toThrow(Fd199AuthorityError)
    await expect(client.connect()).rejects.toThrow(Fd199AuthorityError)
    await expect(client.prepareReleasedStore(exported([exportFile()]))).rejects.toThrow(Fd199AuthorityError)
    channel.emit('error', new Error('peer failure'))
    await assertion
  })

  it('fails closed when a synchronous socket write throws, including during prepare', async () => {
    for (const prepare of [false, true]) {
      const channel = new TestChannel()
      const client = new Fd199ChannelClient(channel)
      client.onInstruction(() => {})
      vi.spyOn(channel, 'write').mockImplementation(() => { throw new Error('write failure') })
      await expect(prepare ? client.prepareReleasedStore(exported([exportFile()])) : client.connect()).rejects.toThrow(Fd199AuthorityError)
      expect(channel.destroyed).toBe(true)
    }
  })

  it('proves the handshake and reports the announced authority facts', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const connected = client.connect()
    await until(() => channel.written().length === 1)
    expect(channel.written()[0]).toEqual({ kind: 'hello', protocolVersion: 2 })
    channel.authoritySend({ kind: 'ready', protocolVersion: 2, hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host' })
    await expect(connected).resolves.toEqual({
      protocolVersion: 2,
      hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
    })
    await client.close()
  })

  it('recovers the native journal snapshot', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const recovered = client.recoverSnapshot()
    await until(() => channel.written().length === 1)
    channel.authoritySend({ kind: 'snapshot', status: 'prepared', generation: 2 })
    await expect(recovered).resolves.toEqual({ status: 'prepared', generation: 2 })
    await client.close()
  })

  it('emits the one-way desktop-ready fact only while the authority channel is idle', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    await expect(client.desktopReady()).resolves.toBeUndefined()
    expect(channel.written()).toEqual([{ kind: 'desktop-ready' }])

    const recovering = client.recoverSnapshot()
    await until(() => channel.written().length === 2)
    await expect(client.desktopReady()).rejects.toThrow(Fd199AuthorityError)
    channel.authoritySend({ kind: 'snapshot', status: 'none', generation: 0 })
    await expect(recovering).resolves.toEqual({ status: 'none', generation: 0 })
    await client.close()
  })

  it('stages the export, enters releasing, and waits for native disposal authorization', async () => {
    const channel = new TestChannel()
    channel.autoAck = true
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    const prepared = client.prepareReleasedStore(exported([exportFile(), exportFile('attachments/' + 'b'.repeat(64), new Uint8Array([1, 2, 3]))]))
    await until(() => channel.written().length >= 3)
    expect(channel.written().slice(0, 3)).toEqual([
      { kind: 'prepare-file-begin', name: 'sessions/session_00000001.jsonl' },
      { kind: 'prepare-file-chunk', offset: 0, bytesBase64: Buffer.from(SESSION_BYTES).toString('base64url') },
      { kind: 'prepare-file-end', size: SESSION_BYTES.byteLength, sha256: createHash('sha256').update(SESSION_BYTES).digest('hex') },
    ])
    await until(() => channel.written().some(message => message.kind === 'releasing'))
    channel.authoritySend({ kind: 'release-authorized' })
    await expect(prepared).resolves.toBeUndefined()
    await client.close()
  })

  it('rejects an empty export before any byte is sent', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    await expect(client.prepareReleasedStore(exported([]))).rejects.toThrow(Fd199AuthorityError)
    expect(channel.written()).toEqual([])
  })

  it('destroys the channel on a response-kind mismatch and fails the caller closed', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const recovered = client.recoverSnapshot()
    await until(() => channel.written().length === 1)
    channel.authoritySend({ kind: 'release-authorized' })
    await expect(recovered).rejects.toThrow(Fd199AuthorityError)
    await client.close()
  })

  it('buffers instructions that arrive before wiring and delivers them once registered', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    channel.authoritySend({ kind: 'instruct', action: 'prepare' })
    const received: string[] = []
    client.onInstruction((action) => { received.push(action) })
    channel.authoritySend({ kind: 'instruct', action: 'activate' })
    await until(() => received.length === 2)
    expect(received).toEqual(['prepare', 'activate'])
    await client.close()
  })

  it('destroys the channel when an instruction arrives inside a transaction window', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    const prepared = client.prepareReleasedStore(exported([exportFile()]))
    await until(() => channel.written().length >= 1)
    channel.authoritySend({ kind: 'instruct', action: 'activate' })
    await expect(prepared).rejects.toThrow(Fd199AuthorityError)
    await client.close()
  })

  it('fails the pending caller closed when the response deadline expires', async () => {
    vi.useFakeTimers()
    try {
      const channel = new TestChannel()
      const client = new Fd199ChannelClient(channel)
      const recovered = client.recoverSnapshot()
      const assertion = expect(recovered).rejects.toThrow(Fd199AuthorityError)
      await vi.advanceTimersByTimeAsync(21_000)
      await assertion
      await client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('activates through the native consume and refuses activation inside a transaction', async () => {
    const channel = new TestChannel()
    channel.autoAck = true
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    const activated = client.activate()
    await until(() => channel.written().length === 1)
    channel.authoritySend({ kind: 'activated', generation: 7 })
    await expect(activated).resolves.toEqual({ status: 'activated', generation: 7 })

    const transaction = client.prepareReleasedStore(exported([exportFile()]))
    await until(() => channel.written().length >= 3)
    await expect(client.activate()).rejects.toThrow(Fd199AuthorityError)
    await until(() => channel.written().some(message => message.kind === 'releasing'))
    channel.authoritySend({ kind: 'release-authorized' })
    await expect(transaction).resolves.toBeUndefined()
    await client.close()
  })

  it('rejects calls after close and fails pending work when the peer disappears', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    await client.close()
    await expect(client.connect()).rejects.toThrow(Fd199AuthorityError)

    const secondChannel = new TestChannel()
    const second = new Fd199ChannelClient(secondChannel)
    const pending = second.connect()
    secondChannel.destroy()
    await expect(pending).rejects.toThrow(Fd199AuthorityError)
  })

  it('destroys the channel when pre-wiring instructions overflow the bounded startup buffer', () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    for (let index = 0; index < 2; index += 1) {
      channel.authoritySend({ kind: 'instruct', action: 'prepare' })
    }
    channel.authoritySend({ kind: 'instruct', action: 'activate' })
    const received: string[] = []
    client.onInstruction((action) => { received.push(action) })
    expect(received).toEqual([])
  })
})
