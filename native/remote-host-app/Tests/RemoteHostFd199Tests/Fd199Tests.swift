import CryptoKit
import Darwin
import Foundation
import Testing
import RemoteHostWire
@testable import RemoteHostFd199

// MARK: - Shared test fixtures

/// Scripted child-side peer speaking the client vocabulary over one end of a
/// socketpair, mirroring `@deepseek-ai/dsh-remote-host-fd199`'s client.
final class ScriptedChild: @unchecked Sendable {
  let handle: FileHandle
  private let lock = NSLock()
  private var buffer = [UInt8]()
  private var delivered = [Fd199AuthorityMessage]()
  private var lastFailedFrame: [UInt8]?
  private(set) var closedByPeer = false

  init(handle: FileHandle) {
    self.handle = handle
    startReading()
  }

  func send(_ message: Fd199ClientMessage) throws {
    let body = try fd199EncodeClientMessage(message)
    var frame = Data([UInt8((body.count >> 24) & 0xff), UInt8((body.count >> 16) & 0xff), UInt8((body.count >> 8) & 0xff), UInt8(body.count & 0xff)])
    frame.append(body)
    try handle.write(contentsOf: frame)
  }

  func send(_ messages: [Fd199ClientMessage]) throws {
    for message in messages { try send(message) }
  }

  /// Closes the child-side end so the authority observes a real EOF.
  func closeChannel() {
    handle.readabilityHandler = nil
    try? handle.close()
  }

  /// Diagnostic snapshot of undecoded buffered bytes.
  func rawBuffer() -> [UInt8] {
    lock.lock()
    defer { lock.unlock() }
    return buffer
  }

  /// Text of the most recent frame whose strict decode failed, if any.
  func lastFailedFrameText() -> String? {
    lock.lock()
    defer { lock.unlock() }
    return lastFailedFrame.map { String(decoding: $0, as: UTF8.self) }
  }

  /// Decodes any newly arrived authority frames and returns everything received so far.
  func received() throws -> [Fd199AuthorityMessage] {
    lock.lock()
    defer { lock.unlock() }
    while buffer.count >= 4 {
      let bodyLength = Int(buffer[0]) << 24 | Int(buffer[1]) << 16 | Int(buffer[2]) << 8 | Int(buffer[3])
      guard buffer.count >= 4 + bodyLength else { break }
      let body = Array(buffer[4..<(4 + bodyLength)])
      do {
        delivered.append(try fd199DecodeAuthorityFrame(Data(body)))
      } catch {
        lastFailedFrame = body
        throw error
      }
      buffer.removeFirst(4 + bodyLength)
    }
    return delivered
  }

  private func startReading() {
    handle.readabilityHandler = { [weak self] handle in
      guard let self else { handle.readabilityHandler = nil; return }
      let data = handle.availableData
      lock.lock()
      if data.isEmpty { closedByPeer = true } else { buffer.append(contentsOf: data) }
      lock.unlock()
    }
  }
}

func authoritySocketPair() throws -> (FileHandle, FileHandle) {
  var descriptors: [Int32] = [0, 0]
  guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw Fd199Error.invalidState }
  _ = setsockopt(descriptors[1], SOL_SOCKET, SO_NOSIGPIPE, [1], socklen_t(MemoryLayout<Int32>.size))
  return (
    FileHandle(fileDescriptor: descriptors[0], closeOnDealloc: true),
    FileHandle(fileDescriptor: descriptors[1], closeOnDealloc: true)
  )
}

/**
 Polls until the child has received at least `minimum` decodable frames.
 A decode failure surfaces as a test issue naming the failing frame count.
 */
func waitForFrames(_ child: ScriptedChild, _ minimum: Int) throws {
  var lastError: Error?
  let startedAt = Date()
  while Date().timeIntervalSince(startedAt) < 30.0 {
    do {
      if try child.received().count >= minimum { return }
      lastError = nil
    } catch {
      lastError = error
    }
    usleep(2_000)
  }
  if let lastError {
    let frameText = child.lastFailedFrameText() ?? "none"
    Issue.record("frame decode failed while waiting: \(lastError); failedFrame=\(frameText)")
  }
  throw Fd199Error.invalidState
}

func waitFor(_ condition: () -> Bool) throws {
  let startedAt = Date()
  while Date().timeIntervalSince(startedAt) < 30.0 {
    if condition() { return }
    usleep(2_000)
  }
  throw Fd199Error.invalidState
}

/// Polls until any received frame satisfies the predicate, surfacing decode failures.
func waitForContains(
  _ child: ScriptedChild,
  _ predicate: @escaping (Fd199AuthorityMessage) -> Bool
) throws {
  let startedAt = Date()
  var lastError: Error?
  while Date().timeIntervalSince(startedAt) < 8.0 {
    do {
      if try child.received().contains(where: predicate) { return }
      lastError = nil
    } catch {
      lastError = error
    }
    usleep(2_000)
  }
  if let lastError {
    Issue.record("frame decode failed while waiting: \(lastError)")
  }
  throw Fd199Error.invalidState
}

let fixtureBytes = Data("{\"id\":\"same-session\"}\n".utf8)

@Test("journal admits a verified logical history above eight MiB")
func largeLogicalHistory() throws {
  let identity = try Fd199StaticSigningIdentity()
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let journal = try Fd199Journal(root: root, identity: identity)
  let manifest = [Fd199ManifestEntry(name: "sessions/large.jsonl", sha256: String(repeating: "a", count: 64), size: 10 * 1024 * 1024 + 1)]
  let proof = try Fd199Proofs.signExport(identity, exportId: "large_history_export", stoppedAt: "2026-09-24T00:00:00Z", manifest: manifest)
  let record = Fd199JournalRecord(version: Fd199Proofs.recordVersion, exportId: "large_history_export", stoppedAt: "2026-09-24T00:00:00Z", generation: 0, status: .prepared, exportProof: proof, activationProof: nil, manifest: manifest, manifestDigest: Fd199Proofs.manifestDigest(manifest))
  try journal.stagePrepared(record)
  #expect(try journal.recoverVerified() == record)
}

func fixtureEntry(digest: Bool = true) -> [Fd199ClientMessage] {
  let sha256 = Data(SHA256.hash(data: fixtureBytes)).hexString
  return [.prepareFileBegin(name: "sessions/session_00000001.jsonl"),
          .prepareFileChunk(offset: 0, bytesBase64: base64url(fixtureBytes)),
          .prepareFileEnd(size: fixtureBytes.count, sha256: digest ? sha256 : String(repeating: "a", count: 64))]
}

func makeJournalRoot() throws -> String {
  let root = NSTemporaryDirectory() + "fd199-journal-\(UUID().uuidString)"
  try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  return root
}

// MARK: - Wire tests

@Test("authority wire round-trips every message and rejects malformed bodies")
func wireRoundTrip() throws {
  let messages: [Fd199AuthorityMessage] = [
    .ready(hostAppPath: "/Applications/DSH Host.app/Contents/MacOS/DSH Host"),
    .prepareFileAck(name: "sessions/a.jsonl", offset: 0, complete: false),
    .prepareFileAck(name: "sessions/a.jsonl", offset: 262144, complete: true),
    .snapshot(status: .none, generation: 0),
    .snapshot(status: .activated, generation: 3),
    .releaseAuthorized,
    .activated(generation: 2),
    .instruct(action: .prepare),
    .instruct(action: .activate),
  ]
  for message in messages {
    let decoded = try fd199DecodeAuthorityFrame(try fd199EncodeAuthorityMessage(message))
    #expect(decoded == message)
  }
}

@Test("authority wire rejects duplicate keys, unknown kinds, and wrong bounds")
func wireRejections() throws {
  let duplicates = "{\"kind\":\"snapshot\",\"status\":\"none\",\"status\":\"activated\",\"generation\":0}"
  #expect(throws: Fd199Error.self) { try fd199DecodeAuthorityFrame(Data(duplicates.utf8)) }
  let unknown = "{\"kind\":\"explode\"}"
  #expect(throws: Fd199Error.self) { try fd199DecodeAuthorityFrame(Data(unknown.utf8)) }
  let trailing = "{\"kind\":\"release-now\"} tail"
  #expect(throws: Fd199Error.self) { try fd199DecodeAuthorityFrame(Data(trailing.utf8)) }
  #expect(throws: Fd199Error.self) { try fd199DecodeClientFrame(Data()) }
}

// MARK: - Proof tests

@Test("proofs sign and verify, and reject tampered payloads or wrong keys")
func proofSignVerify() throws {
  let identity = try Fd199StaticSigningIdentity()
  let manifest = [Fd199ManifestEntry(name: "sessions/session_00000001.jsonl", sha256: String(repeating: "b", count: 64), size: 21)]
  let exportProof = try Fd199Proofs.signExport(identity, exportId: "export_identity_0001", stoppedAt: "2026-08-21T00:00:00Z", manifest: manifest)
  try Fd199Proofs.verifyExport(exportProof, identity: identity, exportId: "export_identity_0001", stoppedAt: "2026-08-21T00:00:00Z", manifest: manifest)
  #expect(throws: Fd199Error.self) {
    try Fd199Proofs.verifyExport(exportProof, identity: identity, exportId: "export_identity_0002", stoppedAt: "2026-08-21T00:00:00Z", manifest: manifest)
  }
  let other = try Fd199StaticSigningIdentity()
  #expect(throws: Fd199Error.self) {
    try Fd199Proofs.verifyExport(exportProof, identity: other, exportId: "export_identity_0001", stoppedAt: "2026-08-21T00:00:00Z", manifest: manifest)
  }
  let activationProof = try Fd199Proofs.signActivation(identity, exportId: "export_identity_0001", manifestDigest: Fd199Proofs.manifestDigest(manifest), generation: 1)
  try Fd199Proofs.verifyActivation(activationProof, identity: identity, exportId: "export_identity_0001", manifestDigest: Fd199Proofs.manifestDigest(manifest), generation: 1)
  #expect(throws: Fd199Error.self) {
    try Fd199Proofs.verifyActivation(activationProof, identity: identity, exportId: "export_identity_0001", manifestDigest: Fd199Proofs.manifestDigest(manifest), generation: 2)
  }
}

// MARK: - Journal tests

@Test("journal stages prepared, consumes by exact CAS, and recovers revalidated records")
func journalLifecycle() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let recoveredEmpty = try journal.recoverVerified()
  #expect(recoveredEmpty == nil)

  let manifest = [Fd199ManifestEntry(name: "sessions/session_00000001.jsonl", sha256: Data(SHA256.hash(data: fixtureBytes)).hexString, size: fixtureBytes.count)]
  let digest = Fd199Proofs.manifestDigest(manifest)
  let exportProof = try Fd199Proofs.signExport(identity, exportId: "export_identity_0001", stoppedAt: "2026-08-21T00:00:00Z", manifest: manifest)
  let prepared = Fd199JournalRecord(
    version: Fd199Proofs.recordVersion, exportId: "export_identity_0001", stoppedAt: "2026-08-21T00:00:00Z",
    generation: 0, status: .prepared, exportProof: exportProof, activationProof: nil,
    manifest: manifest, manifestDigest: digest
  )
  try journal.stagePrepared(prepared)
  let recoveredPrepared = try journal.recoverVerified()
  #expect(recoveredPrepared == prepared)

  let activationProof = try Fd199Proofs.signActivation(identity, exportId: prepared.exportId, manifestDigest: digest, generation: 1)
  let activated = Fd199JournalRecord(
    version: Fd199Proofs.recordVersion, exportId: prepared.exportId, stoppedAt: prepared.stoppedAt,
    generation: 1, status: .activated, exportProof: exportProof, activationProof: activationProof,
    manifest: manifest, manifestDigest: digest
  )
  #expect(try journal.transitionPrepared(expected: prepared, next: activated))
  // The CAS refuses a replayed transition against the already-activated bytes.
  let replayed = try journal.transitionPrepared(expected: prepared, next: activated)
  #expect(replayed == false)
  #expect(try journal.recoverVerified() == activated)

  // A second journal handle sees the same durable truth after recovery.
  let second = try Fd199Journal(root: root, identity: identity)
  #expect(try second.recoverVerified() == activated)
}

@Test("journal recovery rejects tampered records and symlink state files")
func journalTamperRejection() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let manifest = [Fd199ManifestEntry(name: "sessions/session_00000001.jsonl", sha256: Data(SHA256.hash(data: fixtureBytes)).hexString, size: fixtureBytes.count)]
  let exportProof = try Fd199Proofs.signExport(identity, exportId: "export_identity_0001", stoppedAt: "2026-08-21T00:00:00Z", manifest: manifest)
  let prepared = Fd199JournalRecord(
    version: Fd199Proofs.recordVersion, exportId: "export_identity_0001", stoppedAt: "2026-08-21T00:00:00Z",
    generation: 0, status: .prepared, exportProof: exportProof, activationProof: nil,
    manifest: manifest, manifestDigest: Fd199Proofs.manifestDigest(manifest)
  )
  try journal.stagePrepared(prepared)

  let statePath = root + "/" + Fd199Journal.stateFilename
  let original = try Data(contentsOf: URL(fileURLWithPath: statePath))
  // A flipped byte inside the signed record breaks proof or digest validation.
  var tampered = original
  tampered[tampered.startIndex] = 0x7b == tampered[tampered.startIndex] ? 0x7d : 0x7b
  try tampered.write(to: URL(fileURLWithPath: statePath))
  #expect(throws: Fd199Error.self) { try journal.recoverVerified() }
  try original.write(to: URL(fileURLWithPath: statePath))

  // A symlinked state file is refused outright.
  try FileManager.default.removeItem(atPath: statePath)
  let outside = root + "/outside.json"
  try original.write(to: URL(fileURLWithPath: outside))
  try FileManager.default.createSymbolicLink(atPath: statePath, withDestinationPath: "outside.json")
  #expect(throws: Fd199Error.self) { try journal.recoverVerified() }
}

@Test("only a proof-verified releasing export can become prepared")
func journalPromotionRejectsTamperedReleasingRecord() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let manifest = [Fd199ManifestEntry(name: "sessions/session_00000001.jsonl", sha256: Data(SHA256.hash(data: fixtureBytes)).hexString, size: fixtureBytes.count)]
  let record = Fd199JournalRecord(
    version: Fd199Proofs.recordVersion, exportId: "export_identity_0001", stoppedAt: "2026-08-21T00:00:00Z",
    generation: 0, status: .exported,
    exportProof: try Fd199Proofs.signExport(identity, exportId: "export_identity_0001", stoppedAt: "2026-08-21T00:00:00Z", manifest: manifest),
    activationProof: nil, manifest: manifest, manifestDigest: Fd199Proofs.manifestDigest(manifest)
  )
  try journal.stageExported(record)
  _ = try journal.transitionExportedToReleasing(record)
  let statePath = root + "/" + Fd199Journal.stateFilename
  var bytes = try Data(contentsOf: URL(fileURLWithPath: statePath))
  bytes[bytes.index(before: bytes.endIndex)] ^= 1
  try bytes.write(to: URL(fileURLWithPath: statePath))
  #expect(throws: Fd199Error.self) { try journal.promoteReleasingToPrepared() }
}

// MARK: - End-to-end authority service tests

/// Serialized: three live authority services share one process under load.
@Suite(.serialized)
struct Fd199EndToEndSuite {

@Test("authority serves the full prepare choreography with its release barrier")
func authorityPrepareChoreography() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let (hostEnd, childEnd) = try authoritySocketPair()
  let service = Fd199AuthorityService(identity: identity, hostAppPath: "/Applications/DSH Host.app", journal: journal, channel: hostEnd)
  service.serve()
  let child = ScriptedChild(handle: childEnd)

  do {
    try child.send(.hello)
  } catch {
    Issue.record("send hello failed: \(error)")
    throw error
  }
  do {
    try waitFor { (try? child.received().count)! >= 1 }
  } catch {
    Issue.record("no ready frame arrived; received=\((try? child.received()) ?? [])")
    throw error
  }
  let firstFrame = try child.received().first
  guard case .ready = firstFrame else { Issue.record("expected ready, got: \(String(describing: firstFrame))"); return }

  try child.send(.recover)
  try waitFor { (try? child.received().count)! >= 2 }
  guard case .snapshot(.none, 0) = try child.received()[1] else { Issue.record("expected empty snapshot"); return }

  try service.instruct(.prepare)
  try child.send(fixtureEntry())
  try child.send(.prepareComplete)
  try child.send(.releasing)
  try waitForContains(child) { $0 == .releaseAuthorized }
  guard case .releaseAuthorized = try child.received().last else { Issue.record("expected release-authorized"); return }

  let record = try journal.recoverVerified()
  #expect(record?.status == .releasing)
  #expect(record?.manifest.first?.sha256 == Data(SHA256.hash(data: fixtureBytes)).hexString)
  service.stop()
}

@Test("authority consumes an explicit activation and reports the next generation")
func authorityActivation() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let (hostEnd, childEnd) = try authoritySocketPair()
  let service = Fd199AuthorityService(identity: identity, hostAppPath: "/Applications/DSH Host.app", journal: journal, channel: hostEnd)
  service.serve()
  let child = ScriptedChild(handle: childEnd)

  try child.send(.hello)
  try waitFor { (try? child.received().count)! >= 1 }
  try service.instruct(.prepare)
  try child.send(fixtureEntry())
  try child.send(.prepareComplete)
  try child.send(.releasing)
  try waitForContains(child) { $0 == .releaseAuthorized }
  _ = try journal.promoteReleasingToPrepared()

  try service.instruct(.activate)
  try child.send(.activate)
  try waitFor { (try? child.received().contains(.activated(generation: 1))) ?? false }
  #expect(try journal.recoverVerified()?.status == .activated)
  service.stop()
}

@Test("authority rejects a wrong-digest export entry instead of staging it")
func authorityRejectsBadDigest() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let (hostEnd, childEnd) = try authoritySocketPair()
  let service = Fd199AuthorityService(identity: identity, hostAppPath: "/Applications/DSH Host.app", journal: journal, channel: hostEnd)
  service.serve()
  let child = ScriptedChild(handle: childEnd)

  try child.send(.hello)
  try waitFor { (try? child.received().count)! >= 1 }
  try service.instruct(.prepare)
  try child.send(fixtureEntry(digest: false))
  try child.send(.prepareComplete)
  // The authority verifies digests before staging, so it stops itself
  // instead of ever offering the release barrier.
  let startedAt = Date()
  while !service.isStoppedForTesting, Date().timeIntervalSince(startedAt) < 8.0 {
    usleep(2_000)
  }
  #expect(service.isStoppedForTesting)
  #expect(!((try? child.received().contains(.releaseAuthorized)) ?? false))
  // No staged record may exist after the failed verification.
  #expect(try journal.recoverVerified() == nil)
}
}

@Test("authority refuses ownership transitions without an armed instruction")
func authorityRefusesUnsolicitedTransitions() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let (hostEnd, childEnd) = try authoritySocketPair()
  let service = Fd199AuthorityService(identity: identity, hostAppPath: "/Applications/DSH Host.app", journal: journal, channel: hostEnd)
  service.serve()
  let child = ScriptedChild(handle: childEnd)

  try child.send(.hello)
  try waitForFrames(child, 1)
  try child.send(.recover)
  try waitForFrames(child, 2)

  // A child self-advancing to activation with no Host instruction is the
  // exact escalation this gate exists to refuse.
  try child.send(.activate)
  try waitFor { service.isStoppedForTesting }
  #expect(try journal.recoverVerified() == nil)
}

@Test("authority accepts desktop-ready only after a fresh recovery snapshot")
func authorityGatesDesktopReadinessToFirstGeneration() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let (hostEnd, childEnd) = try authoritySocketPair()
  let service = Fd199AuthorityService(identity: identity, hostAppPath: "/Applications/DSH Host.app", journal: journal, channel: hostEnd)
  service.serve()
  let child = ScriptedChild(handle: childEnd)

  // Readiness before an attested recovery would let an arbitrary child move
  // the UI gate, so it must close the authority rather than set the fact.
  try child.send(.desktopReady)
  try waitFor { service.isStoppedForTesting }
  #expect(!service.hasDesktopReady)

  let (freshHost, freshChildEnd) = try authoritySocketPair()
  let freshService = Fd199AuthorityService(identity: identity, hostAppPath: "/Applications/DSH Host.app", journal: journal, channel: freshHost)
  freshService.serve()
  let freshChild = ScriptedChild(handle: freshChildEnd)
  try freshChild.send(.hello)
  try waitForFrames(freshChild, 1)
  try freshChild.send(.recover)
  try waitForFrames(freshChild, 2)
  try freshChild.send(.desktopReady)
  try waitFor { freshService.hasDesktopReady }
  #expect(!freshService.isStoppedForTesting)
  freshService.stop()
}

// MARK: - Handoff coordinator choreography

/// One scripted hosted-child generation speaking the launcher contract over
/// real socketpairs, with observable closure semantics for the coordinator.
private final class ScriptedGenerationHandle: Fd199AuthorityChannelProviding, @unchecked Sendable {
  let hostRelay: FileHandle
  let hostAuthority: FileHandle
  private(set) var outputHandler: (@Sendable (Fd199HostedChildOutput) -> Void)?
  private var closed = false
  private var didWaitForReady = false
  var failExitWait = false
  private(set) var exitWaitBudget: Int32?
  private let lock = NSLock()

  var isClosed: Bool {
    lock.lock(); defer { lock.unlock() }
    return closed
  }

  var waitedForReady: Bool {
    lock.lock(); defer { lock.unlock() }
    return didWaitForReady
  }

  init(hostRelay: FileHandle, hostAuthority: FileHandle) {
    self.hostRelay = hostRelay
    self.hostAuthority = hostAuthority
  }

  func setOutputHandler(_ handler: @escaping @Sendable (Fd199HostedChildOutput) -> Void) {
    lock.lock(); outputHandler = handler; lock.unlock()
  }

  func emit(_ output: Fd199HostedChildOutput) {
    lock.lock(); let handler = outputHandler; lock.unlock()
    handler?(output)
  }

  func markClosedAndCloseAuthority() {
    lock.lock(); closed = true; lock.unlock()
  }

  func sendPublicRecord(_ record: RemoteWireRecord) throws {}

  func waitUntilReady() throws {
    lock.lock(); didWaitForReady = true; lock.unlock()
  }

  func waitUntilExited(timeoutMilliseconds: Int32) throws {
    exitWaitBudget = timeoutMilliseconds
    if failExitWait { throw Fd199HandoffCoordinator.CoordinatorError.unavailable }
    let deadline = Date().addingTimeInterval(30)
    while !isClosed, Date() < deadline { usleep(1_000) }
    guard isClosed else { throw Fd199HandoffCoordinator.CoordinatorError.unavailable }
  }

  func takeAuthorityChannel() -> FileHandle? {
    hostAuthority
  }

  func stop() {
    markClosedAndCloseAuthority()
  }
}

@Test("handoff deadline failure stops both channels without promoting or spawning an adopter")
func handoffTimeoutStaysFenced() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let (hostRelay, peerRelay) = try authoritySocketPair()
  defer { try? peerRelay.close() }
  let (hostAuthority, peerAuthority) = try authoritySocketPair()
  let child = ScriptedChild(handle: peerAuthority)
  defer { child.closeChannel() }
  let handle = ScriptedGenerationHandle(hostRelay: hostRelay, hostAuthority: hostAuthority)
  handle.failExitWait = true
  var spawns = 0
  let coordinator = Fd199HandoffCoordinator(identity: identity, hostAppPath: "/Applications/DSHHost.app", journalDirectory: root, spawn: {
    spawns += 1
    return handle
  })
  defer { coordinator.stop() }
  Thread.detachNewThread {
    do {
      try child.send(.hello)
      try waitForFrames(child, 1)
      try child.send(.recover)
      try waitForFrames(child, 2)
      try child.send(.desktopReady)
    } catch { Issue.record("timeout peer setup failed: \(error)") }
  }
  try coordinator.start()
  #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) { try coordinator.activatePhoneSessions() }
  #expect(handle.exitWaitBudget == 120_000)
  #expect(handle.isClosed)
  #expect(spawns == 1)
  #expect(coordinator.phase == .transferringOwnership)
  #expect(try Fd199Journal(root: root, identity: identity).recoverVerified() == nil)
}

@Test("coordinator drives prepare, relaunch, and activation across child generations")
func coordinatorFullChoreography() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()

  final class GenerationQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var handles: [ScriptedGenerationHandle]
    init(_ handles: [ScriptedGenerationHandle]) { self.handles = handles }
    func take() -> ScriptedGenerationHandle {
      lock.lock(); defer { lock.unlock() }
      return handles.isEmpty ? ScriptedGenerationHandle(hostRelay: FileHandle(), hostAuthority: FileHandle()) : handles.removeFirst()
    }
  }

  // Generation 1 socketpairs.
  let (g1HostRelay, _) = try authoritySocketPair()
  let (g1HostAuthority, g1ChildAuthority) = try authoritySocketPair()
  let g1Child = ScriptedChild(handle: g1ChildAuthority)
  let g1Handle = ScriptedGenerationHandle(hostRelay: g1HostRelay, hostAuthority: g1HostAuthority)

  // Generation 2 socketpairs.
  let (g2HostRelay, g2ChildRelay) = try authoritySocketPair()
  let (g2HostAuthority, g2ChildAuthority) = try authoritySocketPair()
  let g2Child = ScriptedChild(handle: g2ChildAuthority)
  let g2Handle = ScriptedGenerationHandle(hostRelay: g2HostRelay, hostAuthority: g2HostAuthority)
  _ = g2ChildRelay

  let queue = GenerationQueue([g1Handle, g2Handle])
  final class ReadyBox: @unchecked Sendable {
    var value = false
  }
  let readyBox = ReadyBox()
  let coordinator = Fd199HandoffCoordinator(
    identity: identity,
    hostAppPath: "/Applications/DSH Host.app",
    journalDirectory: root,
    spawn: { queue.take() }
  )
  g2Handle.setOutputHandler { output in
    if case .ready = output { readyBox.value = true }
  }

  final class FlagBox: @unchecked Sendable {
    var value = false
  }
  let g1Done = FlagBox()
  let g2Done = FlagBox()

  // Generation 1 script: admit desktop, answer the armed prepare cycle, exit.
  Thread.detachNewThread {
    do {
      try g1Child.send(.hello)
      try waitForFrames(g1Child, 1)
      try g1Child.send(.recover)
      try waitForFrames(g1Child, 2)
      // The first-generation coordinator now waits for real Web ownership:
      // this message represents the child publishing the loopback registry.
      try g1Child.send(.desktopReady)
      // Coordinator will arm prepare once activatePhoneSessions runs below.
      try waitForContains(g1Child) { $0 == .instruct(action: .prepare) }
      try g1Child.send(fixtureEntry())
      try g1Child.send(.prepareComplete)
      try g1Child.send(.releasing)
      try waitForContains(g1Child) { $0 == .releaseAuthorized }
      // v1 release ownership: the settled first child exits, closing its end.
      g1Child.closeChannel()
      g1Handle.markClosedAndCloseAuthority()
      g1Done.value = true
    } catch {
      Issue.record("generation 1 script failed: \(error)")
    }
  }

  // Start waits for the FD199 recovery exchange, not V3 runtime.ready.
  try coordinator.start()
  #expect(coordinator.phase == .desktopAdmitted)

  // Generation 2 must be ready to answer the adopted child's recovery and
  // activation while `activatePhoneSessions()` synchronously waits for V3.
  Thread.detachNewThread {
    do {
      try g2Child.send(.hello)
      try waitForFrames(g2Child, 1)
      try g2Child.send(.recover)
      try waitForFrames(g2Child, 2)
      try waitForContains(g2Child) { $0 == .instruct(action: .activate) }
      try g2Child.send(.activate)
      try waitForContains(g2Child) { $0 == .activated(generation: 1) }
      g2Handle.emit(.ready)
      readyBox.value = true
      g2Done.value = true
    } catch {
      Issue.record("generation 2 script failed: \(error)")
    }
  }

  try coordinator.activatePhoneSessions()
  #expect(coordinator.phase == .transferringOwnership || coordinator.phase == .servingPhoneSessions)

  // The adopter signals readiness through the supervisor output surface.
  try waitFor({ readyBox.value }, timeoutSeconds: 30)
  try waitFor({ g1Done.value && g2Done.value }, timeoutSeconds: 30)
  #expect(coordinator.phase == .servingPhoneSessions)
  #expect(coordinator.hasLiveChild)
  g2Handle.markClosedAndCloseAuthority()
  #expect(!coordinator.hasLiveChild)

  coordinator.stop()
}

@Test("coordinator restores an activated journal only after registry and FD198 readiness")
func coordinatorActivatedRestartWaitsForBothReadinessFacts() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let manifest = [Fd199ManifestEntry(
    name: "sessions/session_00000001.jsonl",
    sha256: Data(SHA256.hash(data: fixtureBytes)).hexString,
    size: fixtureBytes.count
  )]
  let exportId = "activated_restart_000001"
  let stoppedAt = "2026-08-24T00:00:00Z"
  let exportProof = try Fd199Proofs.signExport(identity, exportId: exportId, stoppedAt: stoppedAt, manifest: manifest)
  let activationProof = try Fd199Proofs.signActivation(identity, exportId: exportId, manifestDigest: Fd199Proofs.manifestDigest(manifest), generation: 1)
  try journal.stagePrepared(Fd199JournalRecord(
    version: Fd199Proofs.recordVersion, exportId: exportId, stoppedAt: stoppedAt, generation: 0,
    status: .prepared, exportProof: exportProof, activationProof: nil,
    manifest: manifest, manifestDigest: Fd199Proofs.manifestDigest(manifest)
  ))
  let prepared = try journal.recoverVerified()
  guard let prepared else { Issue.record("missing prepared journal"); return }
  #expect(try journal.transitionPrepared(expected: prepared, next: Fd199JournalRecord(
    version: Fd199Proofs.recordVersion, exportId: exportId, stoppedAt: stoppedAt, generation: 1,
    status: .activated, exportProof: exportProof, activationProof: activationProof,
    manifest: manifest, manifestDigest: Fd199Proofs.manifestDigest(manifest)
  )))

  let (hostRelay, _) = try authoritySocketPair()
  let (hostAuthority, childAuthority) = try authoritySocketPair()
  let child = ScriptedChild(handle: childAuthority)
  let handle = ScriptedGenerationHandle(hostRelay: hostRelay, hostAuthority: hostAuthority)
  let coordinator = Fd199HandoffCoordinator(
    identity: identity,
    hostAppPath: "/Applications/DSH Host.app",
    journalDirectory: root,
    spawn: { handle }
  )
  Thread.detachNewThread {
    do {
      try child.send(.hello)
      try waitForFrames(child, 1)
      try child.send(.recover)
      try waitForFrames(child, 2)
      try child.send(.desktopReady)
    } catch {
      Issue.record("activated restart script failed: \(error)")
    }
  }
  try coordinator.start()
  #expect(handle.waitedForReady)
  #expect(coordinator.phase == .servingPhoneSessions)
  coordinator.stop()
}

private func waitFor(_ condition: () -> Bool, timeoutSeconds: Double) throws {
  let deadline = Date().addingTimeInterval(timeoutSeconds)
  while Date() < deadline {
    if condition() { return }
    usleep(5_000)
  }
  throw Fd199Error.invalidState
}

// MARK: - Relay bridge

@Test("relay bridge encodes session facts and forwards child effects")
func relayBridgeRoundTrip() throws {
  let (hostEnd, childEnd) = try authoritySocketPair()
  defer {
    try? hostEnd.close()
    try? childEnd.close()
  }
  final class RecordBox: @unchecked Sendable {
    var records: [RemoteWireRecord] = []
  }
  let childRecords = RecordBox()

  final class Owner: Fd199RelayBridge.SessionOwner, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var events: [String] = []
    func hostedChildDidOpen(metadata: Data) { lock.lock(); events.append("open"); lock.unlock() }
    func hostedChildDidSend(metadata: Data, payload: Data) { lock.lock(); events.append("send:\(String(decoding: payload, as: UTF8.self))"); lock.unlock() }
    func hostedChildDidClose(metadata: Data) { lock.lock(); events.append("close"); lock.unlock() }
  }
  let owner = Owner()

  // The bridge writes toward childEnd; collect and parse there.
  childEnd.readabilityHandler = { handle in
    let data = handle.availableData
    guard !data.isEmpty else { return }
    var buffer = data
    let parsed = (try? RemoteWire.consume(&buffer)) ?? []
    childRecords.records.append(contentsOf: parsed)
  }

  let bridge = Fd199RelayBridge(sendIntoChild: { record in
    try hostEnd.write(contentsOf: RemoteWire.encode(record))
  }, owner: owner)

  try bridge.enrollmentSeed(
    deviceId: "remote_device_0001", label: "Bridge Phone",
    signingPublicKey: String(repeating: "A", count: 43), agreementPublicKey: String(repeating: "B", count: 43),
    deviceEnrollmentId: "dev_enr_1", hostEnrollmentId: "host_enr_1"
  )
  try bridge.deviceEnroll(deviceId: "remote_device_0001", label: "Bridge Phone", signingPublicKey: String(repeating: "A", count: 43), agreementPublicKey: String(repeating: "B", count: 43))
  try bridge.routeUpsert(routeId: "remote_route_000001", deviceId: "remote_device_0001", deviceEnrollmentId: "dev_enr_1", hostDeviceId: "host_device_01", hostEnrollmentId: "host_enr_1", generation: 1)
  try bridge.epochBegin(deviceId: "remote_device_0001")
  try bridge.epochCommit(deviceId: "remote_device_0001", epoch: 7)
  try bridge.connectionOpened(metadata: Data("{\"connectionId\":\"c1\"}".utf8))
  try bridge.frameArrived(metadata: Data("{\"connectionId\":\"c1\"}".utf8), payload: Data("hello".utf8))
  try bridge.connectionClosed(metadata: Data("{\"connectionId\":\"c1\"}".utf8))

  try waitFor({ childRecords.records.count >= 8 }, timeoutSeconds: 30)
  let kinds = childRecords.records.map(\.kind)
  #expect(kinds[0] == .enrollmentSeed)
  #expect(kinds[1] == .deviceEnroll)
  #expect(kinds[2] == .routeUpsert)
  #expect(kinds[3] == .epochBegin)
  #expect(kinds[4] == .epochCommit)
  #expect(kinds[5] == .connectionOpen)
  #expect(kinds[6] == .connectionFrame)
  #expect(kinds[7] == .connectionClosed)
  let seed = try #require(childRecords.records.first)
  let seedMetadata = try #require(JSONSerialization.jsonObject(with: seed.metadata) as? [String: Any])
  #expect(Set(seedMetadata.keys) == Set(["deviceId", "label", "signingPublicKey", "agreementPublicKey", "deviceEnrollmentId", "hostEnrollmentId"]))
  #expect(seedMetadata["hostToken"] == nil)
  #expect(seedMetadata["deviceToken"] == nil)
  #expect(seedMetadata["privateKey"] == nil)

  // Child-originated effects reach the owner.
  bridge.childRecord(RemoteWireRecord(kind: .runtimeReady))
  bridge.childRecord(RemoteWireRecord(kind: .connectionSend, metadata: Data(), payload: Data("reply".utf8)))
  bridge.childRecord(RemoteWireRecord(kind: .connectionClose))
  try waitFor({ owner.events.count >= 4 }, timeoutSeconds: 30)
  #expect(owner.events.first == "open")
  #expect(owner.events.contains("send:reply"))
  #expect(owner.events.last == "close")

  // Detached bridges refuse session-owner sends.
  bridge.detachOwner()
  #expect(throws: Fd199BridgeError.detached) { try bridge.connectionOpened(metadata: Data()) }

  let hostilePhoneRecord = RemoteWireRecord(kind: .routeUpsert, metadata: Data("{}".utf8))
  #expect(throws: Fd199BridgeError.invalidPhoneRecord) { try bridge.phoneRecord(hostilePhoneRecord) }

  hostEnd.readabilityHandler = nil
  childEnd.readabilityHandler = nil
}


@Test("hosted tree validator accepts exact farm and rejects drift")
func hostedTreeValidation() throws {
  let root = try makeJournalRoot() // reuse temp-dir helper
  defer { try? FileManager.default.removeItem(atPath: root) }

  let manifest = Fd199HostedTreeManifest(
    formatVersion: 1,
    packageCount: 2,
    entries: [
      Fd199HostedTreeEntry(name: "@deepseek-ai/dsh-llm", target: root + "/pkg-llm"),
      Fd199HostedTreeEntry(name: "zod", target: root + "/pkg-zod"),
    ]
  )
  let manifestData = try PropertyListEncoder().encode(manifest)

  // Nothing exists yet -> unavailable.
  #expect(throws: Fd199Error.journal) {
    try Fd199HostedTreeValidator.validate(root: root, manifestData: manifestData)
  }

  // Exact farm -> accepted.
  try FileManager.default.createDirectory(atPath: root + "/@deepseek-ai", withIntermediateDirectories: true)
  try FileManager.default.createSymbolicLink(atPath: root + "/@deepseek-ai/dsh-llm", withDestinationPath: root + "/pkg-llm")
  try FileManager.default.createSymbolicLink(atPath: root + "/zod", withDestinationPath: root + "/pkg-zod")
  try Fd199HostedTreeValidator.validate(root: root, manifestData: manifestData)

  // Drift (wrong target) -> refused.
  try FileManager.default.removeItem(atPath: root + "/zod")
  try FileManager.default.createSymbolicLink(atPath: root + "/zod", withDestinationPath: root + "/elsewhere")
  #expect(throws: Fd199Error.journal) {
    try Fd199HostedTreeValidator.validate(root: root, manifestData: manifestData)
  }
}
