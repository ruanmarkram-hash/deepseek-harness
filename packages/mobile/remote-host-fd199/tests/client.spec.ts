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
