/** Closed errors from trusted remote Host gateway lifecycle operations. @module @deepseek-ai/dsh-remote-gateway/error */

/** Gateway failures that must not echo relay input or Host secrets. */
export class RemoteGatewayError extends Error {
  /** @param code - Stable machine-readable gateway failure code. */
  constructor(readonly code: 'REMOTE_GATEWAY_PROTOCOL' | 'REMOTE_GATEWAY_STALE_ROUTE' | 'REMOTE_GATEWAY_UNAUTHORIZED', message: string) {
    super(message)
    this.name = 'RemoteGatewayError'
  }
}

/** @param value - Unknown caught value.
 * @returns whether the value is a gateway lifecycle error.
 */
export function isRemoteGatewayError(value: unknown): value is RemoteGatewayError {
  return value instanceof RemoteGatewayError
}
