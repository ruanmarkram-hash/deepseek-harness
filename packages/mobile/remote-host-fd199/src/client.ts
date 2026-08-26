/**
 * Strict serial client for the signed-Host FD199 authority over the
 * inherited kernel-private socketpair. One outstanding response at a time;
 * authority instructions are demultiplexed outside transaction windows; any
 * unexpected frame, oversized buffer, or deadline destroys the channel and
 * fails every pending caller closed.
 * @module @deepseek-ai/dsh-remote-host-fd199/client
 */

import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { Duplex } from 'node:stream'
import {
  REMOTE_HOST_FD199_MAX_BODY_BYTES,
  REMOTE_HOST_FD199_MAX_FILES,
  decodeFrame,
  encodeClientFrame,
  frameBytes,
} from './protocol.ts'
import type { AuthorityMessage, ClientMessage } from './protocol.ts'
import { Fd199AuthorityError } from './error.ts'
import type {
  Fd199AuthorityClient,
  Fd199AuthorityFacts,
  Fd199ExportFile,
  Fd199InstructionAction,
  Fd199OwnershipSnapshot,
} from './types.ts'

/** Handshake deadline; the supervisor child must answer immediately or not at all. */
const HANDSHAKE_DEADLINE_MS = 10_000
/** Per-response deadline inside an established session. */
const RESPONSE_DEADLINE_MS = 20_000
/** Maximum buffered partial-frame bytes: one maximum body plus its length prefix. */
const MAX_BUFFERED_BYTES = REMOTE_HOST_FD199_MAX_BODY_BYTES + 4
/** Maximum complete frames retained before the paced dispatcher consumes them. */
const MAX_QUEUED_FRAMES = 16

/** One deadline-guarded continuation awaiting exactly one response kind. */
interface PendingResponse {
  readonly kind: AuthorityMessage['kind']
  readonly resolve: (message: AuthorityMessage) => void
  readonly reject: (error: Fd199AuthorityError) => void
  readonly timer: NodeJS.Timeout
}

/**
 * Opens the strict client session over an already-adopted descriptor socket.
 * The instance performs no I/O until {@link Fd199AuthorityClient.connect}.
 */
export class Fd199ChannelClient implements Fd199AuthorityClient {
  readonly kind = 'native-attested-fd199-same-store-transition-v1' as const

  private readonly channel: Duplex
  private buffer: Buffer = Buffer.alloc(0)
  private pending: PendingResponse | undefined
  private instructionHandler: ((action: Fd199InstructionAction) => void) | undefined
  private readonly instructionQueue: Fd199InstructionAction[] = []
  private readonly frameQueue: AuthorityMessage[] = []
  private pumpScheduled = false
  private inTransaction = false
  private closed: boolean = false

  /** @param channel - Adopted inherited authority channel; ownership moves to this client. */
  constructor(channel: Duplex) {
    this.channel = channel
    channel.on('data', (chunk: Buffer) => { this.receive(chunk) })
    channel.on('error', () => { this.destroy() })
    channel.on('close', () => { this.destroy() })
  }

  /** @inheritdoc */
  connect(): Promise<Fd199AuthorityFacts> {
    return this.exchange({ kind: 'hello' }, 'ready', HANDSHAKE_DEADLINE_MS).then((response) => {
      const ready = response as Extract<AuthorityMessage, { kind: 'ready' }>
      return { protocolVersion: ready.protocolVersion, hostAppPath: ready.hostAppPath }
    })
  }

  /** @inheritdoc */
  recoverSnapshot(): Promise<Fd199OwnershipSnapshot> {
    return this.exchange({ kind: 'recover' }, 'snapshot', RESPONSE_DEADLINE_MS).then((response) => {
      const snapshot = response as Extract<AuthorityMessage, { kind: 'snapshot' }>
      return { status: snapshot.status, generation: snapshot.generation }
    })
  }

  desktopReady(): Promise<void> {
    if (this.closed || this.pending !== undefined || this.inTransaction || !this.sendOrDestroy({ kind: 'desktop-ready' })) return Promise.reject(new Fd199AuthorityError())
    return Promise.resolve()
  }

  /** @inheritdoc */
  activate(): Promise<Fd199OwnershipSnapshot> {
    if (this.closed || this.pending !== undefined || this.inTransaction) return Promise.reject(new Fd199AuthorityError())
    return this.exchange({ kind: 'activate' }, 'activated', RESPONSE_DEADLINE_MS).then((response) => {
      const activated = response as Extract<AuthorityMessage, { kind: 'activated' }>
      return { status: 'activated' as const, generation: activated.generation }
    })
  }

  /**
   * Registers the single instruction callback. Instructions that arrived
   * earlier are delivered in order; later ones are delivered as received.
   * @param handler - The only lifecycle instruction consumer.
   */
  onInstruction(handler: (action: Fd199InstructionAction) => void): void {
    this.instructionHandler = handler
    while (!this.closed && this.instructionQueue.length > 0) {
      const action = this.instructionQueue.shift()
      if (action !== undefined) handler(action)
    }
  }

  /**
   * Runs the atomic same-store transition: stream digest-verified export
   * files, explicitly enter the native `releasing` journal state, then wait
   * for authorization to dispose.  The child sends nothing after its root
   * starts closing: native promotes `releasing` to `prepared` only after PID
   * reap, which is the ownership proof.
   * @param input - Verified export files.
   */
  async prepareReleasedStore(input: Readonly<{
    files: readonly Fd199ExportFile[]
  }>): Promise<void> {
    if (this.closed || this.pending !== undefined || this.inTransaction || this.instructionHandler === undefined) {
      throw new Fd199AuthorityError()
    }
    if (input.files.length === 0 || input.files.length > REMOTE_HOST_FD199_MAX_FILES) throw new Fd199AuthorityError()
    for (const file of input.files) assertVerifiedExport(file)
    this.inTransaction = true
    try {
      for (const file of input.files) {
        this.sendOrDestroy({
          kind: 'prepare-file',
          name: file.name,
          sha256: file.sha256,
          bytesBase64: encodeBase64Url(file.bytes),
        })
      }
      this.sendOrDestroy({ kind: 'prepare-complete' })
      this.sendOrDestroy({ kind: 'releasing' })
      await this.awaitResponse('release-authorized')
    } finally {
      this.inTransaction = false
    }
  }

  /** @inheritdoc */
  close(): Promise<void> {
    this.destroy()
    return Promise.resolve()
  }

  /**
   * Writes one request and awaits exactly its correlated response kind.
   * @param message - Request frame body.
   * @param kind - The single acceptable response kind.
   * @param timeoutMs - Response deadline.
   */
  private exchange(message: ClientMessage, kind: AuthorityMessage['kind'], timeoutMs: number): Promise<AuthorityMessage> {
    if (this.closed || this.pending !== undefined || !this.sendOrDestroy(message)) {
      return Promise.reject(new Fd199AuthorityError())
    }
    return this.awaitResponse(kind, timeoutMs)
  }

  /**
   * Registers the single deadline-guarded continuation for one response kind.
   * @param kind - The only acceptable next response.
   * @param timeoutMs - Deadline; expiry destroys the channel.
   */
  private awaitResponse(kind: AuthorityMessage['kind'], timeoutMs: number = RESPONSE_DEADLINE_MS): Promise<AuthorityMessage> {
    if (this.closed || this.pending !== undefined) return Promise.reject(new Fd199AuthorityError())
    return new Promise<AuthorityMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined
        this.destroy()
        reject(new Fd199AuthorityError())
      }, timeoutMs)
      this.pending = { kind, resolve, reject, timer }
    })
  }

  /**
   * Writes one validated frame or destroys the channel trying.
   * @param message - Validated client message.
   * @returns whether the frame entered the socket.
   */
  private sendOrDestroy(message: ClientMessage): boolean {
    if (this.closed) return false
    try {
      this.channel.write(Buffer.from(frameBytes(encodeClientFrame(message))))
      return true
    } catch {
      this.destroy()
      return false
    }
  }

  /** Consumes complete frames from the buffered stream and dispatches them strictly. */
  private receive(chunk: Buffer): void {
    if (this.closed) return
    if (this.buffer.byteLength + chunk.byteLength > MAX_BUFFERED_BYTES) { this.destroy(); return }
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (this.buffer.byteLength >= 4) {
      // destroy() can fire between frames; every iteration rechecks liveness.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- destroy() assigns closed through peer-event callbacks this analysis cannot see.
      if (this.closed) return
      const bodyLength = this.buffer.readUInt32BE(0)
      if (bodyLength <= 2 || bodyLength > REMOTE_HOST_FD199_MAX_BODY_BYTES) { this.destroy(); return }
      if (this.buffer.byteLength < 4 + bodyLength) return
      const body = this.buffer.subarray(4, 4 + bodyLength)
      this.buffer = this.buffer.subarray(4 + bodyLength)
      let message: AuthorityMessage
      try {
        message = decodeFrame('authority', body) as AuthorityMessage
      } catch {
        this.destroy()
        return
      }
      // A peer frame can arrive inside the same synchronous block that later
      // registers its continuation (duplex writes flush synchronously).
      // Frames therefore queue here and dispatch one per microtask, so each
      // resolution interleaves with the caller registering the next wait.
      if (this.frameQueue.length >= MAX_QUEUED_FRAMES) { this.destroy(); return }
      this.frameQueue.push(message)
      if (!this.pumpScheduled) {
        this.pumpScheduled = true
        queueMicrotask(() => { this.pumpFrames() })
      }
    }
  }

  /** Dispatches exactly one queued frame per microtask turn. */
  private pumpFrames(): void {
    this.pumpScheduled = false
    if (this.closed) return
    const message = this.frameQueue.shift()
    if (message === undefined) return
    this.dispatch(message)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispatch() can destroy the channel through a failed instruction.
    if (this.closed || this.frameQueue.length === 0) return
    this.pumpScheduled = true
    queueMicrotask(() => { this.pumpFrames() })
  }

  /** Routes one validated authority frame to its exclusive consumer. */
  private dispatch(message: AuthorityMessage): void {
    if (message.kind === 'instruct') {
      // Instructions are illegal inside a transaction window: the authority
      // owns that window and cannot concurrently command the next step.
      if (this.inTransaction) { this.destroy(); return }
      const handler = this.instructionHandler
      if (handler === undefined) {
        // Buffer pre-wiring instructions; the application registers its
        // handler during startup before it can act on them.
        if (this.instructionQueue.length >= 2) { this.destroy(); return }
        this.instructionQueue.push(message.action)
        return
      }
      handler(message.action)
      return
    }
    const pending = this.pending
    if (pending === undefined || message.kind !== pending.kind) {
      this.destroy()
      return
    }
    clearTimeout(pending.timer)
    this.pending = undefined
    pending.resolve(message)
  }

  /** Tears the channel down and fails every pending caller closed. */
  private destroy(): void {
    if (this.closed) return
    this.closed = true
    this.channel.destroy()
    const pending = this.pending
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.pending = undefined
      pending.reject(new Fd199AuthorityError())
    }
  }
}

/**
 * Verifies one export file against the shared grammar before its bytes may
 * leave the process: lowercase hex digest equality over the exact bytes.
 * @param file - Candidate export file produced by the Web-owner adapter.
 */
function assertVerifiedExport(file: Fd199ExportFile): void {
  const digest = createHash('sha256').update(file.bytes).digest('hex')
  if (digest !== file.sha256) throw new Fd199AuthorityError()
}

/** @param bytes - Exact export-file bytes. @returns unpadded base64url text. */
function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url')
}
