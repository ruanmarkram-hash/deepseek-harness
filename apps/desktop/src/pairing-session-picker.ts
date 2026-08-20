import type { LocalDesktopSession } from './local-session-api.js'

/** The only local-session listing surface available to the pairing picker. */
export interface PairingSessionSource {
  listSelectableSessions(): Promise<readonly LocalDesktopSession[]>
}

/** Opaque aliases are valid only for the exact native picker that created them. */
export class PairingSessionPicker {
  private generation = 0
  private currentWindow: object | undefined
  private currentTransport: PairingSessionSource | undefined
  private readonly sessions = new Map<string, LocalDesktopSession>()

  /** Activate a new native-picker/transport generation and revoke old aliases. */
  open(window: object, transport: PairingSessionSource): void {
    this.generation += 1
    this.currentWindow = window
    this.currentTransport = transport
    this.sessions.clear()
  }

  /** Revoke aliases when the native picker closes or its runtime is replaced. */
  close(window?: object): void {
    if (window !== undefined && this.currentWindow !== window) return
    this.generation += 1
    this.currentWindow = undefined
    this.currentTransport = undefined
    this.sessions.clear()
  }

  /** List local sessions only if the same picker generation survives the await. */
  async list(
    window: object,
    transport: PairingSessionSource,
    createId: () => string,
  ): Promise<readonly { readonly id: string; readonly label: string }[]> {
    if (!this.matches(window, transport)) throw new Error('DSH Desktop pairing is unavailable.')
    const generation = this.generation
    this.sessions.clear()
    const sessions = await transport.listSelectableSessions()
    if (!this.matches(window, transport) || this.generation !== generation) {
      throw new Error('DSH Desktop pairing is unavailable.')
    }
    return sessions.map((session, index) => {
      const id = createId()
      this.sessions.set(id, session)
      return { id, label: `Desktop session ${String(index + 1)}` }
    })
  }

  /** Consume an alias only when it belongs to the current picker generation. */
  take(window: object, transport: PairingSessionSource, id: unknown): LocalDesktopSession | undefined {
    if (typeof id !== 'string' || !this.matches(window, transport)) return undefined
    const session = this.sessions.get(id)
    this.sessions.clear()
    return session
  }

  private matches(window: object, transport: PairingSessionSource): boolean {
    return this.currentWindow === window && this.currentTransport === transport
  }
}
