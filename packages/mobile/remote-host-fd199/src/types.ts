/** Signed-Host FD199 ownership-handoff types. @module @deepseek-ai/dsh-remote-host-fd199/types */

/** The only FD199 protocol version this client speaks. */
export type Fd199ProtocolVersion = 2

/**
 * One complete logical artifact streamed while its owner remains stopped.
 * Chunk boundaries have no meaning in the canonical logical file.
 */
export interface Fd199ExportFile {
  /** Repository-relative artifact name validated against the shared FD199 grammar. */
  readonly name: string
  /** Ordered nonempty chunks of the exact file bytes, consumed once. */
  readonly bytes: AsyncIterable<Uint8Array>
}

/** Durable ownership facts the native journal reports after native revalidation. */
export interface Fd199OwnershipSnapshot {
  /** Export/release records are unactivatable until the native supervisor reaps the former owner into prepared. */
  readonly status: 'none' | 'exported' | 'releasing' | 'prepared' | 'activated'
  /** Native-owned ownership generation; monotonic across activated transitions. */
  readonly generation: number
}

/** Facts announced by the signed Host authority after the kernel-private handshake. */
export interface Fd199AuthorityFacts {
  /** The only protocol version the authority proved it speaks. */
  readonly protocolVersion: Fd199ProtocolVersion
  /** Absolute path of the signed Host application that spawned this runtime child. */
  readonly hostAppPath: string
}

/**
 * One desktop API dispatch while the Web graph is desktop-owned or hosted.
 * Adopted by the API gateway so the handoff fence closes desktop work without
 * touching any carrier implementation.
 */
export interface Fd199DesktopWriteFence {
  /** Runs one complete desktop carrier/API operation under the current fence state. */
  runDesktopOperation<T>(operation: () => Promise<T>): Promise<T>
}

/**
 * The configured Web-graph operations the handoff needs. Implemented over the
 * live session store; the fence drains active desktop work before either runs.
 */
export interface Fd199WebOwner {
  /** Produces the complete immutable export while the graph still owns the store. */
  exportStoppedState(signal: AbortSignal): AsyncIterable<Fd199ExportFile>
}

/**
 * The atomic streaming same-store transition the native authority performs.
 * Legacy test-only GatewayRuntime array capabilities are separate contracts.
 */
export interface Fd199SameStoreTransition {
  readonly kind: 'native-attested-fd199-same-store-transition-v2'
  prepareReleasedStore(input: Readonly<{
    exportStoppedState: (signal: AbortSignal) => AsyncIterable<Fd199ExportFile>
  }>): Promise<void>
}

/** Live FD199 client handed to the hosted startup plugin. */
export interface Fd199AuthorityClient extends Fd199SameStoreTransition {
  /** Completes the kernel-private handshake; rejects if the authority is not a protocol peer. */
  connect(): Promise<Fd199AuthorityFacts>
  /** Recovers the native journal snapshot after native proof revalidation. */
  recoverSnapshot(): Promise<Fd199OwnershipSnapshot>
  desktopReady(): Promise<void>
  /** Requests the native activation consume; the authority applies its explicit local gate first. */
  activate(): Promise<Fd199OwnershipSnapshot>
  /** Registers the single instruction callback; a second registration replaces the first. */
  onInstruction(handler: (action: Fd199InstructionAction) => void): void
  /** Closes the descriptor; further calls reject. */
  close(): Promise<void>
}

/** Authority-initiated lifecycle instructions. */
export type Fd199InstructionAction = 'prepare' | 'activate'
