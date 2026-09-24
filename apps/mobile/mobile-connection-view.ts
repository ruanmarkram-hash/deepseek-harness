/** Shared connection action state for the pairing and connection sheets. */
import type { MobileRemoteDisconnectNotice, MobileRemoteState } from './remote'

/** Volatile presentation only, separate from disconnected transport state and durable pairing. */
export interface MobileConnectionNotice {
  readonly failure: string | undefined
  readonly interruption: MobileRemoteDisconnectNotice | undefined
}

/** Inputs to the in-memory connection notice; no credentials or frames enter this projection. */
export type MobileConnectionNoticeEvent =
  | { readonly kind: 'state'; readonly state: MobileRemoteState }
  | { readonly kind: 'disconnect'; readonly notice: MobileRemoteDisconnectNotice }
  | { readonly kind: 'clear' }

/** Process-local notice owner. A replaced screen cannot overwrite its successor's notice. */
export class MobileConnectionNotices {
  private owner: object | undefined
  private value: MobileConnectionNotice | undefined

  /** Read presentation only; this contains no connection authority. */
  get current(): MobileConnectionNotice | undefined { return this.value }

  /**
   * Claim notice updates for the current screen.
   * @returns A lease whose updates become inert after release or replacement.
   */
  claim(): { update: (event: MobileConnectionNoticeEvent) => void; release: () => void } {
    const owner = {}
    this.owner = owner
    return {
      update: (event) => { if (this.owner === owner) this.value = reduceMobileConnectionNotice(this.value, event) },
      release: () => { if (this.owner === owner) this.owner = undefined },
    }
  }
}

/**
 * Preserve safe failure text across teardown, without retaining connection authority.
 * @param previous - Last in-memory notice.
 * @param event - Fixed local lifecycle facts or already-sanitized client state.
 * @returns Presentation cleared by an explicit attempt, successful connection or explicit reset.
 */
export function reduceMobileConnectionNotice(
  previous: MobileConnectionNotice | undefined,
  event: MobileConnectionNoticeEvent,
): MobileConnectionNotice | undefined {
  if (event.kind === 'clear') return undefined
  if (event.kind === 'disconnect') return {
    failure: previous?.failure,
    interruption: event.notice.stage === undefined ? previous?.interruption ?? event.notice : event.notice,
  }
  if (event.state.kind === 'connecting' || event.state.kind === 'connected') return undefined
  if (event.state.kind === 'error') return { failure: event.state.message, interruption: undefined }
  return previous
}

function disconnectMessage(notice: MobileConnectionNotice | undefined): string | undefined {
  const interruption = notice?.interruption
  if (interruption === undefined) return notice?.failure
  const reasons = {
    background: 'The app reported background. The connection and authentication were cleared.',
    unmount: 'The app screen was unloaded. The connection and authentication were cleared.',
    manual: 'The connection was explicitly closed.',
  }
  const stage = interruption.stage === undefined ? '' : ` Interrupted at ${interruption.stage}.`
  return [notice?.failure, reasons[interruption.reason] + stage + ' Connect again to authenticate.'].filter(Boolean).join(' ')
}

/** Projects only user-safe connection status; never route credentials or native errors. */
export function mobileConnectionView(
  state: MobileRemoteState,
  notice?: MobileConnectionNotice,
): { readonly disabled: boolean; readonly label: string; readonly message: string | undefined } {
  switch (state.kind) {
    case 'connecting': return { disabled: true, label: 'Connecting…', message: 'Authenticating and loading the Host workspace…' }
    case 'connected': return { disabled: true, label: 'Host connected', message: 'The live Host workspace is ready.' }
    case 'error': return { disabled: false, label: 'Retry connection', message: state.message }
    case 'reconnecting': return { disabled: false, label: 'Retry connection', message: 'The Host connection closed. You can retry.' }
    case 're-pair-required': return { disabled: false, label: 'Manage pairing', message: 'The stored invitation needs to be checked before connecting.' }
    case 'revoked': return { disabled: true, label: 'Device revoked', message: 'The Host revoked this phone. Pair again from the Host.' }
    case 'unconfigured':
    case 'disconnected': return { disabled: false, label: 'Connect to Host', message: disconnectMessage(notice) }
  }
}
