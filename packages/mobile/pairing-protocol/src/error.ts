/** Safe parser and sequencing errors for mobile pairing. @module @deepseek-ai/dsh-pairing-protocol/error */

import type { PairingProtocolErrorCode } from './types.ts'

/** Error that identifies a pairing-protocol failure without echoing untrusted input. */
export class PairingProtocolError extends Error {
  override name = 'PairingProtocolError'

  /** @param code - Stable, non-sensitive reason for rejecting a pairing message. */
  constructor(readonly code: PairingProtocolErrorCode) {
    super()
    this.message = code
  }
}

/**
 * Determine whether an unknown thrown value is a pairing-protocol failure.
 *
 * @param value - Value to classify.
 * @returns Whether `value` is a pairing protocol failure.
 */
export function isPairingProtocolError(value: unknown): value is PairingProtocolError {
  return value instanceof PairingProtocolError
}
