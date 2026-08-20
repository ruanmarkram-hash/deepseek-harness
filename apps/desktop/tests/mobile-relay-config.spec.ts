import { describe, expect, it } from 'vitest'
import { desktopPairingRelayUrls } from '../src/mobile-pairing.ts'
import { trustedDesktopRelayOrigin } from '../src/mobile-relay-config.ts'

describe('trustedDesktopRelayOrigin', () => {
  it('is a compiled HTTPS origin, independent of Finder launch environment', () => {
    const previous = process.env.DSH_MOBILE_RELAY_ORIGIN
    process.env.DSH_MOBILE_RELAY_ORIGIN = 'https://untrusted.example/'
    try {
      const origin = trustedDesktopRelayOrigin()
      expect(origin).not.toBe(process.env.DSH_MOBILE_RELAY_ORIGIN)
      expect(desktopPairingRelayUrls(origin).qrRelayUrl).toMatch(/^wss:\/\//u)
    } finally {
      if (previous === undefined) delete process.env.DSH_MOBILE_RELAY_ORIGIN
      else process.env.DSH_MOBILE_RELAY_ORIGIN = previous
    }
  })
})
