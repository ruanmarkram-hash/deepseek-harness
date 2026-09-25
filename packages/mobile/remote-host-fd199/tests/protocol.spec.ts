import { describe, expect, it } from 'vitest'
import {
  REMOTE_HOST_FD199_MAX_BODY_BYTES,
  decodeFrame,
  encodeAuthorityFrame,
  encodeClientFrame,
  frameBytes,
  strictJsonParse,
} from '../src/protocol.ts'
import type { AuthorityMessage, ClientMessage } from '../src/protocol.ts'
import { Fd199AuthorityError } from '../src/error.ts'

const FILE_BYTES = new TextEncoder().encode('{"id":"same-session"}\n')
const FILE_NAME = 'sessions/session_00000001.jsonl'
const DIGEST = 'a'.repeat(64)
const CHUNK_BYTES = 262_144
const TOTAL_BYTES = 134_217_728

function body(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

describe('FD199 frame codec', () => {
  it('round-trips every client and authority message through the shared bounds', () => {
    const clientMessages: ClientMessage[] = [
      { kind: 'hello', protocolVersion: 2 },
      { kind: 'recover' },
      { kind: 'desktop-ready' },
      { kind: 'prepare-file-begin', name: FILE_NAME },
      { kind: 'prepare-file-begin', name: 'attachments/' + 'b'.repeat(64) },
      { kind: 'prepare-file-chunk', offset: 0, bytesBase64: Buffer.from(FILE_BYTES).toString('base64url') },
      { kind: 'prepare-file-end', size: FILE_BYTES.byteLength, sha256: DIGEST },
      { kind: 'prepare-complete' },
      { kind: 'releasing' },
      { kind: 'activate' },
    ]
    for (const message of clientMessages) {
      const body = encodeClientFrame(message)
      expect(decodeFrame('client', body)).toEqual(message)
    }
    const authorityMessages: AuthorityMessage[] = [
      { kind: 'ready', protocolVersion: 2, hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host' },
      { kind: 'snapshot', status: 'none', generation: 0 },
      { kind: 'snapshot', status: 'exported', generation: 0 },
      { kind: 'snapshot', status: 'releasing', generation: 0 },
      { kind: 'snapshot', status: 'prepared', generation: 2 },
      { kind: 'snapshot', status: 'activated', generation: 3 },
      { kind: 'release-authorized' },
      { kind: 'activated', generation: 1 },
      { kind: 'instruct', action: 'prepare' },
      { kind: 'instruct', action: 'activate' },
      { kind: 'prepare-file-ack', name: FILE_NAME, offset: 0, complete: false },
      { kind: 'prepare-file-ack', name: FILE_NAME, offset: FILE_BYTES.byteLength, complete: false },
      { kind: 'prepare-file-ack', name: FILE_NAME, offset: FILE_BYTES.byteLength, complete: true },
    ]
    for (const message of authorityMessages) {
      const body = encodeAuthorityFrame(message)
      expect(decodeFrame('authority', body)).toEqual(message)
    }
  })

  it('prefixes the u32 big-endian body length', () => {
    const body = encodeClientFrame({ kind: 'hello', protocolVersion: 2 })
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
    const clientBody = encodeClientFrame({ kind: 'hello', protocolVersion: 2 })
    expect(() => decodeFrame('authority', clientBody)).toThrow(Fd199AuthorityError)
    const authorityBody = encodeAuthorityFrame({ kind: 'release-authorized' })
    expect(() => decodeFrame('client', authorityBody)).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new TextEncoder().encode('{"kind":"explode"}'))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new TextEncoder().encode('{"kind":"instruct","action":"detonate"}'))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new TextEncoder().encode('not json'))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new TextEncoder().encode('[]'))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new TextEncoder().encode('"hello"'))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', new Uint8Array([0xff, 0xfe]))).toThrow(Fd199AuthorityError)
    expect(() => encodeClientFrame({ kind: 'prepare-file-begin', name: '../escape.jsonl' })).toThrow(Fd199AuthorityError)
    expect(() => encodeClientFrame({ kind: 'prepare-file-end', size: 1, sha256: 'A'.repeat(64) })).toThrow(Fd199AuthorityError)
  })

  it('bounds individual chunks independently of logical artifact size', () => {
    for (const size of [1, CHUNK_BYTES]) {
      const message: ClientMessage = { kind: 'prepare-file-chunk', offset: 0, bytesBase64: Buffer.alloc(size, 255).toString('base64url') }
      expect(decodeFrame('client', encodeClientFrame(message))).toEqual(message)
    }
    for (const size of [0, CHUNK_BYTES + 1]) {
      expect(() => decodeFrame('client', body({ kind: 'prepare-file-chunk', offset: 0, bytesBase64: Buffer.alloc(size).toString('base64url') }))).toThrow(Fd199AuthorityError)
    }
    for (const size of [10 * 1024 * 1024, TOTAL_BYTES]) {
      const message: ClientMessage = { kind: 'prepare-file-end', size, sha256: DIGEST }
      expect(decodeFrame('client', encodeClientFrame(message))).toEqual(message)
    }
  })

  it.each([undefined, 1, 3, '2', null])('refuses missing, legacy, or unsupported peer version %j', (protocolVersion) => {
    expect(() => decodeFrame('client', body({ kind: 'hello', protocolVersion }))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', body({ kind: 'ready', protocolVersion, hostAppPath: '/Applications/DSH Host.app' }))).toThrow(Fd199AuthorityError)
  })

  it.each([
    { kind: 'prepare-file', name: FILE_NAME, sha256: DIGEST, bytesBase64: 'YQ' },
    { kind: 'hello', protocolVersion: 2, fallbackVersion: 1 },
    { kind: 'prepare-file-begin', name: FILE_NAME, size: 1 },
    { kind: 'prepare-file-chunk', offset: 0, bytesBase64: 'YQ', name: FILE_NAME },
    { kind: 'prepare-file-end', size: 1, sha256: DIGEST, name: FILE_NAME },
  ])('refuses legacy or unsupported client fields %j', (message) => {
    expect(() => decodeFrame('client', body(message))).toThrow(Fd199AuthorityError)
  })

  it.each(['', 'YQ=', 'YQ==', 'YR', 'Y Q', '+w', '/w', 'a', 1, null])('refuses noncanonical or empty chunk bytes %j', (bytesBase64) => {
    expect(() => decodeFrame('client', body({ kind: 'prepare-file-chunk', offset: 0, bytesBase64 }))).toThrow(Fd199AuthorityError)
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined])('refuses unsafe or nonnumeric offsets %j in chunks and ACKs', (offset) => {
    expect(() => decodeFrame('client', body({ kind: 'prepare-file-chunk', offset, bytesBase64: 'YQ' }))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', body({ kind: 'prepare-file-ack', name: FILE_NAME, offset, complete: false }))).toThrow(Fd199AuthorityError)
  })

  it.each([0, -1, 0.5, TOTAL_BYTES + 1, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined])('refuses invalid logical end size %j', (size) => {
    expect(() => decodeFrame('client', body({ kind: 'prepare-file-end', size, sha256: DIGEST }))).toThrow(Fd199AuthorityError)
  })

  it.each(['', DIGEST.toUpperCase(), 'a'.repeat(63), 'g'.repeat(64), null, undefined])('refuses noncanonical end digest %j', (sha256) => {
    expect(() => decodeFrame('client', body({ kind: 'prepare-file-end', size: 1, sha256 }))).toThrow(Fd199AuthorityError)
  })

  it.each(['../escape.jsonl', 'sessions/.jsonl', 'sessions/a/b.jsonl', 'sessions/a.json', 'attachments/' + 'A'.repeat(64), '', null, undefined])('refuses invalid begin and ACK names %j', (name) => {
    expect(() => decodeFrame('client', body({ kind: 'prepare-file-begin', name }))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('authority', body({ kind: 'prepare-file-ack', name, offset: 0, complete: false }))).toThrow(Fd199AuthorityError)
  })

  it.each([0, 1, 'false', null, undefined])('requires a boolean ACK completion field %j', (complete) => {
    expect(() => decodeFrame('authority', body({ kind: 'prepare-file-ack', name: FILE_NAME, offset: 0, complete }))).toThrow(Fd199AuthorityError)
  })

  it('refuses unknown ACK fields, duplicate keys, and wrong-direction streaming records', () => {
    const ack = { kind: 'prepare-file-ack', name: FILE_NAME, offset: 0, complete: false }
    expect(() => decodeFrame('authority', body({ ...ack, sha256: DIGEST }))).toThrow(Fd199AuthorityError)
    expect(() => decodeFrame('client', body(ack))).toThrow(Fd199AuthorityError)
    for (const message of [
      { kind: 'prepare-file-begin', name: FILE_NAME },
      { kind: 'prepare-file-chunk', offset: 0, bytesBase64: 'YQ' },
      { kind: 'prepare-file-end', size: 1, sha256: DIGEST },
    ]) expect(() => decodeFrame('authority', body(message))).toThrow(Fd199AuthorityError)
    for (const text of [
      '{"kind":"hello","protocolVersion":2,"protocolVersion":1}',
      '{"kind":"prepare-file-chunk","offset":0,"offset":1,"bytesBase64":"YQ"}',
      `{"kind":"prepare-file-ack","name":"${FILE_NAME}","offset":0,"complete":false,"complete":true}`,
    ]) expect(() => decodeFrame(text.includes('prepare-file-ack') ? 'authority' : 'client', new TextEncoder().encode(text))).toThrow(Fd199AuthorityError)
  })
})

describe('strictJsonParse', () => {
  it('preserves every JSON escape and whitespace separator', () => {
    const value = '"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0041"'
    expect(strictJsonParse(` \t\r\n${value} \t\r\n`)).toBe(JSON.parse(value))
    expect(strictJsonParse('{}')).toEqual({})
    expect(strictJsonParse('[{},[],1,-2.5e+3]')).toEqual([{}, [], 1, -2500])
  })

  it.each(['"unterminated', '"\\x"', '"\\u123"', '{"x" 1}', '[1;2]', '{}{}'])('rejects invalid JSON %s', (text) => {
    expect(() => strictJsonParse(text)).toThrow(Fd199AuthorityError)
  })

  it('rejects absent frame kinds and invalid or oversized authority values', () => {
    expect(() => decodeFrame('client', new TextEncoder().encode('{}'))).toThrow(Fd199AuthorityError)
    expect(() => encodeAuthorityFrame({ kind: 'activated', generation: 0 })).toThrow(Fd199AuthorityError)
    expect(() => encodeAuthorityFrame({ kind: 'ready', protocolVersion: 2, hostAppPath: '/' + 'a'.repeat(REMOTE_HOST_FD199_MAX_BODY_BYTES) })).toThrow(Fd199AuthorityError)
  })

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
