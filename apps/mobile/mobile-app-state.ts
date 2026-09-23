import type { AppStateStatus } from 'react-native'

/**
 * Disconnects remote state only after the operating system backgrounds the app.
 * iOS reports `inactive` while system authentication UI covers the foreground app.
 * @param next - App state reported by React Native.
 * @param disconnect - Remote-client teardown owned by the app.
 */
export function disconnectRemoteWhenBackgrounded(next: AppStateStatus, disconnect: (reason: 'background') => void): void {
  if (next === 'background') disconnect('background')
}
