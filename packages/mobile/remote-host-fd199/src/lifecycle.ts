/**
 * Opt-in write fence around desktop dispatch while a configured DSH Web graph
 * enters FD199. The API gateway resolves the fence lazily per operation, so
 * compositions without the hosted startup service keep their exact existing
 * behavior.
 * @module @deepseek-ai/dsh-remote-host-fd199/lifecycle
 */

import type { Fd199DesktopWriteFence, Fd199ExportFile, Fd199SameStoreTransition } from './types.ts'

/** Fail-closed lifecycle error. Once the fence starts closing, desktop work never resumes on its own. */
export class CurrentWebFd199LifecycleError extends Error {
  constructor() {
    super('the current Web FD199 lifecycle is unavailable or closed')
    this.name = 'CurrentWebFd199LifecycleError'
  }
}

/**
 * Serializes the single configured-Web-owner transition. In-flight desktop
 * work is drained before native receives the release callback; later desktop
 * work fails closed, preventing simultaneous store writers. After the native
 * activation consumes, exactly one explicit hosted-service admission reopens
 * dispatch; no other path leaves a closed state.
 */
export class CurrentWebFd199Lifecycle implements Fd199DesktopWriteFence {
  private state: 'desktop' | 'quiescing' | 'released' | 'hosted'
  private active = 0
  private drained: (() => void) | undefined
  private transition: Promise<void> | undefined

  /** @param initialState - `released` starts the fence closed for a hosted child recovering an interrupted journal. */
  constructor(initialState: 'desktop' | 'released' = 'desktop') {
    this.state = initialState
  }

  /** Runs one complete desktop carrier/API operation while the graph is desktop-owned or hosted. */
  async runDesktopOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== 'desktop' && this.state !== 'hosted') throw new CurrentWebFd199LifecycleError()
    this.active += 1
    try {
      return await operation()
    } finally {
      this.active -= 1
      if (this.active === 0) this.drained?.()
    }
  }

  /**
   * Starts the one-way quiesce, durable native same-store prepare, and release.
   * @param exportStoppedState - Exports the files after all desktop operations drain.
   * @param native - Native same-store transition authority receiving the stopped state.
   */
  releaseForNative(
    exportStoppedState: () => Promise<readonly Fd199ExportFile[]>,
    native: Fd199SameStoreTransition,
  ): Promise<void> {
    if (this.transition !== undefined) return this.transition
    this.transition = this.release(exportStoppedState, native)
    return this.transition
  }

  /**
   * Reopens desktop dispatch after the native authority consumed its signed
   * activation. Only the hosted startup plugin may call it, only after that
   * consume succeeded, and only once.
   * @throws {CurrentWebFd199LifecycleError} when the fence never closed or already reopened.
   */
  admitHostedService(): void {
    if (this.state !== 'released') throw new CurrentWebFd199LifecycleError()
    if (this.active !== 0) throw new CurrentWebFd199LifecycleError()
    this.drained = undefined
    this.transition = undefined
    this.state = 'hosted'
  }

  private async release(
    exportStoppedState: () => Promise<readonly Fd199ExportFile[]>,
    native: Fd199SameStoreTransition,
  ): Promise<void> {
    try {
      // A later handoff generation may start again from the hosted state.
      if (this.state !== 'desktop' && this.state !== 'hosted') throw new CurrentWebFd199LifecycleError()
      // The transition kind is the plugin's own construction fact; the static
      // type owns it at this typed same-process boundary.
      this.state = 'quiescing'
      if (this.active !== 0) await new Promise<void>((resolve) => { this.drained = resolve })
      const files = await exportStoppedState()
      await native.prepareReleasedStore({ files })
      this.state = 'released'
    } catch {
      // A failed native transition is ambiguous about store release. Retain the
      // closed write fence so a caller cannot resume concurrent ownership.
      this.state = 'released'
      throw new CurrentWebFd199LifecycleError()
    } finally {
      this.drained = undefined
    }
  }
}
