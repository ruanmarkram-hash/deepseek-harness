/** Closed errors for macOS Keychain-backed Host identity operations. @module @deepseek-ai/dsh-remote-host-identity/error */

import type { RemoteHostIdentityErrorCode } from './types.ts'

/** Failure that never includes a private key or Keychain credential. */
export class RemoteHostIdentityError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: RemoteHostIdentityErrorCode

  /**
   * @param code - Stable identity failure code.
   * @param message - Fixed safe diagnostic.
   */
  constructor(code: RemoteHostIdentityErrorCode, message: string) {
    super(message)
    this.name = 'RemoteHostIdentityError'
    this.code = code
  }
}

/**
 * Whether an unknown value is an identity failure from this package.
 * @param value - Value to inspect.
 * @returns whether the value was created by this package.
 */
export function isRemoteHostIdentityError(value: unknown): value is RemoteHostIdentityError {
  return value instanceof RemoteHostIdentityError
}
