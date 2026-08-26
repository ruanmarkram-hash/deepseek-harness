/** Closed errors for Host V3 composition. @module @deepseek-ai/dsh-remote-host-v3/error */

/** Stable Host V3 composition failures. */
export type RemoteHostV3ErrorCode =
  | 'REMOTE_HOST_V3_DISABLED'
  | 'REMOTE_HOST_V3_HELPER_UNAVAILABLE'
  | 'REMOTE_HOST_V3_HELPER_MISMATCH'
  | 'REMOTE_HOST_V3_ROUTE_INVALID'
  | 'REMOTE_HOST_V3_ROUTE_EXISTS'
  | 'REMOTE_HOST_V3_ROUTE_UNAVAILABLE'
  | 'REMOTE_HOST_V3_EPOCH_PENDING'
  | 'REMOTE_HOST_V3_EPOCH_INVALID'
  | 'REMOTE_HOST_V3_WIRE_MALFORMED'
  | 'REMOTE_HOST_V3_WIRE_OUT_OF_ORDER'
  | 'REMOTE_HOST_V3_WIRE_CLOSED'
  | 'REMOTE_HOST_V3_WIRE_OVERFLOW'
  | 'REMOTE_HOST_V3_WIRE_WRITE_FAILED'

/** Error with a non-sensitive Host V3 composition code. */
export class RemoteHostV3Error extends Error {
  /** @param code - Stable non-sensitive reason code. @param message - Operator-facing failure summary. */
  constructor(readonly code: RemoteHostV3ErrorCode, message: string) {
    super(message)
    this.name = 'RemoteHostV3Error'
  }
}

/**
 * Checks whether a thrown value is a Host V3 composition error.
 * @param value - Unknown thrown value.
 * @returns whether it is a Host V3 composition error.
 */
export function isRemoteHostV3Error(value: unknown): value is RemoteHostV3Error {
  return value instanceof RemoteHostV3Error
}
