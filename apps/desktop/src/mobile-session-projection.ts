import { randomBytes } from 'node:crypto'

const HANDLE_BYTES = 32
const HANDLE_PREFIX = 'dshm_'
const MAX_HISTORY_EVENTS = 256
const MAX_VISIBLE_SESSIONS = 24
const MAX_VISIBLE_MESSAGES = 24
const MAX_TEXT_BLOCKS = 32
const MAX_MESSAGE_TEXT_BYTES = 2 * 1_024
const MAX_PROMPT_LENGTH = 4_096
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u

/** Desktop-only source data for one DSH session. `sessionKey` is never sent to mobile. */
export interface DesktopSessionHistory {
  readonly history: unknown
  readonly sessionKey: string
}

/** A deliberately narrow, mobile-safe rendering of one desktop session. */
export interface MobileSessionView {
  readonly handle: string
  readonly messages: readonly MobileSessionText[]
}

/** One safe text-only message suitable for the mobile conversation surface. */
export interface MobileSessionText {
  readonly role: 'assistant' | 'user'
  readonly text: string
}

/** A desktop-validated mobile prompt, ready only for an allowlisted session bridge. */
export interface ValidatedMobilePrompt {
  readonly handle: string
  readonly text: string
}

/** Platform primitives owned by the Electron main process. */
export interface MobileSessionProjectionOptions {
  readonly randomBytes?: (size: number) => Uint8Array
}

interface ActiveSession {
  readonly handle: string
  readonly sessionKey: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function handleFrom(bytes: Uint8Array): string {
  if (bytes.byteLength !== HANDLE_BYTES) {
    throw new Error('DSH Desktop could not create a mobile session handle.')
  }
  return `${HANDLE_PREFIX}${Buffer.from(bytes).toString('base64url')}`
}

function validSessionKey(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !DISALLOWED_CONTROL.test(value)
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string' || DISALLOWED_CONTROL.test(value)) return undefined
  let text = ''
  let bytes = 0
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + nextBytes > MAX_MESSAGE_TEXT_BYTES) break
    text += codePoint
    bytes += nextBytes
  }
  return text.trim().length === 0 ? undefined : text
}

function textBlocks(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text: string[] = []
  let remaining = MAX_MESSAGE_TEXT_BYTES
  for (const block of content.slice(0, MAX_TEXT_BLOCKS)) {
    const record = asRecord(block)
    if (record?.type !== 'text') continue
    const value = safeText(record.text)
    if (value === undefined) continue
    let part = ''
    let bytes = 0
    for (const codePoint of value) {
      const nextBytes = Buffer.byteLength(codePoint, 'utf8')
      if (bytes + nextBytes > remaining) break
      part += codePoint
      bytes += nextBytes
    }
    if (part.length > 0) text.push(part)
    remaining -= Buffer.byteLength(part, 'utf8')
    if (remaining === 0) break
  }
  const joined = text.join('')
  return joined.length === 0 ? undefined : joined
}

function projectEvent(value: unknown): MobileSessionText | undefined {
  const event = asRecord(value)
  const data = asRecord(event?.data)
  if (event?.type === 'user/message' && data !== undefined) {
    const source = asRecord(data.source)
    const text = source?.kind === 'user' ? textBlocks(data.content) : undefined
    return text === undefined ? undefined : { role: 'user', text }
  }
  if (event?.type === 'assistant/message' && data !== undefined) {
    const message = asRecord(data.message)
    const text = message?.role === 'assistant' ? textBlocks(message.content) : undefined
    return text === undefined ? undefined : { role: 'assistant', text }
  }
  return undefined
}

function projectHistory(value: unknown): readonly MobileSessionText[] {
  if (!Array.isArray(value)) return []
  const messages: MobileSessionText[] = []
  const first = Math.max(0, value.length - MAX_HISTORY_EVENTS)
  for (let index = first; index < value.length; index += 1) {
    const message = projectEvent(value[index])
    if (message !== undefined) messages.push(message)
  }
  return messages.slice(-MAX_VISIBLE_MESSAGES)
}

/**
 * Keep an in-memory, desktop-owned mapping between DSH session keys and opaque
 * mobile handles. It projects only text-message events and validates prompts
 * for the explicitly selected current handle.
 */
export class MobileSessionProjection {
  private readonly nextBytes: (size: number) => Uint8Array
  private readonly sessionsByHandle = new Map<string, ActiveSession>()
  private readonly handlesBySessionKey = new Map<string, string>()
  private selectedHandle: string | undefined

  /** Create an isolated desktop projection with injectable randomness for tests. */
  constructor(options: MobileSessionProjectionOptions = {}) {
    this.nextBytes = options.randomBytes ?? randomBytes
  }

  /**
   * Replace the mobile-visible session set using current desktop histories.
   * Missing or malformed sources are revoked, making their prior handles stale.
   *
   * @param sources - Desktop-owned session keys and raw DSH event histories.
   * @returns Safe views with opaque handles and bounded plain text only.
   */
  project(sources: readonly DesktopSessionHistory[]): readonly MobileSessionView[] {
    const currentKeys = new Set<string>()
    const visible: MobileSessionView[] = []
    for (const source of sources.slice(0, MAX_VISIBLE_SESSIONS)) {
      const sourceRecord = asRecord(source)
      const sessionKey = sourceRecord?.sessionKey
      if (typeof sessionKey !== 'string' || !validSessionKey(sessionKey) || currentKeys.has(sessionKey)) continue
      currentKeys.add(sessionKey)
      const handle = this.handleFor(sessionKey)
      visible.push({ handle, messages: projectHistory(sourceRecord?.history) })
    }
    for (const [sessionKey, handle] of this.handlesBySessionKey) {
      if (currentKeys.has(sessionKey)) continue
      this.handlesBySessionKey.delete(sessionKey)
      this.sessionsByHandle.delete(handle)
      if (this.selectedHandle === handle) this.selectedHandle = undefined
    }
    return visible
  }

  /**
   * Mark one current opaque handle as the only mobile session eligible for actions.
   *
   * @param handle - Opaque handle returned by {@link project}.
   * @returns The selected opaque handle without its desktop session key.
   */
  select(handle: unknown): { readonly handle: string } {
    const active = this.activeHandle(handle)
    this.selectedHandle = active.handle
    return { handle: active.handle }
  }

  /**
   * Validate a plain mobile prompt for the explicitly selected current handle.
   * Slash commands, control characters, blank values, and oversized values are refused.
   *
   * @param handle - Opaque handle returned by {@link project} and accepted by {@link select}.
   * @param prompt - Untrusted mobile input.
   * @returns A bounded plain prompt for a future allowlisted desktop session bridge.
   */
  validatePrompt(handle: unknown, prompt: unknown): ValidatedMobilePrompt {
    const active = this.selectedActiveHandle(handle)
    if (typeof prompt !== 'string'
      || prompt.length === 0
      || prompt.length > MAX_PROMPT_LENGTH
      || DISALLOWED_CONTROL.test(prompt)
      || prompt.trim().length === 0
      || prompt.trimStart().startsWith('/')) {
      throw new Error('DSH Desktop rejected the mobile prompt.')
    }
    return { handle: active.handle, text: prompt }
  }

  /** Confirm that an opaque handle is the selected current desktop session. */
  validateSelectedHandle(handle: unknown): { readonly handle: string } {
    return { handle: this.selectedActiveHandle(handle).handle }
  }

  /** Revoke every opaque handle when the desktop pairing or session bridge closes. */
  close(): void {
    this.sessionsByHandle.clear()
    this.handlesBySessionKey.clear()
    this.selectedHandle = undefined
  }

  private handleFor(sessionKey: string): string {
    const existing = this.handlesBySessionKey.get(sessionKey)
    if (existing !== undefined) return existing
    let handle = ''
    for (let attempt = 0; attempt < 4; attempt += 1) {
      handle = handleFrom(this.nextBytes(HANDLE_BYTES))
      if (!this.sessionsByHandle.has(handle)) break
    }
    if (this.sessionsByHandle.has(handle)) {
      throw new Error('DSH Desktop could not create a mobile session handle.')
    }
    this.handlesBySessionKey.set(sessionKey, handle)
    this.sessionsByHandle.set(handle, { handle, sessionKey })
    return handle
  }

  private activeHandle(value: unknown): ActiveSession {
    if (typeof value !== 'string') throw new Error('DSH Desktop rejected the mobile session handle.')
    const active = this.sessionsByHandle.get(value)
    if (active === undefined) throw new Error('DSH Desktop rejected the mobile session handle.')
    return active
  }

  private selectedActiveHandle(value: unknown): ActiveSession {
    const active = this.activeHandle(value)
    if (this.selectedHandle !== active.handle) {
      throw new Error('DSH Desktop rejected the unselected mobile session handle.')
    }
    return active
  }
}
