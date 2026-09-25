import Darwin
import Foundation
import RemoteHostRuntimeBootstrap
import RemoteHostWire
import Security

/** The only public effects the sealed gateway can request from its Host owner. */
public enum RelaySealedGatewayOutput: Equatable, Sendable {
  /** The embedded gateway has accepted its single inherited descriptor. */
  case ready
  /** Write one opaque application frame to the connection named by UTF-8 metadata. */
  case send(metadata: Data, payload: Data)
  /** Close the connection named by UTF-8 metadata. */
  case close(metadata: Data)
}

/** Closed failures for the fail-closed sealed gateway supervisor. */
public enum RelaySealedGatewaySupervisorError: Error, Equatable, Sendable {
  case unavailable
  case invalidState
  case invalidConnectionEvent
}

/**
 Launches only a bundle-attested Node gateway and owns both directions of FD198.

 This type deliberately exposes four Host facts and three gateway effects, rather
 than a generic Remote Wire method. It never opens a relay socket, reads a route
 credential, or starts itself as part of Host startup.
 */
public final class RelaySealedGatewaySupervisor: @unchecked Sendable {
  /** The sealed child receives no inherited environment variables. */
  static let privateRuntimeEnvironment: [String] = []
  private static let maximumBufferedBytes = (RemoteWire.maximumRecordBytes + 4) * 2
  static let maximumOutputsPerRead = 256
  static let maximumPendingWrites = 64
  private static let maximumPendingWriteBytes = RemoteWire.maximumRecordBytes + 4

  private struct PendingWrite {
    let bytes: Data
    var offset = 0
  }

  private let lock = NSLock()
  private let readyWaitMilliseconds: Int32
  private let output: @Sendable (RelaySealedGatewayOutput) -> Void
  private let terminateChild: ChildProcessTerminator.Operation
  private var channel: FileHandle?
  private var childPID: pid_t = 0
  private var buffer = Data()
  private var pendingWrites: [PendingWrite] = []
  private var pendingWriteBytes = 0
  private var writeSource: DispatchSourceWrite?
  private var didReceiveReady = false
  private var starting = false
  private var stopped = false

  /** Creates an inert supervisor. Call `start()` only after an explicit activation review. */
  public init(onOutput: @escaping @Sendable (RelaySealedGatewayOutput) -> Void) {
    self.readyWaitMilliseconds = 5_000
    self.output = onOutput
    self.terminateChild = { pid, onReaped in
      ChildProcessTerminator.terminateAndContinue(pid, onReaped: onReaped)
    }
  }

  /** Internal FD seam for deterministic tests; it cannot launch an arbitrary executable. */
  init(
    testChannel: FileHandle,
    testChildPID: pid_t = 0,
    readyWaitMilliseconds: Int32 = 100,
    terminateChild: @escaping ChildProcessTerminator.Operation = { pid, onReaped in
      ChildProcessTerminator.terminateAndContinue(pid, onReaped: onReaped)
    },
    onOutput: @escaping @Sendable (RelaySealedGatewayOutput) -> Void
  ) {
    precondition(readyWaitMilliseconds > 0)
    self.readyWaitMilliseconds = readyWaitMilliseconds
    self.output = onOutput
    self.terminateChild = terminateChild
    lock.lock()
    childPID = testChildPID
    installLocked(channel: testChannel)
    lock.unlock()
  }

  deinit {
    lock.lock()
    stopLocked()
    lock.unlock()
  }

  /**
   Validates the signed Host and its fixed Node/entrypoint manifest before spawning
   exactly that embedded Node with `--private-fd 198`.
   */
  public func start() throws {
    lock.lock()
    guard channel == nil, !starting, !stopped else {
      lock.unlock()
      throw RelaySealedGatewaySupervisorError.invalidState
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

    let artifacts: RemoteHostV3SealedGatewayArtifacts
    do {
      _ = try RelaySignedHostActivationConfiguration.validateRunningHost()
      artifacts = try RemoteHostV3SealedGatewayPackaging.loadAndValidateBundledArtifacts()
    } catch {
      throw RelaySealedGatewaySupervisorError.unavailable
    }

    var descriptors: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
      throw RelaySealedGatewaySupervisorError.unavailable
    }
    let parentDescriptor = descriptors[0]
    let childDescriptor = descriptors[1]
    guard fcntl(parentDescriptor, F_SETFD, FD_CLOEXEC) != -1 else {
      close(parentDescriptor)
      close(childDescriptor)
      throw RelaySealedGatewaySupervisorError.unavailable
    }
    var noSigPipe: Int32 = 1
    guard setsockopt(parentDescriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
      close(parentDescriptor)
      close(childDescriptor)
      throw RelaySealedGatewaySupervisorError.unavailable
    }

    let pid: pid_t
    do {
      pid = try spawn(artifacts: artifacts, childDescriptor: childDescriptor)
    } catch {
      close(parentDescriptor)
      close(childDescriptor)
      throw error
    }
    guard validateSuspendedNode(pid: pid, requirement: artifacts.nodeRequirement) else {
      terminate(pid)
      close(parentDescriptor)
      close(childDescriptor)
      throw RelaySealedGatewaySupervisorError.unavailable
    }
    guard kill(pid, SIGCONT) == 0 else {
      terminate(pid)
      close(parentDescriptor)
      close(childDescriptor)
      throw RelaySealedGatewaySupervisorError.unavailable
    }
    close(childDescriptor)
    let parent = FileHandle(fileDescriptor: parentDescriptor, closeOnDealloc: true)
    lock.lock()
    guard channel == nil, starting, !stopped else {
      lock.unlock()
      parent.closeFile()
      terminate(pid)
      throw RelaySealedGatewaySupervisorError.unavailable
    }
    childPID = pid
    installLocked(channel: parent)
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
        throw RelaySealedGatewaySupervisorError.unavailable
      }
      usleep(1_000)
    }
  }

  /** Forwards the fixed public `connection.open` fact after the gateway is ready. */
  public func connectionOpened(metadata: Data) throws {
    try sendPublicRecord(RemoteWireRecord(kind: .connectionOpen, metadata: metadata))
  }

  /** Forwards one fixed public `connection.frame` fact after the gateway is ready. */
  public func connectionFrame(metadata: Data, payload: Data) throws {
    try sendPublicRecord(RemoteWireRecord(kind: .connectionFrame, metadata: metadata, payload: payload))
  }

  /** Forwards the fixed public `connection.closed` fact after the gateway is ready. */
  public func connectionClosed(metadata: Data) throws {
    try sendPublicRecord(RemoteWireRecord(kind: .connectionClosed, metadata: metadata))
  }

  /** Sends `host.stopping` if possible, then closes FD198 and reaps the sealed child. */
  public func stop() {
    lock.lock()
    guard !stopped else {
      lock.unlock()
      return
    }
    if didReceiveReady, channel != nil {
      let record = RemoteWireRecord(kind: .hostStopping)
      if validatePublicRecord(record), let encoded = try? RemoteWire.encode(record) { _ = enqueueLocked(encoded) }
    }
    stopLocked()
    lock.unlock()
  }

  private func sendPublicRecord(_ record: RemoteWireRecord) throws {
    guard validatePublicRecord(record) else { throw RelaySealedGatewaySupervisorError.invalidConnectionEvent }
    let encoded: Data
    do {
      try RemoteHostV3GatewayBootstrap.validate(record, direction: .hostToGateway)
      encoded = try RemoteWire.encode(record)
    } catch {
      throw RelaySealedGatewaySupervisorError.invalidConnectionEvent
    }
    lock.lock()
    defer { lock.unlock() }
    guard didReceiveReady, !stopped, channel != nil else {
      throw RelaySealedGatewaySupervisorError.unavailable
    }
    guard enqueueLocked(encoded) else {
      stopLocked()
      throw RelaySealedGatewaySupervisorError.unavailable
    }
  }

  private func validatePublicRecord(_ record: RemoteWireRecord) -> Bool {
    switch record.kind {
    case .connectionOpen, .connectionClosed:
      return record.payload.isEmpty
    case .connectionFrame:
      return true
    case .hostStopping:
      return record.metadata.isEmpty && record.payload.isEmpty
    case .runtimeReady, .routeUpsert, .routeRevoked, .epochBegin, .epochBegun, .epochCommit, .epochCommitted, .connectionSend, .connectionClose, .deviceEnroll, .deviceEnrolled, .enrollmentSeed, .epochSynchronize, .epochSynchronized:
      return false
    }
  }

  private func installLocked(channel: FileHandle) {
    guard makeNonblocking(channel.fileDescriptor) else {
      stopped = true
      channel.closeFile()
      return
    }
    self.channel = channel
    channel.readabilityHandler = { [weak self] handle in
      self?.receiveAvailable(handle)
    }
  }

  /** Queues one Host record without allowing a stalled child to block a Host caller. */
  private func enqueueLocked(_ encoded: Data) -> Bool {
    guard !stopped,
          pendingWrites.count < Self.maximumPendingWrites,
          encoded.count <= Self.maximumPendingWriteBytes - pendingWriteBytes
    else { return false }
    pendingWrites.append(PendingWrite(bytes: encoded))
    pendingWriteBytes += encoded.count
    return flushPendingWritesLocked()
  }

  /** The sole FD198 writer. EAGAIN retains a bounded queue and arms one writable callback. */
  private func flushPendingWritesLocked() -> Bool {
    guard let channel else { return false }
    let descriptor = channel.fileDescriptor
    while !pendingWrites.isEmpty {
      let index = pendingWrites.startIndex
      let pending = pendingWrites[index]
      let written = pending.bytes.withUnsafeBytes { bytes -> Int in
        guard let base = bytes.baseAddress else { return 0 }
        return Darwin.write(descriptor, base.advanced(by: pending.offset), pending.bytes.count - pending.offset)
      }
      if written > 0 {
        pendingWrites[index].offset += written
        pendingWriteBytes -= written
        if pendingWrites[index].offset == pendingWrites[index].bytes.count { pendingWrites.removeFirst() }
        continue
      }
      if written == -1 && (errno == EAGAIN || errno == EWOULDBLOCK) {
        armWriteSourceLocked(descriptor)
        return true
      }
      return false
    }
    writeSource?.cancel()
    writeSource = nil
    return true
  }

  private func armWriteSourceLocked(_ descriptor: Int32) {
    guard writeSource == nil else { return }
    let source = DispatchSource.makeWriteSource(fileDescriptor: descriptor, queue: .global())
    source.setEventHandler { [weak self] in
      self?.flushPendingWrites()
    }
    writeSource = source
    source.resume()
  }

  private func flushPendingWrites() {
    lock.lock()
    guard !stopped else {
      lock.unlock()
      return
    }
    guard flushPendingWritesLocked() else {
      stopLocked()
      lock.unlock()
      return
    }
    lock.unlock()
  }

  /** The sole FD198 reader. A malformed, oversized, or unexpected record stops the child. */
  private func receiveAvailable(_ handle: FileHandle) {
    let data = handle.availableData
    var outputs: [RelaySealedGatewayOutput] = []
    lock.lock()
    guard self.channel === handle, !stopped else {
      lock.unlock()
      return
    }
    guard !data.isEmpty, buffer.count <= Self.maximumBufferedBytes - data.count else {
      stopLocked()
      lock.unlock()
      return
    }
    buffer.append(data)
    do {
      while let record = try consumeOneLocked() {
        guard outputs.count < Self.maximumOutputsPerRead,
              let next = acceptGatewayRecordLocked(record)
        else {
          stopLocked()
          lock.unlock()
          return
        }
        outputs.append(next)
      }
    } catch {
      stopLocked()
      lock.unlock()
      return
    }
    lock.unlock()
    outputs.forEach(output)
  }

  /** Decodes one bounded record while retaining only a single incomplete record. */
  private func consumeOneLocked() throws -> RemoteWireRecord? {
    let lengthBytes = MemoryLayout<UInt32>.size
    guard buffer.count >= lengthBytes else { return nil }
    let bodyLength = buffer.prefix(lengthBytes).reduce(0) { ($0 << 8) | Int($1) }
    guard bodyLength >= 3, bodyLength <= RemoteWire.maximumRecordBytes else { throw RemoteWireError.malformed }
    let frameLength = lengthBytes + bodyLength
    guard buffer.count >= frameLength else { return nil }
    let frame = Data(buffer.prefix(frameLength))
    buffer.removeFirst(frameLength)
    return try RemoteWire.decode(frame)
  }

  /** Fixed gateway demultiplexing: `runtime.ready`, then only send or close requests. */
  private func acceptGatewayRecordLocked(_ record: RemoteWireRecord) -> RelaySealedGatewayOutput? {
    do { try RemoteHostV3GatewayBootstrap.validate(record, direction: .gatewayToHost) }
    catch { return nil }
    guard didReceiveReady else {
      guard record.kind == .runtimeReady, record.metadata.isEmpty, record.payload.isEmpty else { return nil }
      didReceiveReady = true
      return .ready
    }
    switch record.kind {
    case .connectionSend:
      return .send(metadata: record.metadata, payload: record.payload)
    case .connectionClose:
      guard record.payload.isEmpty else { return nil }
      return .close(metadata: record.metadata)
    case .runtimeReady, .routeUpsert, .routeRevoked, .epochBegin, .epochBegun, .epochCommit, .epochCommitted, .connectionOpen, .connectionFrame, .connectionClosed, .hostStopping, .deviceEnroll, .deviceEnrolled, .enrollmentSeed, .epochSynchronize, .epochSynchronized:
      return nil
    }
  }

  /** Called under lock after an FD failure, invalid record, or explicit stop. */
  private func stopLocked() {
    guard !stopped else { return }
    stopped = true
    channel?.readabilityHandler = nil
    channel?.closeFile()
    channel = nil
    writeSource?.cancel()
    writeSource = nil
    buffer.removeAll(keepingCapacity: false)
    pendingWrites.removeAll(keepingCapacity: false)
    pendingWriteBytes = 0
    didReceiveReady = false
    let pid = childPID
    guard pid > 0 else { return }
    let reaped = terminateChild(pid) { [weak self] in self?.releaseReapedChild(pid) }
    if reaped { childPID = 0 }
  }

  private func spawn(artifacts: RemoteHostV3SealedGatewayArtifacts, childDescriptor: Int32) throws -> pid_t {
    var actions: posix_spawn_file_actions_t? = nil
    guard posix_spawn_file_actions_init(&actions) == 0 else { throw RelaySealedGatewaySupervisorError.unavailable }
    defer { posix_spawn_file_actions_destroy(&actions) }
    let privateDescriptor = RemoteHostV3GatewayBootstrap.privateDescriptor
    guard posix_spawn_file_actions_adddup2(&actions, childDescriptor, privateDescriptor) == 0 else {
      throw RelaySealedGatewaySupervisorError.unavailable
    }
    for descriptor in 0..<getdtablesize() where descriptor != Int(privateDescriptor) {
      let candidate = Int32(descriptor)
      guard fcntl(candidate, F_GETFD) != -1 || errno != EBADF else { continue }
      guard posix_spawn_file_actions_addclose(&actions, candidate) == 0 else {
        throw RelaySealedGatewaySupervisorError.unavailable
      }
    }
    var attributes: posix_spawnattr_t? = nil
    guard posix_spawnattr_init(&attributes) == 0 else { throw RelaySealedGatewaySupervisorError.unavailable }
    defer { posix_spawnattr_destroy(&attributes) }
    guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_START_SUSPENDED)) == 0 else {
      throw RelaySealedGatewaySupervisorError.unavailable
    }
    let arguments = [artifacts.nodeExecutable.path, artifacts.gatewayEntrypoint.path] + RemoteHostV3GatewayBootstrap.privateRuntimeArguments
    var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) }
    argv.append(nil)
    defer { argv.forEach { if let pointer = $0 { free(pointer) } } }
    var environment: [UnsafeMutablePointer<CChar>?] = Self.privateRuntimeEnvironment.map { strdup($0) }
    environment.append(nil)
    defer { environment.forEach { if let pointer = $0 { free(pointer) } } }
    var pid: pid_t = 0
    let status = artifacts.nodeExecutable.path.withCString { executable in
      posix_spawn(&pid, executable, &actions, &attributes, &argv, &environment)
    }
    guard status == 0 else { throw RelaySealedGatewaySupervisorError.unavailable }
    return pid
  }

  /** Verifies the image selected by the kernel before its first instruction can read FD198. */
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

  private func makeNonblocking(_ descriptor: Int32) -> Bool {
    let flags = fcntl(descriptor, F_GETFL)
    guard flags != -1 else { return false }
    return fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) != -1
  }

  var isReadyForTesting: Bool {
    lock.lock()
    defer { lock.unlock() }
    return didReceiveReady && !stopped
  }

  var isStoppedForTesting: Bool {
    lock.lock()
    defer { lock.unlock() }
    return stopped
  }

  var childPIDForTesting: pid_t {
    lock.lock()
    defer { lock.unlock() }
    return childPID
  }
}
