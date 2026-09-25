import Darwin
import Foundation
import RemoteHostFd199
import RemoteHostRuntimeBootstrap
import RemoteHostWire
import Security

/** Closed failures for the fail-closed hosted child supervisor. */
public enum Fd199HostedChildSupervisorError: Error, Equatable, Sendable {
  case unavailable
  case invalidState
}

/**
 Launches only a bundle-attested `dsh web` child and owns both private
 channels: descriptor 198 carries the V3 relay wire in both directions while
 descriptor 199's parent end is returned once for the ownership authority.

 Like the sealed gateway supervisor, this type never opens a relay socket,
 reads a route credential, or starts itself as part of Host startup.
 */
public final class Fd199HostedChildSupervisor: Fd199AuthorityChannelProviding, @unchecked Sendable {
  public var isClosed: Bool {
    lock.lock()
    defer { lock.unlock() }
    return stopped
  }

  public func setOutputHandler(_ handler: @escaping @Sendable (Fd199HostedChildOutput) -> Void) {
    lock.lock()
    output = handler
    lock.unlock()
  }

  public func sendPublicRecord(metadata: Data, payload: Data) throws {
    try sendPublicRecord(RemoteWireRecord(kind: .connectionFrame, metadata: metadata, payload: payload))
  }

  /** The hosted child receives no inherited environment variables. */
  static let privateEnvironment: [String] = []
  static let relayDescriptor: Int32 = 198
  static let authorityDescriptor: Int32 = 199
  /// Required before the bundled Web entry mounts its post-bind HMR service.
  /// Keep this fixed rather than inheriting arbitrary caller Node options.
  static let nodeExecutionFlags = ["--expose-internals"]
  private static let maximumPendingWrites = 64
  private static let maximumBufferedBytes = (RemoteWire.maximumRecordBytes + 4) * 2

  private struct PendingWrite {
    let bytes: Data
    var offset = 0
  }

  private let lock = NSLock()
  /// All inbound reads, record decoding, and client output callbacks run on
  /// this one FIFO. Readability handlers can overlap, and dispatching after
  /// releasing `lock` would otherwise let a later callback overtake one that
  /// had already decoded earlier socket bytes.
  private let consumeQueue = DispatchQueue(label: "com.deepseek.dsh.fd199-hosted-child-consume")
  private let readyWaitMilliseconds: Int32
  private let terminateChild: ChildProcessTerminator.Operation
  private var hostedNodeModulesPath: String?
  private var hostedEntryRoot: String?
  private var dshHomePath: String?
  private var output: @Sendable (Fd199HostedChildOutput) -> Void
  private var channel: FileHandle?
  private var authorityChannel: FileHandle?
  private var childPID: pid_t = 0
  private var buffer = Data()
  private var pendingWrites: [PendingWrite] = []
  private var pendingWriteBytes = 0
  private var writeSource: DispatchSourceWrite?
  private var didReceiveReady = false
  private var starting = false
  private var stopped = false

  /**
   Creates an inert supervisor. Production accepts no external module or
   entry roots: the child resolves only sealed bundle resources.
   Call `start()` only after an explicit activation review.
   */
  public init(nodeModulesPath: String?, hostedEntryRoot: String? = nil, dshHomePath: String? = nil, onOutput: @escaping @Sendable (Fd199HostedChildOutput) -> Void) {
    self.readyWaitMilliseconds = 15_000
    self.hostedNodeModulesPath = nodeModulesPath
    self.hostedEntryRoot = hostedEntryRoot
    self.dshHomePath = dshHomePath
    self.output = onOutput
    self.terminateChild = { pid, onReaped in
      ChildProcessTerminator.terminateAndContinue(pid, onReaped: onReaped)
    }
  }

  /** Internal FD seam for deterministic tests; it cannot launch an arbitrary executable. */
  init(
    testRelayChannel: FileHandle,
    testAuthorityChannel: FileHandle,
    testChildPID: pid_t = 0,
    readyWaitMilliseconds: Int32 = 100,
    terminateChild: @escaping ChildProcessTerminator.Operation = { pid, onReaped in
      ChildProcessTerminator.terminateAndContinue(pid, onReaped: onReaped)
    },
    onOutput: @escaping @Sendable (Fd199HostedChildOutput) -> Void
  ) {
    self.hostedNodeModulesPath = nil
    self.dshHomePath = nil
    precondition(readyWaitMilliseconds > 0)
    self.readyWaitMilliseconds = readyWaitMilliseconds
    self.output = onOutput
    self.terminateChild = terminateChild
    lock.lock()
    childPID = testChildPID
    installLocked(relayChannel: testRelayChannel, authorityChannel: testAuthorityChannel)
    lock.unlock()
  }

  deinit {
    lock.lock()
    stopLocked()
    lock.unlock()
  }

  /**
   The parent end of the authority channel; exactly one owner (the FD199
   authority service) may take it, after which further calls return `nil`.
   */
  public func takeAuthorityChannel() -> FileHandle? {
    lock.lock()
    defer { lock.unlock() }
    let channel = authorityChannel
    authorityChannel = nil
    return channel
  }

  /**
   Validates the signed Host and the bundled hosted-child manifest before spawning
   exactly that embedded Node entry with the fixed two-descriptor contract.
   */
  public func start() throws {
    lock.lock()
    guard channel == nil, !starting, !stopped else {
      lock.unlock()
      throw Fd199HostedChildSupervisorError.invalidState
    }
    starting = true
    lock.unlock()
    var didStart = false
    defer {
      if !didStart {
        lock.lock()
        starting = false
        lock.unlock()
      }
    }

    let artifacts: RemoteHostV3HostedChildArtifacts
    do {
      guard hostedNodeModulesPath == nil, hostedEntryRoot == nil,
            let dshHomePath, dshHomePath.hasPrefix("/"), !dshHomePath.contains("..")
      else { throw Fd199HostedChildSupervisorError.unavailable }
      _ = try RelaySignedHostActivationConfiguration.validateRunningHost()
      artifacts = try RemoteHostV3HostedChildPackaging.loadAndValidateBundledArtifacts()
      guard artifacts.webConfiguration.dshHome == dshHomePath else { throw Fd199HostedChildSupervisorError.unavailable }
    } catch {
      throw Fd199HostedChildSupervisorError.unavailable
    }

    var relayDescriptors: [Int32] = [0, 0]
    var authorityDescriptors: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &relayDescriptors) == 0,
          socketpair(AF_UNIX, SOCK_STREAM, 0, &authorityDescriptors) == 0
    else {
      throw Fd199HostedChildSupervisorError.unavailable
    }
    let relayParent = relayDescriptors[0]
    let relayChild = relayDescriptors[1]
    let authorityParent = authorityDescriptors[0]
    let authorityChild = authorityDescriptors[1]
    for descriptor in [relayParent, authorityParent] where fcntl(descriptor, F_SETFD, FD_CLOEXEC) == -1 {
      closeAll(relayParent, relayChild, authorityParent, authorityChild)
      throw Fd199HostedChildSupervisorError.unavailable
    }
    var noSigPipe: Int32 = 1
    for descriptor in [relayParent, authorityParent] {
      guard setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
        closeAll(relayParent, relayChild, authorityParent, authorityChild)
        throw Fd199HostedChildSupervisorError.unavailable
      }
    }

    let pid: pid_t
    do {
      pid = try spawn(artifacts: artifacts, relayChild: relayChild, authorityChild: authorityChild)
    } catch {
      closeAll(relayParent, relayChild, authorityParent, authorityChild)
      throw error
    }
    guard validateSuspendedNode(pid: pid, requirement: artifacts.nodeRequirement) else {
      terminate(pid)
      closeAll(relayParent, relayChild, authorityParent, authorityChild)
      throw Fd199HostedChildSupervisorError.unavailable
    }
    guard kill(pid, SIGCONT) == 0 else {
      terminate(pid)
      closeAll(relayParent, relayChild, authorityParent, authorityChild)
      throw Fd199HostedChildSupervisorError.unavailable
    }
    close(relayChild)
    close(authorityChild)
    let relayHandle = FileHandle(fileDescriptor: relayParent, closeOnDealloc: true)
    let authorityHandle = FileHandle(fileDescriptor: authorityParent, closeOnDealloc: true)
    lock.lock()
    guard channel == nil, starting, !stopped else {
      lock.unlock()
      relayHandle.closeFile()
      authorityHandle.closeFile()
      terminate(pid)
      throw Fd199HostedChildSupervisorError.unavailable
    }
    childPID = pid
    installLocked(relayChannel: relayHandle, authorityChannel: authorityHandle)
    starting = false
    didStart = true
    lock.unlock()
  }

  /** Waits for the required first `runtime.ready` record and stops the child on expiry. */
  public func waitUntilReady() throws {
    let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(readyWaitMilliseconds) * 1_000_000
    while true {
      lock.lock()
      let ready = didReceiveReady
      let unavailable = stopped
      lock.unlock()
      if ready { return }
      if unavailable || DispatchTime.now().uptimeNanoseconds >= deadline {
        lock.lock()
        if !didReceiveReady { stopLocked() }
        lock.unlock()
        throw Fd199HostedChildSupervisorError.unavailable
      }
      usleep(1_000)
    }
  }

  /** Waits for the owned OS process to exit and reaps it before replacement. */
  public func waitUntilExited() throws {
    try waitUntilExited(timeoutMilliseconds: readyWaitMilliseconds)
  }

  /** Uses an explicit ownership-transfer budget without changing normal readiness. */
  public func waitUntilExited(timeoutMilliseconds: Int32) throws {
    guard timeoutMilliseconds > 0 else { throw Fd199HostedChildSupervisorError.invalidState }
    let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeoutMilliseconds) * 1_000_000
    while true {
      lock.lock()
      let pid = childPID
      lock.unlock()
      guard pid > 0 else { return }
      var status: Int32 = 0
      let result = waitpid(pid, &status, WNOHANG)
      if result == pid || (result == -1 && errno == ECHILD) {
        lock.lock()
        if childPID == pid { childPID = 0 }
        lock.unlock()
        return
      }
      if result == -1 || DispatchTime.now().uptimeNanoseconds >= deadline {
        throw Fd199HostedChildSupervisorError.unavailable
      }
      usleep(1_000)
    }
  }

  /** Sends one public record into the child's relay wire after it is ready. */
  public func sendPublicRecord(_ record: RemoteWireRecord) throws {
    try sendRecord(record)
  }

  /** Sends `host.stopping`, then closes both channels and reaps the child. */
  public func stop() {
    lock.lock()
    guard !stopped else {
      lock.unlock()
      return
    }
    if didReceiveReady {
      try? sendRecordLocked(RemoteWireRecord(kind: .hostStopping))
    }
    stopLocked()
    lock.unlock()
  }

  // MARK: - Channel plumbing

  private func installLocked(relayChannel: FileHandle, authorityChannel: FileHandle) {
    self.channel = relayChannel
    self.authorityChannel = authorityChannel
    relayChannel.readabilityHandler = { [weak self] handle in
      guard let self else {
        handle.readabilityHandler = nil
        return
      }
      let data = handle.availableData
      self.consumeQueue.async { self.consume(data) }
    }
  }

  private func consume(_ chunk: Data) {
    lock.lock()
    if stopped {
      lock.unlock()
      return
    }
    if chunk.isEmpty {
      stopLocked()
      lock.unlock()
      return
    }
    if buffer.count + chunk.count > Self.maximumBufferedBytes {
      buffer.removeAll(keepingCapacity: false)
      stopLocked()
      lock.unlock()
      return
    }
    buffer.append(chunk)
    var records: [RemoteWireRecord] = []
    do {
      records = try RemoteWire.consume(&buffer)
    } catch {
      buffer.removeAll(keepingCapacity: false)
      stopLocked()
      lock.unlock()
      return
    }
    lock.unlock()

    var outputs: [Fd199HostedChildOutput] = []
    for record in records {
      switch record.kind {
      case .runtimeReady:
        lock.lock()
        didReceiveReady = true
        lock.unlock()
        outputs.append(.ready)
      case .connectionSend:
        outputs.append(.send(metadata: record.metadata, payload: record.payload))
      case .connectionClose:
        outputs.append(.close(metadata: record.metadata))
      case .deviceEnrolled:
        outputs.append(.deviceEnrolled(metadata: record.metadata))
      case .epochSynchronized:
        outputs.append(.epochSynchronized(metadata: record.metadata, payload: record.payload))
      default:
        continue
      }
    }
    outputs.forEach(output)
  }

  private func sendRecord(_ record: RemoteWireRecord) throws {
    lock.lock()
    defer { lock.unlock() }
    try sendRecordLocked(record)
  }

  private func sendRecordLocked(_ record: RemoteWireRecord) throws {
    guard channel != nil, !stopped else { throw Fd199HostedChildSupervisorError.invalidState }
    let frame = try RemoteWire.encode(record)
    guard pendingWrites.count < Self.maximumPendingWrites,
          pendingWriteBytes + frame.count <= Self.maximumBufferedBytes
    else { throw Fd199HostedChildSupervisorError.invalidState }
    pendingWrites.append(PendingWrite(bytes: frame))
    pendingWriteBytes += frame.count
    flushLocked()
  }

  private func flushLocked() {
    guard let channel else { return }
    while !pendingWrites.isEmpty {
      let pending = pendingWrites[0]
      let written = pending.bytes.withUnsafeBytes { bytes -> Int in
        guard let base = bytes.baseAddress?.advanced(by: pending.offset) else { return -1 }
        return write(channel.fileDescriptor, base, pending.bytes.count - pending.offset)
      }
      if written < 0 {
        if errno == EINTR || errno == EAGAIN { return }
        stopLocked()
        return
      }
      pendingWrites[0].offset += written
      pendingWriteBytes -= written
      if pendingWrites[0].offset >= pending.bytes.count {
        pendingWrites.removeFirst()
      } else {
        armWriteSourceLocked()
        return
      }
    }
  }

  private func armWriteSourceLocked() {
    guard writeSource == nil, let channel else { return }
    let source = DispatchSource.makeWriteSource(fileDescriptor: channel.fileDescriptor)
    source.setEventHandler { [weak self] in
      guard let self else { return }
      self.lock.lock()
      self.writeSource = nil
      defer { self.lock.unlock() }
      self.flushLocked()
    }
    source.setCancelHandler { [weak self] in self?.writeSource = nil }
    source.resume()
    writeSource = source
  }

  private func stopLocked() {
    guard !stopped else { return }
    stopped = true
    channel?.readabilityHandler = nil
    writeSource?.cancel()
    writeSource = nil
    channel?.closeFile()
    authorityChannel?.closeFile()
    channel = nil
    authorityChannel = nil
    buffer.removeAll(keepingCapacity: false)
    pendingWrites.removeAll(keepingCapacity: false)
    pendingWriteBytes = 0
    didReceiveReady = false
    let pid = childPID
    guard pid > 0 else { return }
    let reaped = terminateChild(pid) { [weak self] in self?.releaseReapedChild(pid) }
    if reaped { childPID = 0 }
  }

  // MARK: - Spawn

  private func spawn(artifacts: RemoteHostV3HostedChildArtifacts, relayChild: Int32, authorityChild: Int32) throws -> pid_t {
    var actions: posix_spawn_file_actions_t? = nil
    guard posix_spawn_file_actions_init(&actions) == 0 else { throw Fd199HostedChildSupervisorError.unavailable }
    defer { posix_spawn_file_actions_destroy(&actions) }
    for (source, target) in [(relayChild, Self.relayDescriptor), (authorityChild, Self.authorityDescriptor)] {
      guard posix_spawn_file_actions_adddup2(&actions, source, target) == 0 else {
        throw Fd199HostedChildSupervisorError.unavailable
      }
    }
    for descriptor in 0..<getdtablesize() where descriptor != Int(Self.relayDescriptor) && descriptor != Int(Self.authorityDescriptor) {
      let candidate = Int32(descriptor)
      guard fcntl(candidate, F_GETFD) != -1 || errno != EBADF else { continue }
      guard posix_spawn_file_actions_addclose(&actions, candidate) == 0 else {
        throw Fd199HostedChildSupervisorError.unavailable
      }
    }
    var attributes: posix_spawnattr_t? = nil
    guard posix_spawnattr_init(&attributes) == 0 else { throw Fd199HostedChildSupervisorError.unavailable }
    defer { posix_spawnattr_destroy(&attributes) }
    guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_START_SUSPENDED)) == 0 else {
      throw Fd199HostedChildSupervisorError.unavailable
    }
    let patchPath = URL(fileURLWithPath: artifacts.webConfiguration.dshHome, isDirectory: true)
      .appendingPathComponent(artifacts.webConfiguration.patchRelativePath).path
    let arguments = [artifacts.nodeExecutable.path] + Self.nodeExecutionFlags + [
      artifacts.childEntrypoint.path,
      "web",
      "--patch", patchPath,
      "--port", String(artifacts.webConfiguration.port),
      "--trusted-host", artifacts.webConfiguration.trustedHost,
      "--private-relay-fd", "198",
      "--private-authority-fd", "199",
    ]
    var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) }
    argv.append(nil)
    defer { argv.forEach { if let pointer = $0 { free(pointer) } } }
    guard let dshHomePath else { throw Fd199HostedChildSupervisorError.unavailable }
    var environmentValues = Self.privateEnvironment
    environmentValues.append("DSH_HOME=\(dshHomePath)")
    environmentValues.append("DSH_HOSTED_PATCH_RELATIVE=\(artifacts.webConfiguration.patchRelativePath)")
    environmentValues.append("DSH_HOSTED_PATCH_SHA256=\(artifacts.webConfiguration.patchSHA256)")
    var environment: [UnsafeMutablePointer<CChar>?] = environmentValues.map { strdup($0) }
    environment.append(nil)
    defer { environment.forEach { if let pointer = $0 { free(pointer) } } }
    var pid: pid_t = 0
    let status = artifacts.nodeExecutable.path.withCString { executable in
      posix_spawn(&pid, executable, &actions, &attributes, &argv, &environment)
    }
    guard status == 0 else { throw Fd199HostedChildSupervisorError.unavailable }
    return pid
  }

  /** Verifies the image selected by the kernel before its first instruction can read either descriptor. */
  private func validateSuspendedNode(pid: pid_t, requirement: String) -> Bool {
    var expected: SecRequirement?
    guard SecRequirementCreateWithString(requirement as CFString, [], &expected) == errSecSuccess,
          let expected
    else { return false }
    var guest: SecCode?
    let attributes = [kSecGuestAttributePid: pid] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
          let guest
    else { return false }
    return SecCodeCheckValidity(guest, SecCSFlags(rawValue: kSecCSStrictValidate), expected) == errSecSuccess
  }

  private func terminate(_ pid: pid_t) {
    _ = terminateChild(pid) {}
  }

  private func releaseReapedChild(_ pid: pid_t) {
    lock.lock()
    if childPID == pid { childPID = 0 }
    lock.unlock()
  }

  private func closeAll(_ descriptors: Int32...) {
    descriptors.forEach { descriptor in close(descriptor) }
  }

  var childPIDForTesting: pid_t {
    lock.lock()
    defer { lock.unlock() }
    return childPID
  }
}
