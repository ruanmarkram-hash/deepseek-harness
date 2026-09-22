import Foundation
import RemoteHostRelay
import RemoteHostWire

/** One activation's durable acknowledgment gate. It never admits a connection on timeout or cancellation. */
final class HostedChildEpochSynchronization: @unchecked Sendable {
  private let condition = NSCondition()
  private var receipt: RemoteWireRecord?
  private var stopped = false
  private var requested = false

  func receive(_ record: RemoteWireRecord) {
    condition.lock()
    defer { condition.unlock() }
    guard requested else { stopped = true; condition.broadcast(); return }
    guard !stopped, receipt == nil else { return }
    receipt = record
    condition.broadcast()
  }

  func stop() {
    condition.lock()
    stopped = true
    condition.broadcast()
    condition.unlock()
  }

  /** Send only after native finalization, then invoke open only after the exact durable receipt. */
  func synchronizeThenOpen(
    request: RemoteWireRecord, timeout: TimeInterval = 5,
    send: (RemoteWireRecord) throws -> Void, open: () throws -> Void
  ) throws {
    condition.lock()
    guard !stopped, !requested else { condition.unlock(); throw RelayOwnerError.invalidState }
    requested = true
    condition.unlock()
    try send(request)
    let deadline = Date().addingTimeInterval(timeout)
    condition.lock()
    while receipt == nil && !stopped {
      if !condition.wait(until: deadline) { break }
    }
    let received = receipt
    // Stop and the final admission are serialized. Once stop returns, a
    // later connection-open effect cannot escape this one-shot operation.
    defer { condition.unlock() }
    guard !stopped, let received else { throw RelayOwnerError.unavailable }
    try RelayFinalizedEpochWire.validate(received, expected: request)
    try open()
  }
}
