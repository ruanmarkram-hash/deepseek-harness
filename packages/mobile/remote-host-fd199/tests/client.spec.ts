import { describe, expect, it, vi } from 'vitest'
import { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'
import { decodeFrame, encodeAuthorityFrame, frameBytes } from '../src/protocol.ts'
import type { AuthorityMessage, ClientMessage } from '../src/protocol.ts'
import { Fd199AuthorityError } from '../src/error.ts'
import { Fd199ChannelClient } from '../src/client.ts'

/** Test-side channel collecting everything the client writes and feeding scripted authority bytes. */
class TestChannel extends Duplex {
  readonly sent: Buffer[] = []
  private readonly pending = new Array<Buffer>()
  private flowing = true

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sent.push(Buffer.from(chunk))
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

function exportFile(name = 'sessions/session_00000001.jsonl', bytes = SESSION_BYTES): { name: string; sha256: string; bytes: Uint8Array } {
  return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

describe('Fd199ChannelClient', () => {
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
    const frame = Buffer.from(frameBytes(encodeAuthorityFrame({ kind: 'ready', protocolVersion: 1, hostAppPath: '/Host' })))
    channel.emit('data', frame.subarray(0, 2))
    channel.emit('data', frame.subarray(2, 7))
    channel.emit('data', frame.subarray(7))
    await expect(connected).resolves.toEqual({ protocolVersion: 1, hostAppPath: '/Host' })
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

  it('refuses unwired, empty, excessive, and concurrently pending transitions', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    await expect(client.prepareReleasedStore({ files: [exportFile()] })).rejects.toThrow(Fd199AuthorityError)
    client.onInstruction(() => {})
    await expect(client.prepareReleasedStore({ files: [] })).rejects.toThrow(Fd199AuthorityError)
    const excessive = Array.from({ length: 8193 }, () => exportFile())
    await expect(client.prepareReleasedStore({ files: excessive })).rejects.toThrow(Fd199AuthorityError)
    const pending = client.connect()
    const assertion = expect(pending).rejects.toThrow(Fd199AuthorityError)
    await expect(client.connect()).rejects.toThrow(Fd199AuthorityError)
    await expect(client.prepareReleasedStore({ files: [exportFile()] })).rejects.toThrow(Fd199AuthorityError)
    channel.emit('error', new Error('peer failure'))
    await assertion
  })

  it('fails closed when a synchronous socket write throws, including during prepare', async () => {
    for (const prepare of [false, true]) {
      const channel = new TestChannel()
      const client = new Fd199ChannelClient(channel)
      client.onInstruction(() => {})
      vi.spyOn(channel, 'write').mockImplementation(() => { throw new Error('write failure') })
      await expect(prepare ? client.prepareReleasedStore({ files: [exportFile()] }) : client.connect()).rejects.toThrow(Fd199AuthorityError)
      expect(channel.destroyed).toBe(true)
    }
  })

  it('proves the handshake and reports the announced authority facts', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    const connected = client.connect()
    await until(() => channel.written().length === 1)
    expect(channel.written()[0]).toEqual({ kind: 'hello' })
    channel.authoritySend({ kind: 'ready', protocolVersion: 1, hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host' })
    await expect(connected).resolves.toEqual({
      protocolVersion: 1,
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
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    const prepared = client.prepareReleasedStore({
      files: [exportFile(), exportFile('attachments/' + 'b'.repeat(64), new Uint8Array([1, 2, 3]))],
    })
    await until(() => channel.written().length >= 3)
    expect(channel.written().slice(0, 3)).toEqual([
      { kind: 'prepare-file', name: 'sessions/session_00000001.jsonl', sha256: exportFile().sha256, bytesBase64: Buffer.from(SESSION_BYTES).toString('base64url') },
      { kind: 'prepare-file', name: 'attachments/' + 'b'.repeat(64), sha256: exportFile('', new Uint8Array([1, 2, 3])).sha256, bytesBase64: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64url') },
      { kind: 'prepare-complete' },
    ])
    await until(() => channel.written().some(message => message.kind === 'releasing'))
    channel.authoritySend({ kind: 'release-authorized' })
    await expect(prepared).resolves.toBeUndefined()
    await client.close()
  })

  it('rejects a transition whose export digest disagrees before any byte is sent', async () => {
    const channel = new TestChannel()
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    await expect(client.prepareReleasedStore({
      files: [{ name: 'sessions/session_00000001.jsonl', bytes: SESSION_BYTES, sha256: 'a'.repeat(64) }],
    })).rejects.toThrow(Fd199AuthorityError)
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
    const prepared = client.prepareReleasedStore({
      files: [exportFile()],
    })
    await until(() => channel.written().length >= 2)
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
    const client = new Fd199ChannelClient(channel)
    client.onInstruction(() => {})
    const activated = client.activate()
    await until(() => channel.written().length === 1)
    channel.authoritySend({ kind: 'activated', generation: 7 })
    await expect(activated).resolves.toEqual({ status: 'activated', generation: 7 })

    const transaction = client.prepareReleasedStore({
      files: [exportFile()],
    })
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
