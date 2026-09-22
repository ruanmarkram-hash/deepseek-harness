import Foundation
import RemoteHostFd199
import RemoteHostWire
import RemoteHostRelay

/**
 The narrow, testable boundary between the authenticated phone carrier and a
 hosted child connection. It deliberately transports the exact JSON payload
 bytes. Remote Wire is used only on the private child descriptor, never
 nested inside the encrypted phone carrier.
 */
final class HostedRelayFramePump: @unchecked Sendable {
  private let lock = NSLock()
  private let sendToPhone: @Sendable (Data) async throws -> Void
  private let failed: @Sendable () -> Void
  private var reference: RelayConnectionReference?
  private var stopped = false
  private var queue: [Data] = []
  private var queuedBytes = 0
  private var draining = false

  init(
    sendToPhone: @escaping @Sendable (Data) async throws -> Void,
    failed: @escaping @Sendable () -> Void
  ) {
    self.sendToPhone = sendToPhone
    self.failed = failed
  }

  func install(metadata: Data) throws {
    let reference = try RelayConnectionReference(openMetadata: metadata)
    lock.lock()
    defer { lock.unlock() }
    guard !stopped, self.reference == nil else { throw Fd199BridgeError.detached }
    self.reference = reference
  }

  func clear() {
    lock.lock()
    stopped = true
    reference = nil
    queue.removeAll(keepingCapacity: false)
    queuedBytes = 0
    lock.unlock()
  }

  func isCurrentClose(metadata candidate: Data) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return !stopped && reference?.matchesClose(candidate) == true
  }

  /// Returns the unchanged JSON bytes that must become `connection.frame`.
  func phonePlaintext(_ payload: Data) throws -> (metadata: Data, payload: Data) {
    lock.lock()
    defer { lock.unlock() }
    guard !stopped, payload.count <= RemoteWire.maximumRecordBytes,
          Self.isEnvelopeJSON(payload), let reference
    else { throw Fd199BridgeError.invalidPhoneRecord }
    return (reference.metadata, payload)
  }

  /// Enqueues unchanged child JSON on one bounded FIFO phone-carrier writer.
  func childPlaintext(metadata candidate: Data, payload: Data) {
    let startDrain: Bool
    lock.lock()
    guard !stopped, reference?.matchesSend(candidate) == true, Self.isEnvelopeJSON(payload),
          queue.count < 64, queuedBytes <= RemoteWire.maximumRecordBytes - payload.count
    else {
      lock.unlock()
      failed()
      return
    }
    queue.append(payload)
    queuedBytes += payload.count
    startDrain = !draining
    if startDrain { draining = true }
    lock.unlock()
    if startDrain { Task { [weak self] in await self?.drain() } }
  }

  private func drain() async {
    while let payload = next() {
      do {
        try await sendToPhone(payload)
      } catch {
        failed()
        return
      }
    }
  }

  private func next() -> Data? {
    lock.lock()
    defer { lock.unlock() }
    guard !stopped, !queue.isEmpty else {
      draining = false
      return nil
    }
    let payload = queue.removeFirst()
    queuedBytes -= payload.count
    return payload
  }

  private static func isEnvelopeJSON(_ payload: Data) -> Bool {
    guard !payload.isEmpty, String(data: payload, encoding: .utf8) != nil,
          let object = try? JSONSerialization.jsonObject(with: payload), object is [String: Any]
    else { return false }
    return true
  }
}
