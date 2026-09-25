import CryptoKit
import Darwin
import Foundation
import Testing
@testable import RemoteHostFd199

private func withAuthority(_ body: (Fd199AuthorityService, ScriptedChild, Fd199Journal) throws -> Void) throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let (host, peer) = try authoritySocketPair()
  let authority = Fd199AuthorityService(identity: identity, hostAppPath: "/Applications/DSHHost.app", journal: journal, channel: host)
  let child = ScriptedChild(handle: peer)
  authority.serve()
  defer { authority.stop(); child.closeChannel() }
  try child.send(.hello)
  try waitForFrames(child, 1)
  try child.send(.recover)
  try waitForFrames(child, 2)
  try authority.instruct(.prepare)
  try body(authority, child, journal)
}

@Test("authority incrementally verifies a history above ten MiB and a second file")
func streamedLargeHistory() throws {
  try withAuthority { _, child, journal in
    let name = "sessions/large.jsonl"
    try child.send(.prepareFileBegin(name: name))
    try waitForContains(child) { $0 == .prepareFileAck(name: name, offset: 0, complete: false) }
    let chunk = Data(repeating: 0x61, count: fd199MaximumChunkBytes)
    var hash = SHA256()
    var size = 0
    for _ in 0..<41 {
      try child.send(.prepareFileChunk(offset: size, bytesBase64: base64url(chunk)))
      hash.update(data: chunk)
      size += chunk.count
      let offset = size
      try waitForContains(child) { $0 == .prepareFileAck(name: name, offset: offset, complete: false) }
      #expect(try journal.recoverVerified() == nil)
    }
    let digest = Data(hash.finalize()).hexString
    try child.send(.prepareFileEnd(size: size, sha256: digest))
    try waitForContains(child) { $0 == .prepareFileAck(name: name, offset: size, complete: true) }
    try child.send(fixtureEntry())
    try child.send(.prepareComplete)
    try child.send(.releasing)
    try waitForContains(child) { $0 == .releaseAuthorized }
    let record = try #require(try journal.recoverVerified())
    #expect(record.version == 3)
    #expect(record.status == .releasing)
    #expect(record.manifest == [Fd199ManifestEntry(name: name, sha256: digest, size: size), Fd199ManifestEntry(name: "sessions/session_00000001.jsonl", sha256: Data(SHA256.hash(data: fixtureBytes)).hexString, size: fixtureBytes.count)])
  }
}

@Test("stream rejects invalid ordering without writing a journal", arguments: 0..<7)
func rejectsStreamOrdering(_ scenario: Int) throws {
  try withAuthority { authority, child, journal in
    let name = "sessions/one.jsonl"
    try child.send(.prepareFileBegin(name: name))
    try waitForContains(child) { $0 == .prepareFileAck(name: name, offset: 0, complete: false) }
    switch scenario {
    case 0: try child.send(.prepareFileBegin(name: "sessions/two.jsonl"))
    case 1: try child.send(.prepareFileChunk(offset: 1, bytesBase64: "YQ"))
    case 2: try child.send(.prepareFileEnd(size: 1, sha256: String(repeating: "a", count: 64)))
    case 3: try child.send(.prepareComplete)
    case 4: try child.send(.prepareFileChunk(offset: 0, bytesBase64: "YR"))
    case 5: try child.send(.prepareFileChunk(offset: 0, bytesBase64: ""))
    default:
      try child.send(.prepareFileChunk(offset: 0, bytesBase64: "YQ"))
      try waitForContains(child) { $0 == .prepareFileAck(name: name, offset: 1, complete: false) }
      try child.send(.prepareFileEnd(size: 1, sha256: Data(SHA256.hash(data: Data("a".utf8))).hexString))
      try waitForContains(child) { $0 == .prepareFileAck(name: name, offset: 1, complete: true) }
      try child.send(.prepareFileBegin(name: name))
    }
    try waitFor { authority.isStoppedForTesting }
    #expect(try journal.recoverVerified() == nil)
  }
}

@Test("wire refuses v1, mixed commands, unsafe integers and noncanonical chunks")
func wireV2Rejections() throws {
  for body in [
    #"{xkind":"hello","protocolVersion":2}"#,
    #"{"kind":"hello"}"#,
    #"{"kind":"hello","protocolVersion":1}"#,
    #"{"kind":"hello","protocolVersion":true}"#,
    #"{"kind":"prepare-file","name":"sessions/a.jsonl","sha256":"a","bytesBase64":"YQ"}"#,
    #"{"kind":"prepare-file-chunk","offset":9007199254740992,"bytesBase64":"YQ"}"#,
    #"{"kind":"prepare-file-chunk","offset":true,"bytesBase64":"YQ"}"#,
    #"{"kind":"prepare-file-chunk","offset":0,"bytesBase64":"YR"}"#,
  ] {
    #expect(throws: Fd199Error.self) { try fd199DecodeClientFrame(Data(body.utf8)) }
  }
  let nested = "{\"unknown\":" + String(repeating: "[", count: 64) + "0" + String(repeating: "]", count: 64) + "}"
  #expect(throws: Fd199Error.bounds) { try fd199DecodeClientFrame(Data(nested.utf8)) }
  #expect(throws: Fd199Error.self) {
    try fd199DecodeClientFrame(fd199EncodeClientMessage(.prepareFileChunk(offset: 0, bytesBase64: base64url(Data(repeating: 1, count: fd199MaximumChunkBytes + 1)))))
  }
}

@Test("authority refuses a repeated protocol greeting")
func repeatedHelloStops() throws {
  try withAuthority { authority, child, journal in
    try child.send(.hello)
    try waitFor { authority.isStoppedForTesting }
    #expect(try journal.recoverVerified() == nil)
  }
}

@Test("legacy prepared journals activate with their original version-two proof domain")
func legacyPreparedActivation() throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let manifest = [Fd199ManifestEntry(name: "sessions/legacy.jsonl", sha256: String(repeating: "b", count: 64), size: 1)]
  let exportId = "legacy_export_0001"
  let instant = "2026-09-24T00:00:00Z"
  let proof = try Fd199Proofs.signExport(identity, exportId: exportId, stoppedAt: instant, manifest: manifest, version: 2)
  let record = Fd199JournalRecord(version: 2, exportId: exportId, stoppedAt: instant, generation: 0, status: .prepared, exportProof: proof, activationProof: nil, manifest: manifest, manifestDigest: Fd199Proofs.manifestDigest(manifest))
  try journal.stagePrepared(record)
  #expect(try journal.recoverVerified() == record)
  let (host, peer) = try authoritySocketPair()
  let service = Fd199AuthorityService(identity: identity, hostAppPath: "/Applications/DSHHost.app", journal: journal, channel: host)
  let child = ScriptedChild(handle: peer)
  service.serve()
  defer { service.stop(); child.closeChannel() }
  try child.send(.hello)
  try waitForFrames(child, 1)
  try child.send(.recover)
  try waitForFrames(child, 2)
  try service.instruct(.activate)
  try child.send(.activate)
  try waitForContains(child) { $0 == .activated(generation: 1) }
  let activated = try #require(try journal.recoverVerified())
  #expect(activated.version == 2)
  let activation = try #require(activated.activationProof)
  try Fd199Proofs.verifyActivation(activation, identity: identity, exportId: exportId, manifestDigest: record.manifestDigest, generation: 1, version: 2)
  #expect(throws: Fd199Error.self) {
    try Fd199Proofs.verifyActivation(activation, identity: identity, exportId: exportId, manifestDigest: record.manifestDigest, generation: 1, version: 3)
  }
  #expect(String(decoding: Fd199Proofs.exportPayload(exportId: exportId, stoppedAt: instant, manifest: manifest, version: 2), as: UTF8.self) == "{\"exportId\":\"legacy_export_0001\",\"files\":[{\"name\":\"sessions/legacy.jsonl\",\"sha256\":\"\(String(repeating: "b", count: 64))\",\"size\":1}],\"ownerState\":\"web-owner-stopped\",\"stoppedAt\":\"2026-09-24T00:00:00Z\",\"version\":2}")
}

@Test("partial writes and socket pressure stop authority without staging", arguments: [-1, 1])
func failedAuthorityWrite(_ written: Int) throws {
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  let (host, peer) = try authoritySocketPair()
  let service = Fd199AuthorityService(identity: identity, hostAppPath: "/Applications/DSHHost.app", journal: journal, channel: host, writeFrame: { descriptor, frame in
    if case .prepareFileAck = try? fd199DecodeAuthorityFrame(Data(frame.dropFirst(4))) { return written }
    return frame.withUnsafeBytes { Darwin.send(descriptor, $0.baseAddress, $0.count, MSG_DONTWAIT) }
  })
  let child = ScriptedChild(handle: peer)
  service.serve()
  defer { service.stop(); child.closeChannel() }
  try child.send(.hello)
  try waitForFrames(child, 1)
  try child.send(.recover)
  try waitForFrames(child, 2)
  try service.instruct(.prepare)
  try child.send(.prepareFileBegin(name: "sessions/a.jsonl"))
  try waitFor { service.isStoppedForTesting }
  #expect(try journal.recoverVerified() == nil)
  #expect(try !child.received().contains { if case .prepareFileAck = $0 { return true }; return false })
  #expect(throws: Fd199Error.invalidState) { try service.instruct(.prepare) }
}

@Test("version-specific journal quotas reject a legacy oversized file and version flips")
func journalVersionAdmission() throws {
  let identity = try Fd199StaticSigningIdentity()
  for (version, size) in [(2, fd199MaximumFileBytes + 1), (3, fd199MaximumExportBytes + 1)] {
    let root = try makeJournalRoot()
    defer { try? FileManager.default.removeItem(atPath: root) }
    let journal = try Fd199Journal(root: root, identity: identity)
    let manifest = [Fd199ManifestEntry(name: "sessions/large.jsonl", sha256: String(repeating: "a", count: 64), size: size)]
    let proof = try Fd199Proofs.signExport(identity, exportId: "quota_export_00001", stoppedAt: "2026-09-24T00:00:00Z", manifest: manifest, version: version)
    try journal.stagePrepared(Fd199JournalRecord(version: version, exportId: "quota_export_00001", stoppedAt: "2026-09-24T00:00:00Z", generation: 0, status: .prepared, exportProof: proof, activationProof: nil, manifest: manifest, manifestDigest: Fd199Proofs.manifestDigest(manifest)))
    #expect(throws: Fd199Error.self) { try journal.recoverVerified() }
  }
  let manifest = [Fd199ManifestEntry(name: "sessions/a.jsonl", sha256: String(repeating: "a", count: 64), size: 1)]
  let proof = try Fd199Proofs.signExport(identity, exportId: "domain_export_0001", stoppedAt: "2026-09-24T00:00:00Z", manifest: manifest, version: 2)
  #expect(throws: Fd199Error.self) {
    try Fd199Proofs.verifyExport(proof, identity: identity, exportId: "domain_export_0001", stoppedAt: "2026-09-24T00:00:00Z", manifest: manifest, version: 3)
  }
}

@Test("stream accepts the exact aggregate quota and rejects one additional byte", arguments: [false, true])
func aggregateStreamingQuota(_ overflow: Bool) throws {
  try withAuthority { authority, child, journal in
    let name = "sessions/quota.jsonl"
    try child.send(.prepareFileBegin(name: name))
    try waitForContains(child) { $0 == .prepareFileAck(name: name, offset: 0, complete: false) }
    let chunk = Data(repeating: 0x61, count: fd199MaximumChunkBytes)
    let encoded = base64url(chunk)
    var hash = SHA256()
    var size = 0
    while size < fd199MaximumExportBytes {
      try child.send(.prepareFileChunk(offset: size, bytesBase64: encoded))
      hash.update(data: chunk)
      size += chunk.count
      let offset = size
      try waitForContains(child) { $0 == .prepareFileAck(name: name, offset: offset, complete: false) }
    }
    if overflow {
      try child.send(.prepareFileChunk(offset: size, bytesBase64: "YQ"))
      try waitFor { authority.isStoppedForTesting }
      #expect(try journal.recoverVerified() == nil)
    } else {
      try child.send(.prepareFileEnd(size: size, sha256: Data(hash.finalize()).hexString))
      try waitForContains(child) { $0 == .prepareFileAck(name: name, offset: size, complete: true) }
      try child.send(.prepareComplete)
      try child.send(.releasing)
      try waitForContains(child) { $0 == .releaseAuthorized }
      #expect(try journal.recoverVerified()?.manifest.first?.size == fd199MaximumExportBytes)
    }
  }
}
