/** Synthetic real-client peer for the Swift FD199 socketpair integration test. */
import { Socket } from 'node:net'
import { Fd199ChannelClient } from '../../../../packages/mobile/remote-host-fd199/src/client.ts'
import type { Fd199ExportFile } from '../../../../packages/mobile/remote-host-fd199/src/types.ts'

const mode = process.argv[2]
if (mode !== 'export' && mode !== 'activate') throw new Error('expected export or activate mode')

// The Swift test independently builds these exact UTF-8 bytes and digest.
const large = Buffer.from('{"text":"' + '🙂'.repeat(2_700_000) + '"}\n', 'utf8')
const small = Buffer.from('{"text":"small"}\n', 'utf8')
const client = new Fd199ChannelClient(new Socket({ fd: 199, readable: true, writable: true }))

async function* byteChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 262_144) yield bytes.subarray(offset, offset + 262_144)
}

async function* exportFiles(signal: AbortSignal): AsyncGenerator<Fd199ExportFile> {
  signal.throwIfAborted()
  yield { name: 'sessions/large_session.jsonl', bytes: byteChunks(large) }
  signal.throwIfAborted()
  yield { name: 'sessions/small_session.jsonl', bytes: byteChunks(small) }
  signal.throwIfAborted()
}

await client.connect()
const snapshot = await client.recoverSnapshot()
if (mode === 'export') {
  if (snapshot.status !== 'none') throw new Error('export requires fresh journal')
  await client.desktopReady()
} else if (snapshot.status !== 'prepared') {
  throw new Error('activation requires prepared journal')
}

await new Promise<void>((resolve, reject) => {
  client.onInstruction((action) => {
    if (action !== (mode === 'export' ? 'prepare' : 'activate')) {
      reject(new Error('unexpected authority instruction'))
      return
    }
    const operation = mode === 'export'
      ? client.prepareReleasedStore({ exportStoppedState: exportFiles })
      : client.activate()
    operation.then(() => { resolve() }, reject)
  })
})
await client.close()
