import { describe, expect, it } from 'vitest'
import {
  REMOTE_HOST_FD199_MAX_BODY_BYTES,
  REMOTE_HOST_FD199_MAX_FILE_BYTES,
  decodeFrame,
  encodeAuthorityFrame,
  encodeClientFrame,
  frameBytes,
  strictJsonParse,
} from '../src/protocol.ts'
import { Fd199AuthorityError } from '../src/error.ts'

const FILE_BYTES = new TextEncoder().encode('{"id":"same-session"}\n')

describe('FD199 frame codec', () => {
  it('round-trips every client and authority message through the shared bounds', () => {
    const clientMessages = [
      { kind: 'hello' },
      { kind: 'recover' },
      { kind: 'desktop-ready' },
      { kind: 'prepare-file', name: 'sessions/session_00000001.jsonl', sha256: 'a'.repeat(64), bytesBase64: Buffer.from(FILE_BYTES).toString('base64url') },
      { kind: 'prepare-file', name: 'attachments/' + 'b'.repeat(64), sha256: 'a'.repeat(64), bytesBase64: '' },
      { kind: 'prepare-complete' },
      { kind: 'releasing' },
      { kind: 'activate' },
    ] as const
    for (const message of clientMessages) {
      const body = encodeClientFrame(message)
      expect(decodeFrame('client', body)).toEqual(message)
    }
    const authorityMessages = [
      { kind: 'ready', protocolVersion: 1, hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host' },
      { kind: 'snapshot', status: 'none', generation: 0 },
      { kind: 'snapshot', status: 'exported', generation: 0 },
      { kind: 'snapshot', status: 'releasing', generation: 0 },
      { kind: 'snapshot', status: 'activated', generation: 3 },
      { kind: 'release-authorized' },
      { kind: 'activated', generation: 1 },
      { kind: 'instruct', action: 'prepare' },
      { kind: 'instruct', action: 'activate' },
    ] as const
    for (const message of authorityMessages) {
      const body = encodeAuthorityFrame(message)
      expect(decodeFrame('authority', body)).toEqual(message)
    }
  })

  it('prefixes the u32 big-endian body length', () => {
    const body = encodeClientFrame({ kind: 'hello' })
    const frame = frameBytes(body)
    expect(frame.byteLength).toBe(body.byteLength + 4)
    expect(frame[0]).toBe(0)
    expect(frame[1]).toBe(0)
    expect(frame[2]).toBe(0)
    expect(frame[3]).toBe(body.byteLength)
    expect(Array.from(frame.subarray(4))).toEqual(Array.from(body))
  })

  it('rejects oversized frames and bodies', () => {
    expect(() => frameBytes(new Uint8Array(REMOTE_HOST_FD199_MAX_BODY_BYTES + 1))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new Uint8Array(REMOTE_HOST_FD199_MAX_BODY_BYTES + 1))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new Uint8Array(0))).toThrow(Fd199AuthorityError)
  })

  it('rejects direction-crossing, unknown, and malformed frames', () => {
    const clientBody = encodeClientFrame({ kind: 'hello' })
    expect(() => decodeFrame('authority', clientBody)).toThrow(Fd199AuthorityError)
    const authorityBody = encodeAuthorityFrame({ kind: 'release-authorized' })
    expect(() => decodeFrame('client', authorityBody)).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new TextEncoder().encode('{"kind":"explode"}'))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new TextEncoder().encode('{"kind":"instruct","action":"detonate"}'))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new TextEncoder().encode('not json'))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new TextEncoder().encode('[]'))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new TextEncoder().encode('"hello"'))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new Uint8Array([0xff, 0xfe]))).toThrow(Fd199AuthorityError)
    expect(() => encodeClientFrame({ kind: 'prepare-file', name: '../escape.jsonl', sha256: 'a'.repeat(64), bytesBase64: '' })).toThrow(Fd199AuthorityError)
    expect(() => encodeClientFrame({ kind: 'prepare-file', name: 'sessions/session_00000001.jsonl', sha256: 'A'.repeat(64), bytesBase64: '' })).toThrow(Fd199AuthorityError)
  })

  it('rejects export files above the per-file bound', () => {
    const oversized = Buffer.from(new Uint8Array(REMOTE_HOST_FD199_MAX_FILE_BYTES + 1)).toString('base64url')
    expect(() => encodeClientFrame({
      kind: 'prepare-file', name: 'sessions/session_00000001.jsonl', sha256: 'a'.repeat(64), bytesBase64: oversized,
    })).toThrow(Fd199AuthorityError)
  })
})

describe('strictJsonParse', () => {
  it('parses standard documents and rejects duplicate keys and trailing content', () => {
    expect(strictJsonParse('{"a":1,"b":{"c":[true,false,null,"x\\u0041"]}}')).toEqual({ a: 1, b: { c: [true, false, null, 'xA'] } })
    expect(() => strictJsonParse('{"a":1,"a":2}')).toThrow(Fd199AuthorityError)
    expect(() => strictJsonParse('{"a":1,"b":{"c":1,"c":2}}')).toThrow(Fd199AuthorityError)
    expect(() => strictJsonParse('{"a":1} trailing')).toThrow(Fd199AuthorityError)
    expect(() => strictJsonParse('{"a":}')).toThrow(Fd199AuthorityError)
    expect(() => strictJsonParse("{'a':1}")).toThrow(Fd199AuthorityError)
    expect(() => strictJsonParse('{"a":01}')).toThrow(Fd199AuthorityError)
    expect(() => strictJsonParse('{"a":"x"}')).not.toThrow()
    expect(() => strictJsonParse('{"a":"raw\ttab"}')).toThrow(Fd199AuthorityError)
  })
})
