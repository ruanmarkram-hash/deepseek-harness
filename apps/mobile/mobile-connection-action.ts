/** Explicit user-initiated connection selection for the mobile Host UI. */

import type { NativeMobileRemoteStateStore } from './mobile-remote-state'
import type { MobileRemoteClient, MobileRemoteState } from './remote'

const pendingActions = new WeakMap<MobileRemoteClient, { readonly signal: AbortSignal | undefined }>()

/**
 * Open or retry only after a user action. Missing durable pairing state returns
 * the caller to local pairing rather than constructing a route or socket.
 * A cancelled action permits an explicit replacement while native storage still serializes its reads.
 *
 * @param client - The one mobile remote client.
 * @param remoteState - Its currently rendered state.
 * @param stateStore - Native Keychain invitation and epoch state.
 * @param openPairing - Opens the local pairing UI when no invitation exists.
 * @param signal - Cancels a pending invitation read after backgrounding, unmount or Forget.
 */
export async function connectStoredHost(
  client: MobileRemoteClient,
  remoteState: MobileRemoteState,
  stateStore: NativeMobileRemoteStateStore,
  openPairing: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const previous = pendingActions.get(client)
  if (signal?.aborted || (previous !== undefined && !previous.signal?.aborted)
    || remoteState.kind === 'connected' || remoteState.kind === 'connecting') return
  const action = { signal }
  pendingActions.set(client, action)
  try {
    const stored = await stateStore.restore()
    if (signal?.aborted) return
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
    if (pendingActions.get(client) === action) pendingActions.delete(client)
  }
}
