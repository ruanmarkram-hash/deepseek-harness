/** Safe parser errors for trusted remote-client v3 envelopes. @module @deepseek-ai/dsh-remote-wire/error */

import type { RemoteWireErrorCode } from './types.ts'

/** Error that identifies a remote-wire parse failure without echoing untrusted input. */
export class RemoteWireError extends Error {
  override name = 'RemoteWireError'
  /** Stable rejection reason without untrusted input. */
  readonly code: RemoteWireErrorCode

  /** @param code - Stable, non-sensitive reason for rejection. */
  constructor(code: RemoteWireErrorCode) {
    super(code)
    this.code = code
  }
}

/**
 * Determine whether an unknown thrown value is a remote-wire parse failure.
 * @param value - unknown value caught at a remote-wire boundary.
 * @returns whether `value` is a stable remote-wire parser error.
 */
export function isRemoteWireError(value: unknown): value is RemoteWireError {
  return value instanceof RemoteWireError
}
