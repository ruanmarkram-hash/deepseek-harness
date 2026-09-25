/** Closed errors for trusted remote device operations. @module @deepseek-ai/dsh-remote-devices/error */

import type { RemoteDeviceDirectoryErrorCode } from './types.ts'

/** Failure from a Host-owned remote-device directory operation. */
export class RemoteDeviceDirectoryError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: RemoteDeviceDirectoryErrorCode

  /**
   * @param code - Stable directory failure code.
   * @param message - Safe fixed diagnostic.
   */
  constructor(code: RemoteDeviceDirectoryErrorCode, message: string) {
    super(message)
    this.name = 'RemoteDeviceDirectoryError'
    this.code = code
  }
}

/**
 * Whether an unknown value is a remote-device directory error.
 * @param value - Value to inspect.
 * @returns whether `value` was created by this package.
 */
export function isRemoteDeviceDirectoryError(value: unknown): value is RemoteDeviceDirectoryError {
  return value instanceof RemoteDeviceDirectoryError
}
