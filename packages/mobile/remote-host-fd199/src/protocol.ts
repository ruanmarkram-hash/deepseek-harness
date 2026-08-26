/**
 * FD199 framed control-channel codec: u32 big-endian body length prefix plus
 * one strict UTF-8 JSON object, shared byte-for-byte with the Swift
 * authority. Every frame is bounded; every object rejects duplicate keys,
 * unknown keys, and non-canonical encodings.
 * @module @deepseek-ai/dsh-remote-host-fd199/protocol
 */

import { z } from 'zod'
import { Fd199AuthorityError } from './error.ts'

/** Maximum encoded body bytes: one 8 MiB export file base64-encoded plus manifest overhead. */
export const REMOTE_HOST_FD199_MAX_BODY_BYTES = 16 * 1024 * 1024
/** Maximum export files in one prepared transition, matching the sealed journal bound. */
export const REMOTE_HOST_FD199_MAX_FILES = 8_192
/** Maximum decoded export-file bytes, matching the sealed journal per-file bound. */
export const REMOTE_HOST_FD199_MAX_FILE_BYTES = 8 * 1024 * 1024

/** Export artifact names the sealed FD199 grammar accepts. */
const EXPORT_NAME = /^(?:sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.jsonl|attachments\/[a-f0-9]{64})$/
const HEX_SHA256 = /^[a-f0-9]{64}$/

/** Direction-tagged union of every child-to-authority message. */
export type ClientMessage =
  | { readonly kind: 'hello' }
  | { readonly kind: 'recover' }
  | { readonly kind: 'desktop-ready' }
  | { readonly kind: 'prepare-file'; readonly name: string; readonly sha256: string; readonly bytesBase64: string }
  | { readonly kind: 'prepare-complete' }
  | { readonly kind: 'releasing' }
  | { readonly kind: 'activate' }

/** Direction-tagged union of every authority-to-child message. */
export type AuthorityMessage =
  | { readonly kind: 'ready'; readonly protocolVersion: 1; readonly hostAppPath: string }
  | { readonly kind: 'snapshot'; readonly status: 'none' | 'exported' | 'releasing' | 'prepared' | 'activated'; readonly generation: number }
  | { readonly kind: 'release-authorized' }
  | { readonly kind: 'activated'; readonly generation: number }
  | { readonly kind: 'instruct'; readonly action: 'prepare' | 'activate' }

const clientHello = z.object({ kind: z.literal('hello') }).strict()
const clientRecover = z.object({ kind: z.literal('recover') }).strict()
const clientDesktopReady = z.object({ kind: z.literal('desktop-ready') }).strict()
const clientPrepareFile = z.object({
  kind: z.literal('prepare-file'),
  name: z.string().regex(EXPORT_NAME),
  sha256: z.string().regex(HEX_SHA256),
  bytesBase64: z.string().refine(value => /^[A-Za-z0-9_-]*$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value,
    'bytesBase64 must be canonical base64url'),
}).strict().refine(
  value => Buffer.from(value.bytesBase64, 'base64').byteLength <= REMOTE_HOST_FD199_MAX_FILE_BYTES,
  { message: 'export file exceeds the per-file byte bound' },
)
const clientPrepareComplete = z.object({ kind: z.literal('prepare-complete') }).strict()
const clientReleasing = z.object({ kind: z.literal('releasing') }).strict()
const clientActivate = z.object({ kind: z.literal('activate') }).strict()

const authorityReady = z.object({
  kind: z.literal('ready'),
  protocolVersion: z.literal(1),
  hostAppPath: z.string().refine(hostAppPathSchema, 'authority path must be an absolute filesystem path'),
}).strict()
const authoritySnapshot = z.object({
  kind: z.literal('snapshot'),
  status: z.enum(['none', 'exported', 'releasing', 'prepared', 'activated']),
  generation: z.number().int().min(0).max(2_147_483_647),
}).strict()
const authorityReleaseAuthorized = z.object({ kind: z.literal('release-authorized') }).strict()
const authorityActivated = z.object({ kind: z.literal('activated'), generation: z.number().int().min(1).max(2_147_483_647) }).strict()
const authorityInstruct = z.object({ kind: z.literal('instruct'), action: z.enum(['prepare', 'activate']) }).strict()

const CLIENT_SCHEMAS = {
  hello: clientHello, recover: clientRecover, 'desktop-ready': clientDesktopReady, 'prepare-file': clientPrepareFile,
  'prepare-complete': clientPrepareComplete, releasing: clientReleasing, activate: clientActivate,
} as const

const AUTHORITY_SCHEMAS = {
  ready: authorityReady, snapshot: authoritySnapshot, 'release-authorized': authorityReleaseAuthorized,
  activated: authorityActivated, instruct: authorityInstruct,
} as const

/** @param value - Candidate host application path announced by the authority. @returns whether it is a plausible absolute path. */
function hostAppPathSchema(value: string): boolean {
  return value.startsWith('/') && value.length > 1 && !value.includes('\u0000') && !value.includes('\n')
}

/**
 * Parses one complete frame body into a validated message.
 * @param direction - Which peer sent the body; each schema set is direction-exclusive.
 * @param body - Exact UTF-8 JSON body bytes without the length prefix.
 * @returns the parsed and schema-validated message.
 */
export function decodeFrame(direction: 'client' | 'authority', body: Uint8Array): ClientMessage | AuthorityMessage {
  if (body.byteLength === 0 || body.byteLength > REMOTE_HOST_FD199_MAX_BODY_BYTES) throw new Fd199AuthorityError()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new Fd199AuthorityError()
  }
  const value = strictJsonParse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Fd199AuthorityError()
  const kind = (value as { kind?: unknown }).kind
  if (typeof kind !== 'string') throw new Fd199AuthorityError()
  const schemas = direction === 'client' ? CLIENT_SCHEMAS : AUTHORITY_SCHEMAS
  const schema = (schemas as Record<string, z.ZodType>)[kind]
  if (schema === undefined) throw new Fd199AuthorityError()
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Fd199AuthorityError()
  return parsed.data as ClientMessage & AuthorityMessage
}

/**
 * Parses JSON while rejecting duplicate object keys and invalid syntax, which
 * `JSON.parse` silently collapses.
 * @param text - Complete JSON document text.
 * @returns the parsed value.
 */
export function strictJsonParse(text: string): unknown {
  let cursor = 0
  const keyStack: Array<Set<string>> = []

  // `charAt` keeps every indexed read a definite string; a truncated document
  // only yields the empty string, which fails the delimiter comparisons and
  // reaches the trailing position check.
  const peek = (): string => text.charAt(cursor)
  const take = (): string => { const char = text.charAt(cursor); cursor += 1; return char }
  const skipWhitespace = (): void => { while (cursor < text.length && (peek() === ' ' || peek() === '\t' || peek() === '\n' || peek() === '\r')) cursor += 1 }

  const scanString = (): string => {
    if (take() !== '"') throw new Fd199AuthorityError()
    let out = ''
    while (cursor < text.length) {
      const char = take()
      if (char === '"') return out
      if (char === '\\') {
        const escape = take()
        if (escape === 'u') {
          const hex = text.slice(cursor, cursor + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Fd199AuthorityError()
          cursor += 4
          out += String.fromCharCode(Number.parseInt(hex, 16))
          continue
        }
        if (escape === '"' || escape === '\\' || escape === '/') { out += escape; continue }
        if (escape === 'b') { out += '\b'; continue }
        if (escape === 'f') { out += '\f'; continue }
        if (escape === 'n') { out += '\n'; continue }
        if (escape === 'r') { out += '\r'; continue }
        if (escape === 't') { out += '\t'; continue }
        throw new Fd199AuthorityError()
      }
      if (char.charCodeAt(0) < 0x20) throw new Fd199AuthorityError()
      out += char
    }
    throw new Fd199AuthorityError()
  }

  const scanValue = (): unknown => {
    skipWhitespace()
    const char = peek()
    if (char === '{') return scanObject()
    if (char === '[') return scanArray()
    if (char === '"') return scanString()
    if (text.startsWith('true', cursor)) { cursor += 4; return true }
    if (text.startsWith('false', cursor)) { cursor += 5; return false }
    if (text.startsWith('null', cursor)) { cursor += 4; return null }
    return scanNumber()
  }

  const scanNumber = (): number => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(cursor))
    const token = match?.[0]
    if (token === undefined || token === '') throw new Fd199AuthorityError()
    cursor += token.length
    return Number(token)
  }

  const scanObject = (): Record<string, unknown> => {
    take()
    // Null prototype: a literal `"__proto__"` key must never mutate the parsed
    // value's prototype chain or hide from the duplicate/unknown-key checks.
    const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const keys = new Set<string>()
    keyStack.push(keys)
    skipWhitespace()
    if (peek() === '}') { take(); keyStack.pop(); return object }
    while (true) {
      skipWhitespace()
      const key = scanString()
      if (keys.has(key)) throw new Fd199AuthorityError()
      keys.add(key)
      skipWhitespace()
      if (take() !== ':') throw new Fd199AuthorityError()
      object[key] = scanValue()
      skipWhitespace()
      const separator = take()
      if (separator === '}') { keyStack.pop(); return object }
      if (separator !== ',') throw new Fd199AuthorityError()
    }
  }

  const scanArray = (): unknown[] => {
    take()
    const array: unknown[] = []
    skipWhitespace()
    if (peek() === ']') { take(); return array }
    while (true) {
      array.push(scanValue())
      skipWhitespace()
      const separator = take()
      if (separator === ']') return array
      if (separator !== ',') throw new Fd199AuthorityError()
    }
  }

  const value = scanValue()
  skipWhitespace()
  if (cursor !== text.length) throw new Fd199AuthorityError()
  return value
}

/** @param message - Validated client message. @returns exact UTF-8 body bytes for one frame. */
export function encodeClientFrame(message: ClientMessage): Uint8Array {
  const schema = CLIENT_SCHEMAS[message.kind]
  const parsed = schema.safeParse(message)
  if (!parsed.success) throw new Fd199AuthorityError()
  return encodeBody(parsed.data)
}

/** @param message - Validated authority message. @returns exact UTF-8 body bytes for one frame. */
export function encodeAuthorityFrame(message: AuthorityMessage): Uint8Array {
  const schema = AUTHORITY_SCHEMAS[message.kind]
  const parsed = schema.safeParse(message)
  if (!parsed.success) throw new Fd199AuthorityError()
  return encodeBody(parsed.data)
}

/** @param message - Schema-valid message object. @returns canonical compact JSON body bytes. */
function encodeBody(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message))
  if (body.byteLength > REMOTE_HOST_FD199_MAX_BODY_BYTES) throw new Fd199AuthorityError()
  return body
}

/**
 * Prepends the u32 big-endian length prefix to one encoded body.
 * @param body - Frame body bytes within the shared bound.
 * @returns the complete frame ready to write.
 */
export function frameBytes(body: Uint8Array): Uint8Array {
  if (body.byteLength > REMOTE_HOST_FD199_MAX_BODY_BYTES) throw new Fd199AuthorityError()
  const frame = new Uint8Array(body.byteLength + 4)
  new DataView(frame.buffer).setUint32(0, body.byteLength, false)
  frame.set(body, 4)
  return frame
}
