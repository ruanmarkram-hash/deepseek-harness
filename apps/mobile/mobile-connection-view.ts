/** Shared connection action state for the pairing and connection sheets. */
import type { MobileRemoteState } from './remote'

/** Projects only user-safe connection status; never route credentials or native errors. */
export function mobileConnectionView(
  state: MobileRemoteState,
): { readonly disabled: boolean; readonly label: string; readonly message: string | undefined } {
  switch (state.kind) {
    case 'connecting': return { disabled: true, label: 'Connecting…', message: 'Authenticating and loading the Host workspace…' }
    case 'connected': return { disabled: true, label: 'Host connected', message: 'The live Host workspace is ready.' }
    case 'error': return { disabled: false, label: 'Retry connection', message: state.message }
    case 'reconnecting': return { disabled: false, label: 'Retry connection', message: 'The Host connection closed. You can retry.' }
    case 're-pair-required': return { disabled: false, label: 'Manage pairing', message: 'The stored invitation needs to be checked before connecting.' }
    case 'revoked': return { disabled: true, label: 'Device revoked', message: 'The Host revoked this phone. Pair again from the Host.' }
    case 'unconfigured':
    case 'disconnected': return { disabled: false, label: 'Connect to Host', message: undefined }
  }
}
