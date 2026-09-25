import Darwin
import Foundation
import RemoteHostRuntimeBootstrap
import RemoteHostWire
import Security

/**
 * Owns the signed private runtime and is the sole reader and writer of FD198.
 * It exposes only an opaque typed enrollment capability to the local pairing
 * composition. It has no route, token, signing, or generic runtime RPC API.
 */
public final class RelayPrivateRuntimeSupervisor: @unchecked Sendable, RelayRuntimeEnrollmentReceiptProvider {
  /// The private runtime needs no ambient configuration or credentials.
  static let privateRuntimeEnvironment: [String] = []
  private final class PendingEnrollment {
    let completion = DispatchSemaphore(value: 0)
    let device: RelayEnrollmentDevice
    let deadline: UInt64
    var result: Result<RemoteWireRecord, RelayEnrollmentError>?
    init(device: RelayEnrollmentDevice, deadline: UInt64) {
      self.device = device
      self.deadline = deadline
    }
  }

  private let lock = NSLock()
  private let waitMilliseconds: Int32
  private let terminateChild: ChildProcessTerminator.Operation
  private var channel: FileHandle?
  private var childPID: pid_t = 0
  private var buffer = Data()
  private var didReceiveRuntimeReady = false
  private var pendingEnrollment: PendingEnrollment?
  private var starting = false
  private var stopped = false

  /** Production uses a fixed five-second receipt deadline. */
  public init() {
    self.waitMilliseconds = 5_000
    self.terminateChild = { pid, onReaped in
      ChildProcessTerminator.terminateAndContinue(pid, onReaped: onReaped)
    }
  }

  /** Internal socketpair seam for deterministic supervisor tests. */
  init(
    testChannel: FileHandle,
    testChildPID: pid_t = 0,
    waitMilliseconds: Int32,
    terminateChild: @escaping ChildProcessTerminator.Operation = { pid, onReaped in
      ChildProcessTerminator.terminateAndContinue(pid, onReaped: onReaped)
    }
  ) {
    self.waitMilliseconds = waitMilliseconds
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

  /** Starts only the verified private runtime. It does not construct pairing or provision a route. */
  public func start() throws {
    lock.lock()
    guard channel == nil, !stopped, !starting else { lock.unlock(); throw RelayEnrollmentError.unavailable }
    starting = true
    lock.unlock()
    var started = false
    defer {
      if !started { lock.lock(); starting = false; lock.unlock() }
    }
    // Strict bundle validation happens before RuntimeMetadata is read so a
    // mutable resource can never choose the executable/requirement chain.
    _ = try RelaySignedHostActivationConfiguration.validateRunningHost()
    let runtime = try verifiedRuntime()
    var descriptors: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw RelayEnrollmentError.unavailable }
    let parentDescriptor = descriptors[0]
    let childDescriptor = descriptors[1]
    guard fcntl(parentDescriptor, F_SETFD, FD_CLOEXEC) != -1 else {
      close(parentDescriptor); close(childDescriptor)
      throw RelayEnrollmentError.unavailable
    }
    var noSigPipe: Int32 = 1
    guard setsockopt(parentDescriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
      close(parentDescriptor); close(childDescriptor)
      throw RelayEnrollmentError.unavailable
    }
    let pid: pid_t
    do { pid = try spawn(runtime: runtime, childDescriptor: childDescriptor) }
    catch {
      close(parentDescriptor); close(childDescriptor)
      throw error
    }
    close(childDescriptor)
    let parent = FileHandle(fileDescriptor: parentDescriptor, closeOnDealloc: true)
    lock.lock()
    guard channel == nil, !stopped, starting else {
      lock.unlock(); parent.closeFile(); terminate(pid)
      throw RelayEnrollmentError.unavailable
    }
    childPID = pid
    installLocked(channel: parent)
    starting = false
    started = true
    lock.unlock()
  }

  /**
   * Returns the opaque typed receipt capability after a verified supervisor has
   * taken FD198 ownership. The raw descriptor never leaves this module.
   */
  func enrollmentExchange() throws -> RelayFD198EnrollmentExchange {
    lock.lock(); defer { lock.unlock() }
    guard channel != nil, !stopped else { throw RelayEnrollmentError.unavailable }
    return RelayFD198EnrollmentExchange(provider: self)
  }

  /** Bounded startup fence used before any signed-Host composition is constructed. */
  public func waitUntilReady() throws {
    let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(waitMilliseconds) * 1_000_000
    while true {
      lock.lock()
      let ready = didReceiveRuntimeReady
      let unavailable = stopped
      lock.unlock()
      if ready { return }
      if unavailable || DispatchTime.now().uptimeNanoseconds >= deadline {
        lock.lock()
        if !didReceiveRuntimeReady { stopLocked() }
        lock.unlock()
        throw RelayEnrollmentError.unavailable
      }
      usleep(1_000)
    }
  }

  func enrollOverVerifiedRuntime(_ device: RelayEnrollmentDevice) throws -> RemoteWireRecord {
    let request = try RelayEnrollmentWireCodec.enroll(device)
    let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(waitMilliseconds) * 1_000_000
    let pending = PendingEnrollment(device: device, deadline: deadline)
    let channel: FileHandle
    lock.lock()
    guard !stopped, didReceiveRuntimeReady, pendingEnrollment == nil, let ownedChannel = self.channel else {
      lock.unlock()
      throw RelayEnrollmentError.unavailable
    }
    pendingEnrollment = pending
    channel = ownedChannel
    lock.unlock()

    do {
      try channel.write(contentsOf: RemoteWire.encode(request))
    } catch {
      lock.lock()
      if pendingEnrollment === pending { stopLocked() }
      lock.unlock()
      throw RelayEnrollmentError.unavailable
    }

    let remainingNanoseconds = deadline - min(deadline, DispatchTime.now().uptimeNanoseconds)
    guard pending.completion.wait(timeout: .now() + .nanoseconds(Int(remainingNanoseconds))) == .success else {
      lock.lock()
      if pendingEnrollment === pending { stopLocked() }
      lock.unlock()
      throw RelayEnrollmentError.unavailable
    }
    lock.lock(); defer { lock.unlock() }
    guard let result = pending.result else { throw RelayEnrollmentError.unavailable }
    return try result.get()
  }

  private func installLocked(channel: FileHandle) {
    self.channel = channel
    channel.readabilityHandler = { [weak self] handle in self?.receiveAvailable(handle) }
  }

  /** The sole FD198 reader. It retains partial frames until complete. */
  private func receiveAvailable(_ handle: FileHandle) {
    let data = handle.availableData
    lock.lock(); defer { lock.unlock() }
    guard self.channel === handle, !stopped else { return }
    guard !data.isEmpty else { stopLocked(); return }
    buffer.append(data)
    do {
      let records = try RemoteWire.consume(&buffer)
      if records.isEmpty, !buffer.isEmpty, didReceiveRuntimeReady, pendingEnrollment == nil { stopLocked(); return }
      guard records.count <= 1, records.isEmpty || buffer.isEmpty else { stopLocked(); return }
      guard let record = records.first else { return }
      guard acceptLocked(record) else { stopLocked(); return }
    } catch {
      stopLocked()
    }
  }

  /** The fixed runtime demux: ready first, then exactly one pending enrollment receipt. */
  private func acceptLocked(_ record: RemoteWireRecord) -> Bool {
    guard didReceiveRuntimeReady else {
      guard record.kind == .runtimeReady, record.metadata.isEmpty, record.payload.isEmpty else { return false }
      didReceiveRuntimeReady = true
      return true
    }
    guard record.kind == .deviceEnrolled,
          record.payload.isEmpty,
          let pending = pendingEnrollment,
          DispatchTime.now().uptimeNanoseconds < pending.deadline,
          let enrolled = try? RelayEnrollmentWireCodec.enrolled(record, enrolledAt: receiptValidationInstant()),
          enrolled.deviceId == pending.device.deviceId,
          enrolled.label == pending.device.label,
          enrolled.signingPublicKey == pending.device.signingPublicKey,
          enrolled.agreementPublicKey == pending.device.agreementPublicKey
    else { return false }
    pendingEnrollment = nil
    pending.result = .success(record)
    pending.completion.signal()
    return true
  }

  /** Called under lock for malformed data, unexpected frames, timeouts, EOF, and teardown. */
  private func stopLocked() {
    guard !stopped else { return }
    stopped = true
    channel?.readabilityHandler = nil
    channel?.closeFile()
    channel = nil
    buffer.removeAll(keepingCapacity: false)
    didReceiveRuntimeReady = false
    if let pending = pendingEnrollment {
      pendingEnrollment = nil
      pending.result = .failure(.unavailable)
      pending.completion.signal()
    }
    let pid = childPID
    guard pid > 0 else { return }
    let reaped = terminateChild(pid) { [weak self] in self?.releaseReapedChild(pid) }
    if reaped { childPID = 0 }
  }

  private struct RuntimeMetadata: Decodable {
    let requirement: String
    let relativeExecutablePath: String
  }

  private func verifiedRuntime() throws -> URL {
    let bundle = Bundle.main
    guard let resource = bundle.resourceURL,
          let metadataURL = bundle.url(forResource: "RuntimeMetadata", withExtension: "plist"),
          let data = try? Data(contentsOf: metadataURL),
          let metadata = try? PropertyListDecoder().decode(RuntimeMetadata.self, from: data),
          !metadata.requirement.isEmpty,
          metadata.relativeExecutablePath == "Runtime/dsh-remote-host-runtime"
    else { throw RelayEnrollmentError.unavailable }
    let root = resource.resolvingSymlinksInPath().path + "/"
    let runtime = resource.appendingPathComponent(metadata.relativeExecutablePath).resolvingSymlinksInPath()
    guard runtime.path.hasPrefix(root) else { throw RelayEnrollmentError.unavailable }
    var requirement: SecRequirement?
    var code: SecStaticCode?
    guard SecRequirementCreateWithString(metadata.requirement as CFString, [], &requirement) == errSecSuccess,
          let requirement,
          SecStaticCodeCreateWithPath(runtime as CFURL, [], &code) == errSecSuccess,
          let code,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess
    else { throw RelayEnrollmentError.unavailable }
    return runtime
  }

  private func spawn(runtime: URL, childDescriptor: Int32) throws -> pid_t {
    var actions: posix_spawn_file_actions_t? = nil
    guard posix_spawn_file_actions_init(&actions) == 0 else { throw RelayEnrollmentError.unavailable }
    defer { posix_spawn_file_actions_destroy(&actions) }
    guard posix_spawn_file_actions_adddup2(&actions, childDescriptor, RemoteHostV3GatewayBootstrap.privateDescriptor) == 0 else { throw RelayEnrollmentError.unavailable }
    for descriptor in 0..<getdtablesize() where descriptor != Int(RemoteHostV3GatewayBootstrap.privateDescriptor) {
      let candidate = Int32(descriptor)
      guard fcntl(candidate, F_GETFD) != -1 || errno != EBADF else { continue }
      guard posix_spawn_file_actions_addclose(&actions, candidate) == 0 else { throw RelayEnrollmentError.unavailable }
    }
    var attributes: posix_spawnattr_t? = nil
    guard posix_spawnattr_init(&attributes) == 0 else { throw RelayEnrollmentError.unavailable }
    defer { posix_spawnattr_destroy(&attributes) }
    let arguments = [runtime.path] + RemoteHostV3GatewayBootstrap.privateRuntimeArguments
    var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) }
    argv.append(nil)
    defer { argv.forEach { if let pointer = $0 { free(pointer) } } }
    var environment: [UnsafeMutablePointer<CChar>?] = Self.privateRuntimeEnvironment.map { strdup($0) }
    environment.append(nil)
    defer { environment.forEach { if let pointer = $0 { free(pointer) } } }
    var pid: pid_t = 0
    let status = runtime.path.withCString { path in posix_spawn(&pid, path, &actions, &attributes, &argv, &environment) }
    guard status == 0 else { throw RelayEnrollmentError.unavailable }
    return pid
  }

  private func terminate(_ pid: pid_t) {
    _ = terminateChild(pid) {}
  }

  private func releaseReapedChild(_ pid: pid_t) {
    lock.lock()
    if childPID == pid { childPID = 0 }
    lock.unlock()
  }

  var isStoppedForTesting: Bool {
    lock.lock(); defer { lock.unlock() }
    return stopped
  }

  var isReadyForTesting: Bool {
    lock.lock(); defer { lock.unlock() }
    return didReceiveRuntimeReady && !stopped
  }

  var childPIDForTesting: pid_t {
    lock.lock(); defer { lock.unlock() }
    return childPID
  }
}

private func receiptValidationInstant() -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: Date())
}
