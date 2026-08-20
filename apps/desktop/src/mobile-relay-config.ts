import { desktopPairingRelayUrls } from './mobile-pairing.js'

/**
 * The compiled, production relay origin. It is public routing metadata, not a
 * credential, and is never configurable by a renderer, QR payload, mobile
 * client, Finder launch environment, or user preference.
 */
const TRUSTED_DESKTOP_RELAY_ORIGIN = 'https://dsh-mobile-relay.sonke-referrals.workers.dev/'

/** Return the one relay origin trusted by this packaged desktop build. */
export function trustedDesktopRelayOrigin(): string {
  // Validate at startup too, so an accidental source/config edit fails closed.
  desktopPairingRelayUrls(TRUSTED_DESKTOP_RELAY_ORIGIN)
  return TRUSTED_DESKTOP_RELAY_ORIGIN
}
