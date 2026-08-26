import Foundation
import Testing
@testable import RemoteHostApp
@testable import RemoteHostFd199
@testable import RemoteHostWire

private actor FrameSink {
  private var values: [Data] = []
  func append(_ value: Data) { values.append(value) }
  func snapshot() -> [Data] { values }
}

private final class FailureFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  func mark() { lock.lock(); value = true; lock.unlock() }
  func isMarked() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
}

private func eventually(_ condition: @escaping @Sendable () async -> Bool) async -> Bool {
  for _ in 0..<100 {
    if await condition() { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return false
}

@Test("hosted frame pump preserves direct phone and child JSON bytes in FIFO order")
func hostedFramePumpPreservesDirectJSONAndFIFO() async throws {
  let metadata = Data(#"{"connectionId":"conn-1"}"#.utf8)
  let one = Data(#"{"type":"request","id":1}"#.utf8)
  let two = Data(#"{"type":"request","id":2}"#.utf8)
  let sink = FrameSink()
  let pump = HostedRelayFramePump(
    sendToPhone: { payload in await sink.append(payload) },
    failed: { Issue.record("unexpected frame pump failure") }
  )
  try pump.install(metadata: metadata)

  let phone = try pump.phonePlaintext(one)
  #expect(phone.metadata == metadata)
  #expect(phone.payload == one)

  pump.childPlaintext(metadata: metadata, payload: one)
  pump.childPlaintext(metadata: metadata, payload: two)
  #expect(await eventually { await sink.snapshot().count == 2 })
  #expect(await sink.snapshot() == [one, two])
}

@Test("hosted frame pump rejects malformed phone JSON and non-current child metadata")
func hostedFramePumpFailsClosedOnMalformedOrSubstitutedFrames() throws {
  let metadata = Data(#"{"connectionId":"conn-1"}"#.utf8)
  let wrongMetadata = Data(#"{"connectionId":"conn-2"}"#.utf8)
  let failure = FailureFlag()
  let pump = HostedRelayFramePump(
    sendToPhone: { _ in },
    failed: { failure.mark() }
  )
  try pump.install(metadata: metadata)
  #expect(throws: Fd199BridgeError.invalidPhoneRecord) { try pump.phonePlaintext(Data("not-json".utf8)) }
  pump.childPlaintext(metadata: wrongMetadata, payload: Data(#"{"ok":true}"#.utf8))
  #expect(failure.isMarked())
}
