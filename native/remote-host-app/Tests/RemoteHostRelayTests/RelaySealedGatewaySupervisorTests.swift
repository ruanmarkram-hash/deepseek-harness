import Darwin
import Foundation
import Testing
import RemoteHostFd199
@testable import RemoteHostRelay
@testable import RemoteHostWire

private final class GatewayOutputBox: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [RelaySealedGatewayOutput] = []

  func append(_ value: RelaySealedGatewayOutput) {
    lock.lock()
    values.append(value)
    lock.unlock()
  }

  func snapshot() -> [RelaySealedGatewayOutput] {
    lock.lock()
    defer { lock.unlock() }
    return values
  }
}

private final class HostedChildOutputBox: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [Fd199HostedChildOutput] = []

  func append(_ value: Fd199HostedChildOutput) {
    lock.lock()
    values.append(value)
    lock.unlock()
  }

  func snapshot() -> [Fd199HostedChildOutput] {
    lock.lock()
    defer { lock.unlock() }
    return values
  }
}

private final class DeferredTerminationBox: @unchecked Sendable {
  private let lock = NSLock()
  private var completions: [pid_t: @Sendable () -> Void] = [:]

  func retain(_ pid: pid_t, onReaped: @escaping @Sendable () -> Void) -> Bool {
    lock.lock()
    completions[pid] = onReaped
    lock.unlock()
    return false
  }

  func contains(_ pid: pid_t) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return completions[pid] != nil
  }

  func complete(_ pid: pid_t) {
    lock.lock()
    let completion = completions.removeValue(forKey: pid)
    lock.unlock()
    completion?()
  }
}

private final class DeferredReapProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var deferred = false
  private var scheduled: (@Sendable () -> Void)?
  private(set) var signals: [Int32] = []
  private(set) var completed = false

  func signal(_ value: Int32) -> Int32 {
    lock.lock()
    signals.append(value)
    lock.unlock()
    return 0
  }

  func wait() -> pid_t {
    lock.lock()
    defer { lock.unlock() }
    return deferred ? 42 : 0
  }

  func schedule(_ work: @escaping @Sendable () -> Void) {
    lock.lock()
    scheduled = work
    lock.unlock()
  }

  func runScheduled() {
    lock.lock()
    deferred = true
    let work = scheduled
    scheduled = nil
    lock.unlock()
    work?()
  }

  func markCompleted() {
    lock.lock()
    completed = true
    lock.unlock()
  }

  var hasScheduledWork: Bool {
    lock.lock()
    defer { lock.unlock() }
    return scheduled != nil
  }

  var snapshot: (signals: [Int32], completed: Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (signals, completed)
  }
}

private func gatewaySocketPair() throws -> (FileHandle, FileHandle) {
  var descriptors: [Int32] = [0, 0]
  guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
    throw RelaySealedGatewaySupervisorError.unavailable
  }
  var noSigPipe: Int32 = 1
  guard setsockopt(descriptors[1], SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
    close(descriptors[0])
    close(descriptors[1])
    throw RelaySealedGatewaySupervisorError.unavailable
  }
  return (
    FileHandle(fileDescriptor: descriptors[0], closeOnDealloc: true),
    FileHandle(fileDescriptor: descriptors[1], closeOnDealloc: true)
  )
}

private func reapingProbeChild() throws -> pid_t {
  var pid: pid_t = 0
  // SwiftPM's test helper can inherit an ignored SIGTERM disposition. Set
  // SIGTERM to default in the spawned image so this probe exercises the
  // supervisor's ordinary SIGTERM→waitpid reap path deterministically.
  var argv: [UnsafeMutablePointer<CChar>?] = [strdup("/bin/sleep"), strdup("60"), nil]
  defer { argv.forEach { if let value = $0 { free(value) } } }
  var environment: [UnsafeMutablePointer<CChar>?] = [nil]
  var attributes: posix_spawnattr_t? = nil
  guard posix_spawnattr_init(&attributes) == 0 else { throw Fd199HostedChildSupervisorError.unavailable }
  defer { posix_spawnattr_destroy(&attributes) }
  var defaults = sigset_t()
  sigemptyset(&defaults)
  sigaddset(&defaults, SIGTERM)
  var unblocked = sigset_t()
  sigemptyset(&unblocked)
  guard posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
        posix_spawnattr_setsigmask(&attributes, &unblocked) == 0,
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)) == 0
  else { throw Fd199HostedChildSupervisorError.unavailable }
  let status = "/bin/sleep".withCString { executable in
    posix_spawn(&pid, executable, nil, &attributes, &argv, &environment)
  }
  guard status == 0, pid > 0 else { throw Fd199HostedChildSupervisorError.unavailable }
  return pid
}

private func expectAlreadyReaped(_ pid: pid_t) {
  var status: Int32 = 0
  errno = 0
  #expect(waitpid(pid, &status, WNOHANG) == -1)
  #expect(errno == ECHILD)
}

private func waitForGateway(_ condition: () -> Bool) throws {
  let deadline = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
  while !condition(), DispatchTime.now().uptimeNanoseconds < deadline {
    usleep(1_000)
  }
  guard condition() else { throw RelaySealedGatewaySupervisorError.unavailable }
}

private func readGatewayRecord(_ runtime: FileHandle) throws -> RemoteWireRecord {
  var buffer = runtime.availableData
  let records = try RemoteWire.consume(&buffer)
  guard records.count == 1, buffer.isEmpty else { throw RelaySealedGatewaySupervisorError.unavailable }
  return records[0]
}

private func readyGateway(
  host: FileHandle,
  runtime: FileHandle,
  output: GatewayOutputBox
) throws -> RelaySealedGatewaySupervisor {
  let supervisor = RelaySealedGatewaySupervisor(testChannel: host, onOutput: output.append)
  try runtime.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .runtimeReady)))
  try waitForGateway { supervisor.isReadyForTesting }
  #expect(output.snapshot() == [.ready])
  return supervisor
}

@Test func sealedGatewaySupervisorMapsOnlyFixedPublicFactsAndGatewayEffects() throws {
  let (host, runtime) = try gatewaySocketPair()
  defer {
    host.closeFile()
    runtime.closeFile()
  }
  let output = GatewayOutputBox()
  let supervisor = try readyGateway(host: host, runtime: runtime, output: output)

  let connection = Data("{\"connectionId\":\"c-1\"}".utf8)
  try supervisor.connectionOpened(metadata: connection)
  #expect(try readGatewayRecord(runtime) == RemoteWireRecord(kind: .connectionOpen, metadata: connection))

  let frame = Data([1, 2, 3])
  try supervisor.connectionFrame(metadata: connection, payload: frame)
  #expect(try readGatewayRecord(runtime) == RemoteWireRecord(kind: .connectionFrame, metadata: connection, payload: frame))

  try supervisor.connectionClosed(metadata: connection)
  #expect(try readGatewayRecord(runtime) == RemoteWireRecord(kind: .connectionClosed, metadata: connection))

  try runtime.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .connectionSend, metadata: connection, payload: Data([4, 5]))))
  try waitForGateway { output.snapshot().count == 2 }
  #expect(output.snapshot() == [.ready, .send(metadata: connection, payload: Data([4, 5]))])

  try runtime.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .connectionClose, metadata: connection)))
  try waitForGateway { output.snapshot().count == 3 }
  #expect(output.snapshot() == [.ready, .send(metadata: connection, payload: Data([4, 5])), .close(metadata: connection)])

  supervisor.stop()
  #expect(try readGatewayRecord(runtime) == RemoteWireRecord(kind: .hostStopping))
  #expect(supervisor.isStoppedForTesting)
}

@Test func sealedGatewaySupervisorRejectsMalformedPublicEventsBeforeTheyReachFD198() throws {
  let (host, runtime) = try gatewaySocketPair()
  defer {
    host.closeFile()
    runtime.closeFile()
  }
  let output = GatewayOutputBox()
  let supervisor = try readyGateway(host: host, runtime: runtime, output: output)

  #expect(throws: RelaySealedGatewaySupervisorError.invalidConnectionEvent) {
    try supervisor.connectionOpened(metadata: Data([0xff]))
  }
  #expect(!supervisor.isStoppedForTesting)
  #expect(throws: RelaySealedGatewaySupervisorError.invalidConnectionEvent) {
    try supervisor.connectionFrame(metadata: Data("{}".utf8), payload: Data(repeating: 0, count: RemoteWire.maximumRecordBytes))
  }
  #expect(!supervisor.isStoppedForTesting)
}

@Test func sealedGatewaySupervisorFailsClosedOnOutOfOrderOrUnexpectedGatewayRecords() throws {
  let (host, runtime) = try gatewaySocketPair()
  defer {
    host.closeFile()
    runtime.closeFile()
  }
  let output = GatewayOutputBox()
  let supervisor = RelaySealedGatewaySupervisor(testChannel: host, onOutput: output.append)
  try runtime.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .connectionSend, metadata: Data("{}".utf8))))
  try waitForGateway { supervisor.isStoppedForTesting }
  #expect(output.snapshot().isEmpty)
}

@Test func sealedGatewaySupervisorReapsAnUnreadyGatewayAtItsBoundedStartupFence() throws {
  let (host, runtime) = try gatewaySocketPair()
  defer {
    host.closeFile()
    runtime.closeFile()
  }
  let output = GatewayOutputBox()
  let supervisor = RelaySealedGatewaySupervisor(testChannel: host, readyWaitMilliseconds: 1, onOutput: output.append)
  #expect(throws: RelaySealedGatewaySupervisorError.unavailable) {
    try supervisor.waitUntilReady()
  }
  #expect(supervisor.isStoppedForTesting)
  #expect(output.snapshot().isEmpty)
}

@Test func sealedGatewaySupervisorFailsClosedOnAConnectionClosePayload() throws {
  let (host, runtime) = try gatewaySocketPair()
  defer {
    host.closeFile()
    runtime.closeFile()
  }
  let output = GatewayOutputBox()
  let supervisor = try readyGateway(host: host, runtime: runtime, output: output)
  try runtime.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .connectionClose, metadata: Data("{}".utf8), payload: Data([1]))))
  try waitForGateway { supervisor.isStoppedForTesting }
}

@Test func sealedGatewaySupervisorBoundsAValidGatewayOutputBurstBeforeCallbackAllocation() throws {
  let (host, runtime) = try gatewaySocketPair()
  defer {
    host.closeFile()
    runtime.closeFile()
  }
  let output = GatewayOutputBox()
  let supervisor = try readyGateway(host: host, runtime: runtime, output: output)
  let record = try RemoteWire.encode(RemoteWireRecord(kind: .connectionSend, metadata: Data("{\"connectionId\":\"c-1\"}".utf8)))
  var burst = Data()
  for _ in 0...RelaySealedGatewaySupervisor.maximumOutputsPerRead {
    burst.append(record)
  }
  try runtime.write(contentsOf: burst)
  try waitForGateway { supervisor.isStoppedForTesting }
  #expect(output.snapshot() == [.ready])
}

@Test func sealedGatewaySupervisorFailsClosedWhenAStalledGatewayExhaustsTheBoundedWriteQueue() throws {
  let (host, runtime) = try gatewaySocketPair()
  defer {
    host.closeFile()
    runtime.closeFile()
  }
  let output = GatewayOutputBox()
  let supervisor = try readyGateway(host: host, runtime: runtime, output: output)
  let metadata = Data("{}".utf8)
  let payload = Data(repeating: 7, count: RemoteWire.maximumRecordBytes - 3 - metadata.count)
  try supervisor.connectionFrame(metadata: metadata, payload: payload)
  #expect(throws: RelaySealedGatewaySupervisorError.unavailable) {
    try supervisor.connectionFrame(metadata: metadata, payload: payload)
  }
  #expect(supervisor.isStoppedForTesting)
}

@Test func sealedGatewaySupervisorUsesNoAmbientEnvironment() {
  #expect(RelaySealedGatewaySupervisor.privateRuntimeEnvironment.isEmpty)
}

@Test func childTerminationBoundsBothWaitWindowsAndEscalatesToSIGKILL() {
  var signals: [Int32] = []
  var waits = 0
  var pauses = 0
  let reaped = ChildProcessTerminator.terminate(
    42,
    sendSignal: { signals.append($0); return 0 },
    wait: { waits += 1; return 0 },
    pause: { pauses += 1 }
  )
  #expect(!reaped)
  #expect(signals == [SIGTERM, SIGKILL])
  #expect(waits == 1 + ChildProcessTerminator.gracefulPollAttempts + ChildProcessTerminator.forcedPollAttempts)
  #expect(pauses == ChildProcessTerminator.gracefulPollAttempts + ChildProcessTerminator.forcedPollAttempts - 2)
}

@Test func childTerminationReapsDuringSIGTERMGraceWithoutEscalation() {
  var signals: [Int32] = []
  var waits = 0
  let reaped = ChildProcessTerminator.terminate(
    42,
    sendSignal: { signals.append($0); return 0 },
    wait: {
      waits += 1
      if waits == 2 { errno = EINTR; return -1 }
      return waits == 3 ? 42 : 0
    },
    pause: {}
  )
  #expect(reaped)
  #expect(signals == [SIGTERM])
  #expect(waits == 3)
}

@Test func failedBoundedTerminationRetainsADeferredReaperUntilWaitpidConfirmsExit() {
  let probe = DeferredReapProbe()
  let reapedSynchronously = ChildProcessTerminator.terminateAndContinue(
    42,
    sendSignal: probe.signal,
    wait: probe.wait,
    pause: {},
    deferredPause: {},
    schedule: probe.schedule,
    onReaped: probe.markCompleted
  )
  #expect(!reapedSynchronously)
  #expect(probe.snapshot.signals == [SIGTERM, SIGKILL])
  #expect(probe.hasScheduledWork)
  #expect(!probe.snapshot.completed)

  probe.runScheduled()
  #expect(probe.snapshot.completed)
  #expect(!probe.hasScheduledWork)
}
@Test func hostedChildNodeInvocationIncludesOnlyTheRequiredInternalExposureFlag() {
  #expect(Fd199HostedChildSupervisor.nodeExecutionFlags == ["--expose-internals"])
}

@Test func hostedChildSupervisorPreservesOutputOrderAcrossSeparateReadCallbacks() throws {
  let (hostRelay, childRelay) = try gatewaySocketPair()
  let (hostAuthority, childAuthority) = try gatewaySocketPair()
  defer {
    childRelay.closeFile()
    childAuthority.closeFile()
  }
  let output = HostedChildOutputBox()
  let supervisor = Fd199HostedChildSupervisor(
    testRelayChannel: hostRelay,
    testAuthorityChannel: hostAuthority,
    onOutput: output.append
  )
  defer { supervisor.stop() }

  let metadata = Data("{\"connectionId\":\"ordered\"}".utf8)
  // Separate writes force independently scheduled readability callbacks. The
  // supervisor's receive/decode/dispatch FIFO must preserve this exact order
  // rather than allowing a later callback to overtake an unlocked predecessor.
  try childRelay.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .connectionSend, metadata: metadata, payload: Data("first".utf8))))
  try waitForGateway { output.snapshot().count == 1 }
  try childRelay.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .connectionSend, metadata: metadata, payload: Data("second".utf8))))
  try waitForGateway { output.snapshot().count == 2 }
  #expect(output.snapshot() == [
    .send(metadata: metadata, payload: Data("first".utf8)),
    .send(metadata: metadata, payload: Data("second".utf8)),
  ])
}

@Test func hostedChildSupervisorForwardsEpochAcknowledgmentWithoutDroppingPayload() throws {
  let (hostRelay, childRelay) = try gatewaySocketPair()
  let (hostAuthority, childAuthority) = try gatewaySocketPair()
  defer { childRelay.closeFile(); childAuthority.closeFile() }
  let output = HostedChildOutputBox()
  let supervisor = Fd199HostedChildSupervisor(testRelayChannel: hostRelay, testAuthorityChannel: hostAuthority, onOutput: output.append)
  defer { supervisor.stop() }
  let metadata = Data("{\"connectionEpoch\":1}".utf8)
  // The consumer, not the transport adapter, rejects a nonempty receipt.
  let payload = Data([1])
  try childRelay.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .epochSynchronized, metadata: metadata, payload: payload)))
  try waitForGateway { output.snapshot().count == 1 }
  #expect(output.snapshot() == [.epochSynchronized(metadata: metadata, payload: payload)])
}

@Test func hostedChildSupervisorReapsOnExplicitAndErrorStopPaths() throws {
  let (normalHostRelay, normalChildRelay) = try gatewaySocketPair()
  let (normalHostAuthority, normalChildAuthority) = try gatewaySocketPair()
  let normalPID = try reapingProbeChild()
  let normal = Fd199HostedChildSupervisor(
    testRelayChannel: normalHostRelay,
    testAuthorityChannel: normalHostAuthority,
    testChildPID: normalPID,
    onOutput: { _ in }
  )
  normal.stop()
  expectAlreadyReaped(normalPID)
  normalChildRelay.closeFile()
  normalChildAuthority.closeFile()

  let (errorHostRelay, errorChildRelay) = try gatewaySocketPair()
  let (errorHostAuthority, errorChildAuthority) = try gatewaySocketPair()
  let errorPID = try reapingProbeChild()
  let failing = Fd199HostedChildSupervisor(
    testRelayChannel: errorHostRelay,
    testAuthorityChannel: errorHostAuthority,
    testChildPID: errorPID,
    onOutput: { _ in }
  )
  // A malformed zero-length Remote Wire record takes the same stopLocked()
  // path used for receive/decode startup failures.
  try errorChildRelay.write(contentsOf: Data([0, 0, 0, 0]))
  try waitForGateway { failing.isClosed }
  expectAlreadyReaped(errorPID)
  errorChildRelay.closeFile()
  errorChildAuthority.closeFile()
}

@Test func allNativeChildSupervisorsUseTheBoundedReaperOnExplicitTeardown() throws {
  let (privateHost, privateChild) = try gatewaySocketPair()
  let privatePID = try reapingProbeChild()
  var privateSupervisor: RelayPrivateRuntimeSupervisor? = RelayPrivateRuntimeSupervisor(
    testChannel: privateHost,
    testChildPID: privatePID,
    waitMilliseconds: 100
  )
  privateSupervisor = nil
  _ = privateSupervisor
  expectAlreadyReaped(privatePID)
  privateChild.closeFile()

  let (gatewayHost, gatewayChild) = try gatewaySocketPair()
  let gatewayPID = try reapingProbeChild()
  let gatewaySupervisor = RelaySealedGatewaySupervisor(
    testChannel: gatewayHost,
    testChildPID: gatewayPID,
    onOutput: { _ in }
  )
  gatewaySupervisor.stop()
  expectAlreadyReaped(gatewayPID)
  gatewayChild.closeFile()

  let (hostedRelay, hostedRelayChild) = try gatewaySocketPair()
  let (hostedAuthority, hostedAuthorityChild) = try gatewaySocketPair()
  let hostedPID = try reapingProbeChild()
  let hostedSupervisor = Fd199HostedChildSupervisor(
    testRelayChannel: hostedRelay,
    testAuthorityChannel: hostedAuthority,
    testChildPID: hostedPID,
    onOutput: { _ in }
  )
  hostedSupervisor.stop()
  expectAlreadyReaped(hostedPID)
  hostedRelayChild.closeFile()
  hostedAuthorityChild.closeFile()
}

@Test func allNativeChildSupervisorsRetainOwnershipUntilDeferredReapCompletes() throws {
  let privateTermination = DeferredTerminationBox()
  let (privateHost, privateChild) = try gatewaySocketPair()
  let privateSupervisor = RelayPrivateRuntimeSupervisor(
    testChannel: privateHost,
    testChildPID: 401,
    waitMilliseconds: 100,
    terminateChild: privateTermination.retain
  )
  privateChild.closeFile()
  try waitForGateway { privateSupervisor.isStoppedForTesting }
  #expect(privateSupervisor.childPIDForTesting == 401)
  #expect(privateTermination.contains(401))
  privateTermination.complete(401)
  try waitForGateway { privateSupervisor.childPIDForTesting == 0 }

  let gatewayTermination = DeferredTerminationBox()
  let (gatewayHost, gatewayChild) = try gatewaySocketPair()
  let gatewaySupervisor = RelaySealedGatewaySupervisor(
    testChannel: gatewayHost,
    testChildPID: 402,
    terminateChild: gatewayTermination.retain,
    onOutput: { _ in }
  )
  gatewaySupervisor.stop()
  #expect(gatewaySupervisor.childPIDForTesting == 402)
  #expect(gatewayTermination.contains(402))
  gatewayTermination.complete(402)
  try waitForGateway { gatewaySupervisor.childPIDForTesting == 0 }
  gatewayChild.closeFile()

  let hostedTermination = DeferredTerminationBox()
  let (hostedRelay, hostedRelayChild) = try gatewaySocketPair()
  let (hostedAuthority, hostedAuthorityChild) = try gatewaySocketPair()
  let hostedSupervisor = Fd199HostedChildSupervisor(
    testRelayChannel: hostedRelay,
    testAuthorityChannel: hostedAuthority,
    testChildPID: 403,
    terminateChild: hostedTermination.retain,
    onOutput: { _ in }
  )
  hostedSupervisor.stop()
  #expect(hostedSupervisor.childPIDForTesting == 403)
  #expect(hostedTermination.contains(403))
  hostedTermination.complete(403)
  try waitForGateway { hostedSupervisor.childPIDForTesting == 0 }
  hostedRelayChild.closeFile()
  hostedAuthorityChild.closeFile()
}
