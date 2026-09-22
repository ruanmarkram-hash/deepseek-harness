import Foundation
import Darwin
import Testing
@testable import RemoteHostApp
@testable import RemoteHostFd199
@testable import RemoteHostWire

private let connectionId = "remote_connection0001"
private let referenceMetadata = Data(#"{"connectionId":"remote_connection0001"}"#.utf8)
private func openMetadata() throws -> Data {
  try JSONSerialization.data(withJSONObject: [
    "connectionId": connectionId, "deviceId": "remote_device_0001", "enrollmentId": "device_enrollment1",
    "signingPublicKey": Data(repeating: 1, count: 32).base64EncodedString().replacingOccurrences(of: "=", with: ""),
    "agreementPublicKey": Data(repeating: 2, count: 32).base64EncodedString().replacingOccurrences(of: "=", with: ""),
    "routeId": "remote_route_000001", "generation": 1, "connectionEpoch": 1,
  ], options: [.sortedKeys])
}

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
  let metadata = try openMetadata()
  let one = Data(#"{"type":"request","id":1}"#.utf8)
  let two = Data(#"{"type":"request","id":2}"#.utf8)
  let sink = FrameSink()
  let pump = HostedRelayFramePump(
    sendToPhone: { payload in await sink.append(payload) },
    failed: { Issue.record("unexpected frame pump failure") }
  )
  try pump.install(metadata: metadata)

  let phone = try pump.phonePlaintext(one)
  #expect(phone.metadata == referenceMetadata)
  #expect(phone.payload == one)

  pump.childPlaintext(metadata: referenceMetadata, payload: one)
  pump.childPlaintext(metadata: Data(#"{ "\u0063onnectionId" : "remote_connection0001" }"#.utf8), payload: two)
  #expect(await eventually { await sink.snapshot().count == 2 })
  #expect(await sink.snapshot() == [one, two])
}

@Test("hosted frame pump rejects malformed phone JSON and non-current child metadata")
func hostedFramePumpFailsClosedOnMalformedOrSubstitutedFrames() throws {
  let metadata = try openMetadata()
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

@Test("hosted frame pump rejects extra and duplicate send metadata and fences stale closes")
func hostedFramePumpStrictReferenceSchemas() throws {
  let invalidSends = [
    #"{"connectionId":"remote_connection0001","extra":true}"#,
    #"{"connectionId":"remote_connection0001","connectionId":"remote_connection0001"}"#,
    #"{"connectionId":"remote_connection0001","\u0063onnectionId":"remote_connection0001"}"#,
  ]
  for candidate in invalidSends {
    let failure = FailureFlag()
    let pump = HostedRelayFramePump(sendToPhone: { _ in }, failed: { failure.mark() })
    try pump.install(metadata: openMetadata())
    pump.childPlaintext(metadata: Data(candidate.utf8), payload: Data(#"{"ok":true}"#.utf8))
    #expect(failure.isMarked())
  }
  let pump = HostedRelayFramePump(sendToPhone: { _ in }, failed: {})
  try pump.install(metadata: openMetadata())
  for reason in ["gateway-disposed", "protocol-rejected", "unauthorized-device", "superseded", "transport-failed"] {
    let candidate = Data("{\"reason\":\"\(reason)\",\"connectionId\":\"\(connectionId)\"}".utf8)
    #expect(pump.isCurrentClose(metadata: candidate))
  }
  for candidate in [
    #"{"connectionId":"remote_connection0002","reason":"superseded"}"#,
    #"{"connectionId":"remote_connection0001","reason":"arbitrary"}"#,
    #"{"connectionId":"remote_connection0001"}"#,
    #"{"connectionId":"remote_connection0001","reason":"superseded","extra":0}"#,
    #"{"connectionId":"remote_connection0001","reason":"superseded","reason":"superseded"}"#,
  ] { #expect(!pump.isCurrentClose(metadata: Data(candidate.utf8))) }
  pump.clear()
  #expect(!pump.isCurrentClose(metadata: Data(#"{"connectionId":"remote_connection0001","reason":"superseded"}"#.utf8)))
  #expect(throws: Fd199BridgeError.invalidPhoneRecord) { try pump.phonePlaintext(Data(#"{"ok":true}"#.utf8)) }
}

private final class ExchangeOwner: Fd199RelayBridge.SessionOwner {
  let pump: HostedRelayFramePump
  init(_ pump: HostedRelayFramePump) { self.pump = pump }
  func hostedChildDidOpen(metadata: Data) {}
  func hostedChildDidSend(metadata: Data, payload: Data) { pump.childPlaintext(metadata: metadata, payload: payload) }
  func hostedChildDidClose(metadata: Data) {}
}

@Test("production Swift open/frame metadata survives the actual TypeScript gateway request-response")
func hostedFramePumpCrossLanguageGatewayRoundTrip() async throws {
  let sink = FrameSink()
  let failed = FailureFlag()
  let pump = HostedRelayFramePump(sendToPhone: { await sink.append($0) }, failed: { failed.mark() })
  let opened = try openMetadata()
  try pump.install(metadata: opened)
  var wire = Data()
  let bridge = Fd199RelayBridge(sendIntoChild: { wire.append(try RemoteWire.encode($0)) }, owner: ExchangeOwner(pump))
  try bridge.connectionOpened(metadata: opened)
  let request = Data(#"{"version":3,"type":"request","connectionEpoch":1,"requestId":"remote_request_0001","idempotencyKey":"remote_idempotency1","method":"session.list","payload":{}}"#.utf8)
  let frame = try pump.phonePlaintext(request)
  try bridge.frameArrived(metadata: frame.metadata, payload: frame.payload)

  let directory = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-frame-pump-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  defer { try? FileManager.default.removeItem(at: directory) }
  try wire.write(to: directory.appendingPathComponent("input.bin"))
  let log = directory.appendingPathComponent("test.log")
  FileManager.default.createFile(atPath: log.path, contents: Data(), attributes: [.posixPermissions: 0o600])
  let output = try FileHandle(forWritingTo: log)
  defer { try? output.close() }
  var repository = URL(fileURLWithPath: #filePath)
  for _ in 0..<5 { repository.deleteLastPathComponent() }
  let status = try await runGatewayTest(repository: repository, directory: directory, output: output)
  #expect(status == 0, "TypeScript gateway subprocess failed; inspect focused gateway test")
  guard status == 0 else { return }
  var response = try Data(contentsOf: directory.appendingPathComponent("output.bin"))
  let records = try RemoteWire.consume(&response)
  #expect(records.count == 1 && response.isEmpty)
  for record in records { bridge.childRecord(record) }
  #expect(await eventually { await sink.snapshot().count == 1 })
  #expect(!failed.isMarked())
  let delivered = await sink.snapshot()
  let object = try JSONSerialization.jsonObject(with: #require(delivered.first)) as? [String: Any]
  #expect(object?["type"] as? String == "response")
  #expect(object?["requestId"] as? String == "remote_request_0001")
  #expect(try pump.phonePlaintext(request).metadata == referenceMetadata)
}

private enum GatewayTestProcessError: Error { case spawn, timedOut, reap }

/** Owns a fresh process group so a timeout cannot orphan the test runner's descendants. */
private func runGatewayTest(repository: URL, directory: URL, output: FileHandle) async throws -> Int32 {
  var actions: posix_spawn_file_actions_t?
  var attributes: posix_spawnattr_t?
  guard posix_spawn_file_actions_init(&actions) == 0 else { throw GatewayTestProcessError.spawn }
  defer { posix_spawn_file_actions_destroy(&actions) }
  guard posix_spawnattr_init(&attributes) == 0 else { throw GatewayTestProcessError.spawn }
  defer { posix_spawnattr_destroy(&attributes) }
  guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0,
        posix_spawnattr_setpgroup(&attributes, 0) == 0,
        posix_spawn_file_actions_addchdir_np(&actions, repository.path) == 0,
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0) == 0,
        posix_spawn_file_actions_adddup2(&actions, output.fileDescriptor, 1) == 0,
        posix_spawn_file_actions_adddup2(&actions, output.fileDescriptor, 2) == 0
  else { throw GatewayTestProcessError.spawn }
  let arguments = ["/usr/bin/env", "pnpm", "exec", "vitest", "run", "packages/mobile/remote-host-v3/tests/remote-host-v3.spec.ts", "-t", "hands a committed FD198 connection"]
  var argv = arguments.map { strdup($0) } + [nil]
  let environmentStrings: [String] = ["PATH=\(ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin")", "DSH_FRAME_PUMP_EXCHANGE_DIRECTORY=\(directory.path)"]
  var environment: [UnsafeMutablePointer<CChar>?] = environmentStrings.map { strdup($0) } + [nil]
  defer { for value in argv + environment { free(value) } }
  var pid: pid_t = 0
  guard posix_spawn(&pid, "/usr/bin/env", &actions, &attributes, &argv, &environment) == 0 else { throw GatewayTestProcessError.spawn }
  var reaped = false
  defer { if !reaped { kill(-pid, SIGKILL) } }
  func poll() throws -> Int32? {
    var status: Int32 = 0
    let result = waitpid(pid, &status, WNOHANG)
    if result == pid { reaped = true; return status }
    guard result == 0 || errno == EINTR else { throw GatewayTestProcessError.reap }
    return nil
  }
  let deadline = ContinuousClock.now.advanced(by: .seconds(60))
  while ContinuousClock.now < deadline {
    if let status = try poll() { return status }
    if Task.isCancelled { break }
    try? await Task.sleep(for: .milliseconds(25))
  }
  kill(-pid, SIGTERM)
  // Keep the group leader unreaped until escalation so its PID cannot be reused.
  try? await Task.sleep(for: .seconds(1))
  kill(-pid, SIGKILL)
  let reapDeadline = ContinuousClock.now.advanced(by: .seconds(2))
  while ContinuousClock.now < reapDeadline {
    if try poll() != nil { throw GatewayTestProcessError.timedOut }
    try? await Task.sleep(for: .milliseconds(25))
  }
  throw GatewayTestProcessError.reap
}
