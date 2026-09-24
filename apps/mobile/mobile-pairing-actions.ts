/** Synchronous guards for camera callbacks and explicit pairing submissions. */
import { AnywherePairingError, parseAnywherePairingCode } from './anywhere-pairing'

/** One scan capture and one pending submission per pairing sheet. */
export class MobilePairingActions {
  private scanning = false
  private submitting = false

  /** Arm a fresh scan only when no pairing submission is pending.
   * @returns Whether camera callbacks can be accepted.
   */
  beginScan(): boolean {
    if (this.submitting) return false
    this.scanning = true
    return true
  }

  /** Stop accepting camera callbacks after leaving the scanner. */
  endScan(): void { this.scanning = false }

  /** Capture a valid code once; scanning never submits an enrollment offer.
   * @param value Untrusted QR text from the camera.
   * @returns The complete validated code, or undefined for an inactive scanner.
   */
  scanCode(value: string): string | undefined {
    if (!this.scanning || this.submitting) return undefined
    this.scanning = false
    parseAnywherePairingCode(value)
    return value.trim()
  }

  /** Run an explicit submission once, including callbacks before React renders.
   * @param action The user-confirmed submission, including its UI updates.
   * @returns Completion of this submission; concurrent calls return immediately.
   */
  async submit(action: () => Promise<void>): Promise<void> {
    if (this.submitting) return
    this.submitting = true
    this.endScan()
    try { await action() } finally { this.submitting = false }
  }
}

/** Present only locally defined errors, never arbitrary relay response bodies.
 * @param cause The failed pairing or invitation import.
 * @returns A safe explanation for the pairing sheet.
 */
export function pairingError(cause: unknown): string {
  if (cause instanceof AnywherePairingError) return cause.message
  const message = cause instanceof Error ? cause.message : ''
  if (message.includes('expired')) return 'This Host invitation has expired. Generate a new one from the Host.'
  if (message.includes('different protected mobile identity')) return 'This invitation belongs to a different protected phone identity.'
  if (message.includes('Expo Go')) return 'Use a signed DSH Mobile development or production build. Expo Go cannot pair this phone.'
  if (message.includes('label')) return 'Choose a visible device label between 1 and 64 characters.'
  return 'The Host invitation is invalid or incomplete. It has not been retained.'
}
