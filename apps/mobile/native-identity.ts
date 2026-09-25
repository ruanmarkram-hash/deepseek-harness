/** Expo runtime loader for the signed local identity module. */

import { requireOptionalNativeModule } from 'expo-modules-core'
import { createNativeMobileIdentityProvider, type DshDeviceIdentityNativeModule } from './enrollment'
import { NativeMobileRemoteStateStore, type DshMobileRemoteStateNativeModule } from './mobile-remote-state'

/**
 * Mobile builds use the iOS-native module. Expo Go has no linked local module
 * and therefore receives the fail-closed provider from `enrollment.ts`.
 */
export const nativeMobileIdentityProvider = createNativeMobileIdentityProvider(
  requireOptionalNativeModule<DshDeviceIdentityNativeModule>('DshDeviceIdentity'),
)

/** Signed native Keychain storage for the accepted Host invitation, epoch, and event cursor. */
export const nativeMobileRemoteStateStore = new NativeMobileRemoteStateStore(
  requireOptionalNativeModule<DshMobileRemoteStateNativeModule>('DshDeviceIdentity'),
)
