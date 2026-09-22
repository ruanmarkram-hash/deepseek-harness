/** Explicit user-initiated connection selection for the mobile Host UI. */

import type { NativeMobileRemoteStateStore } from './mobile-remote-state'
import type { MobileRemoteClient, MobileRemoteState } from './remote'

const pendingActions = new WeakSet<MobileRemoteClient>()

/**
 * Open or retry only after a user action. Missing durable pairing state returns
 * the caller to local pairing rather than constructing a route or socket.
 *
 * @param client - The one mobile remote client.
 * @param remoteState - Its currently rendered state.
 * @param stateStore - Native Keychain invitation and epoch state.
 * @param openPairing - Opens the local pairing UI when no invitation exists.
 */
export async function connectStoredHost(
  client: MobileRemoteClient,
  remoteState: MobileRemoteState,
  stateStore: NativeMobileRemoteStateStore,
  openPairing: () => void,
): Promise<void> {
  if (pendingActions.has(client) || remoteState.kind === 'connected' || remoteState.kind === 'connecting') return
  pendingActions.add(client)
  try {
    const stored = await stateStore.restore()
    if (stored === undefined || remoteState.kind === 're-pair-required') {
      openPairing()
      return
    }
    if (remoteState.kind === 'reconnecting' || remoteState.kind === 'error') {
      await client.reconnect()
      return
    }
    await client.connect(stored.config)
  } finally {
    pendingActions.delete(client)
  }
}
