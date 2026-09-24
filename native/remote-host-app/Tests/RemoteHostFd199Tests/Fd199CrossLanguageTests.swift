import CryptoKit
import Darwin
import Foundation
import Testing
@testable import RemoteHostFd199

private func spawnTypeScriptPeer(node: String, fixture: String, mode: String, descriptor: Int32) throws -> pid_t {
  var repo = URL(fileURLWithPath: fixture)
  for _ in 0..<5 { repo.deleteLastPathComponent() }
  let arguments = [node, "--import", repo.appendingPathComponent("node_modules/tsx/dist/loader.mjs").path, fixture, mode]
  let argv = arguments.map { strdup($0) } + [nil]
  let env = [strdup("PATH=/usr/bin:/bin"), nil]
  defer { for pointer in argv + env { free(pointer) } }
  var actions: posix_spawn_file_actions_t?
  guard posix_spawn_file_actions_init(&actions) == 0 else { throw Fd199Error.invalidState }
  defer { posix_spawn_file_actions_destroy(&actions) }
  guard posix_spawn_file_actions_adddup2(&actions, descriptor, 199) == 0 else { throw Fd199Error.invalidState }
  var attributes: posix_spawnattr_t?
  guard posix_spawnattr_init(&attributes) == 0 else { throw Fd199Error.invalidState }
  defer { posix_spawnattr_destroy(&attributes) }
  guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0 else { throw Fd199Error.invalidState }
  var pid: pid_t = 0
  let result = argv.withUnsafeBufferPointer { args in
    env.withUnsafeBufferPointer { environment in
      posix_spawn(&pid, node, &actions, &attributes, args.baseAddress!, environment.baseAddress!)
    }
  }
  guard result == 0 else { throw Fd199Error.invalidState }
  return pid
}

private func reapPeer(_ pid: pid_t) throws {
  let deadline = DispatchTime.now().uptimeNanoseconds + 120_000_000_000
  while DispatchTime.now().uptimeNanoseconds < deadline {
    var status: Int32 = 0
    let result = waitpid(pid, &status, WNOHANG)
    if result == pid {
      guard status == 0 else { throw Fd199Error.invalidState }
      return
    }
    if result < 0 { throw Fd199Error.invalidState }
    usleep(2_000)
  }
  kill(pid, SIGKILL)
  var status: Int32 = 0
  _ = waitpid(pid, &status, 0)
  throw Fd199Error.invalidState
}

@Test("real TypeScript peer streams UTF-8 history and activates only after process reap", .enabled(if: ProcessInfo.processInfo.environment["DSH_FD199_NODE_FIXTURE"] != nil, "Set DSH_FD199_NODE and DSH_FD199_NODE_FIXTURE for the real-peer integration gate"))
func crossLanguageStreamAndActivation() throws {
  let node = try #require(ProcessInfo.processInfo.environment["DSH_FD199_NODE"])
  let fixture = try #require(ProcessInfo.processInfo.environment["DSH_FD199_NODE_FIXTURE"])
  let root = try makeJournalRoot()
  defer { try? FileManager.default.removeItem(atPath: root) }
  let identity = try Fd199StaticSigningIdentity()
  let journal = try Fd199Journal(root: root, identity: identity)
  var expectedHash = SHA256()
  expectedHash.update(data: Data("{\"text\":\"".utf8))
  let emojiBatch = Data(String(repeating: "🙂", count: 27_000).utf8)
  for _ in 0..<100 { expectedHash.update(data: emojiBatch) }
  expectedHash.update(data: Data("\"}\n".utf8))
  let small = Data("{\"text\":\"small\"}\n".utf8)
  let expected = [
    Fd199ManifestEntry(name: "sessions/large_session.jsonl", sha256: Data(expectedHash.finalize()).hexString, size: 10_800_012),
    Fd199ManifestEntry(name: "sessions/small_session.jsonl", sha256: Data(SHA256.hash(data: small)).hexString, size: small.count),
  ]
  for mode in ["export", "activate"] {
    let (host, peer) = try authoritySocketPair()
    let service = Fd199AuthorityService(identity: identity, hostAppPath: "/Applications/DSHHost.app", journal: journal, channel: host)
    service.serve()
    defer { service.stop() }
    let pid = try spawnTypeScriptPeer(node: node, fixture: fixture, mode: mode, descriptor: peer.fileDescriptor)
    try peer.close()
    do {
      try waitFor { service.hasRecovered && (mode == "activate" || service.hasDesktopReady) }
      try service.instruct(mode == "export" ? .prepare : .activate)
    } catch {
      kill(pid, SIGKILL)
      var status: Int32 = 0
      _ = waitpid(pid, &status, 0)
      throw error
    }
    try reapPeer(pid)
    let recovered = try #require(try Fd199Journal(root: root, identity: identity).recoverVerified())
    #expect(recovered.manifest == expected)
    #expect(recovered.version == 3)
    if mode == "export" {
      #expect(recovered.status == .releasing)
      try service.promoteReapedReleaseToPrepared()
      #expect(try journal.recoverVerified()?.status == .prepared)
    } else {
      #expect(recovered.status == .activated)
      #expect(recovered.generation == 1)
    }
  }
}
