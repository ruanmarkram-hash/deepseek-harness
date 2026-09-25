/** Safe failures for trusted remote relay transport. @module @deepseek-ai/dsh-remote-relay-protocol/error */

import type { RemoteRelayProtocolErrorCode } from './types.ts'

/** Error carrying a fixed remote relay rejection code and no untrusted data. */
export class RemoteRelayProtocolError extends Error {
  override name = 'RemoteRelayProtocolError'
  /** Stable reason for rejecting a transport message or lifecycle call. */
  readonly code: RemoteRelayProtocolErrorCode

  /** @param code - stable reason for rejecting a transport message or lifecycle call. */
  constructor(code: RemoteRelayProtocolErrorCode) {
    super(code)
    this.code = code
  }
}

/**
 * Checks whether a thrown value is a remote relay protocol failure.
 * @param value - unknown thrown value.
 * @returns whether the value is a remote relay protocol failure.
 */
export function isRemoteRelayProtocolError(value: unknown): value is RemoteRelayProtocolError {
  return value instanceof RemoteRelayProtocolError
}
