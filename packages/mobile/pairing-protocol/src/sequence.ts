/** Internal bounded counter for encrypted session frames. @module */
import { PairingProtocolError } from './error.ts'

/** Advance a cipher-owned counter without permitting sequence exhaustion. */
export function nextSessionSequence(previous: number): number {
  if (previous >= 2_147_483_647) throw new PairingProtocolError('MOBILE_SESSION_FRAME_INVALID')
  return previous + 1
}
