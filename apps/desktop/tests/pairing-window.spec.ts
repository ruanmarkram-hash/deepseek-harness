import { describe, expect, it } from 'vitest'
import { trustedPairingNavigation } from '../src/pairing-window.ts'

describe('trustedPairingNavigation', () => {
  it('allows only the exact isolated pairing document', () => {
    const pairingUrl = 'data:text/html;charset=utf-8,%3Cmain%3EDSHPairing%3C%2Fmain%3E'

    expect(trustedPairingNavigation(pairingUrl, pairingUrl)).toBe(true)
    expect(trustedPairingNavigation('data:text/html,other', pairingUrl)).toBe(false)
    expect(trustedPairingNavigation('https://example.test/', pairingUrl)).toBe(false)
  })
})
