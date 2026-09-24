import Foundation
import Testing
import RemoteHostFd199
@testable import RemoteHostApp

private final class LifecycleEvents: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [String] = []
  private var waiters: [(String, CheckedContinuation<Void, Never>)] = []
  func record(_ event: String) {
    let ready = lock.withLock {
      events.append(event)
      let ready = waiters.filter { $0.0 == event }
      waiters.removeAll { $0.0 == event }
      return ready
    }
    for (_, waiter) in ready { waiter.resume() }
  }
  var values: [String] { lock.withLock { events } }
  func waitFor(_ event: String) async {
    await withCheckedContinuation { continuation in
      let ready = lock.withLock {
        guard !events.contains(event) else { return true }
        waiters.append((event, continuation))
        return false
      }
      if ready { continuation.resume() }
    }
  }
}

private actor LifecycleSuspension {
  private var entered = 0
  private var arrival: (Int, CheckedContinuation<Void, Never>)?
  private var releases: [CheckedContinuation<Void, Never>] = []
  func suspend() async {
    entered += 1
    if let arrival, entered >= arrival.0 {
      arrival.1.resume()
      self.arrival = nil
    }
    await withCheckedContinuation { releases.append($0) }
  }
  func waitForEntry(count: Int = 1) async {
    if entered < count { await withCheckedContinuation { arrival = (count, $0) } }
  }
  func finish() {
    for release in releases { release.resume() }
    releases = []
  }
}

private final class LifecycleCarrier: HostedRuntimeCarrier, @unchecked Sendable {
  private let lock = NSLock()
  private var currentPhase: Fd199HandoffCoordinator.Phase = .idle
  let restoredPhase: Fd199HandoffCoordinator.Phase
  let events: LifecycleEvents
  var onStart: @Sendable () throws -> Void = {}
  var onStop: @Sendable () -> Void = {}
  init(_ phase: Fd199HandoffCoordinator.Phase, _ events: LifecycleEvents) {
    restoredPhase = phase
    self.events = events
  }
  var phase: Fd199HandoffCoordinator.Phase { lock.withLock { currentPhase } }
  func startHostedRuntime() throws {
    events.record("child.start")
    try onStart()
    lock.withLock { currentPhase = restoredPhase }
  }
  func stop() {
    events.record("child.stop")
    lock.withLock { currentPhase = .idle }
    onStop()
  }
}

private enum LifecycleTestError: Error { case handshakeTimeout }

private final class LifecyclePhone: HostedRuntimePhoneSession, @unchecked Sendable {
  private let lock = NSLock()
  private var ended = false
  var isEnded: Bool { lock.withLock { ended } }
  var onStop: @Sendable () async -> Void = {}
  let events: LifecycleEvents
  let suspension: LifecycleSuspension?
  let fail: Bool
  init(_ events: LifecycleEvents, suspension: LifecycleSuspension? = nil, fail: Bool = false) {
    self.events = events
    self.suspension = suspension
    self.fail = fail
  }
  func activate() async throws { try await run("phone.activate") }
  func resume() async throws { try await run("phone.resume") }
  private func run(_ event: String) async throws {
    events.record(event)
    await suspension?.suspend()
    if fail { throw LifecycleTestError.handshakeTimeout }
  }
  func stop() async {
    lock.withLock { ended = true }
    events.record("phone.stop")
    await onStop()
  }
}

private typealias TestLifecycle = HostedRuntimeLifecycle<LifecycleCarrier, LifecyclePhone>

private extension HostedRuntimeLifecycle where Carrier == LifecycleCarrier, Session == LifecyclePhone {
  func activate(makeSession: (Carrier) throws -> Session) async throws {
    try await activate(makeCarrier: {
      Issue.record("Unexpected recovery in ordinary activation")
      throw LifecycleTestError.handshakeTimeout
    }, makeSession: makeSession)
  }
}

@Test("restored local startup stays inert until explicit activation resumes ownership")
func hostedLifecycleRestoredStartIsInert() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  let carrier = LifecycleCarrier(.servingPhoneSessions, events)
  try lifecycle.start { carrier }
  #expect(events.values == ["child.start"])
  #expect(lifecycle.currentCarrier === carrier)
  try await lifecycle.activate { owner in
    #expect(owner === carrier)
    events.record("phone.construct")
    return LifecyclePhone(events)
  }
  #expect(events.values == ["child.start", "phone.construct", "phone.resume"])
  await lifecycle.stop()
  #expect(events.values.suffix(2) == ["phone.stop", "child.stop"])
}

@Test("fresh explicit activation consumes ownership exactly once")
func hostedLifecycleFreshActivation() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  try lifecycle.start { LifecycleCarrier(.desktopAdmitted, events) }
  try await lifecycle.activate { _ in LifecyclePhone(events) }
  await #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) {
    try await lifecycle.activate { _ in Issue.record("Duplicate session constructed"); return LifecyclePhone(events) }
  }
  #expect(events.values == ["child.start", "phone.activate"])
  await lifecycle.stop()
}

@Test("failed restored handshake retires the seeded child and permits an inert restart")
func hostedLifecycleFailedHandshakeRequiresNewChild() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  await #expect(throws: LifecycleTestError.self) {
    try await lifecycle.activate { _ in LifecyclePhone(events, fail: true) }
  }
  #expect(lifecycle.currentCarrier == nil)
  #expect(events.values == ["child.start", "phone.resume", "phone.stop", "child.stop"])
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  #expect(events.values.last == "child.start")
  await lifecycle.stop()
}

@Test("stop invalidates a suspended activation and excludes replacement until its cleanup")
func hostedLifecycleStopDuringActivation() async throws {
  let events = LifecycleEvents()
  let suspension = LifecycleSuspension()
  let lifecycle = TestLifecycle()
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  let activation = Task {
    try await lifecycle.activate { _ in LifecyclePhone(events, suspension: suspension) }
  }
  await suspension.waitForEntry()
  await #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) {
    try await lifecycle.activate { _ in Issue.record("Concurrent session constructed"); return LifecyclePhone(events) }
  }
  let stopping = Task { await lifecycle.stop(); events.record("stop.returned") }
  await events.waitFor("child.stop")
  #expect(lifecycle.currentCarrier == nil)
  #expect(events.values.suffix(2) == ["phone.stop", "child.stop"])
  #expect(!events.values.contains("stop.returned"))
  #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) {
    try lifecycle.start { Issue.record("Replacement constructed before cleanup"); return LifecycleCarrier(.desktopAdmitted, events) }
  }
  await suspension.finish()
  await #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) { try await activation.value }
  await stopping.value
  #expect(lifecycle.currentCarrier == nil)
  let replacement = LifecycleCarrier(.desktopAdmitted, events)
  try lifecycle.start { replacement }
  try await lifecycle.activate { _ in LifecyclePhone(events) }
  #expect(lifecycle.currentCarrier === replacement)
  #expect(events.values.last == "phone.activate")
  await lifecycle.stop()
}

@Test("stop during child startup cannot retain the late owner or admit a replacement early")
func hostedLifecycleStopDuringStart() async throws {
  let events = LifecycleEvents()
  let release = DispatchSemaphore(value: 0)
  let lifecycle = TestLifecycle()
  let carrier = LifecycleCarrier(.servingPhoneSessions, events)
  carrier.onStart = { events.record("child.entered"); release.wait() }
  let startup = Task.detached { try lifecycle.start { carrier } }
  defer { release.signal() }
  await events.waitFor("child.entered")
  let stopping = Task { await lifecycle.stop(); events.record("stop.returned") }
  await events.waitFor("child.stop")
  #expect(!events.values.contains("stop.returned"))
  #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) {
    try lifecycle.start { Issue.record("Overlapping startup"); return LifecycleCarrier(.desktopAdmitted, events) }
  }
  release.signal()
  await #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) { try await startup.value }
  await stopping.value
  #expect(lifecycle.currentCarrier == nil)
  #expect(carrier.phase == .idle)
  try lifecycle.start { LifecycleCarrier(.desktopAdmitted, events) }
  await lifecycle.stop()
}

@Test("validation failure leaves an unseeded child available and repair reservations exclude runtime actions")
func hostedLifecycleValidationAndIdleReservation() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  try lifecycle.whileIdle { () -> Void in
    #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) {
      try lifecycle.start { Issue.record("Started during repair"); return LifecycleCarrier(.desktopAdmitted, events) }
    }
  }
  let carrier = LifecycleCarrier(.desktopAdmitted, events)
  try lifecycle.start { carrier }
  #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) { try lifecycle.whileIdle {} }
  await #expect(throws: LifecycleTestError.self) {
    try await lifecycle.activate { _ in throw LifecycleTestError.handshakeTimeout }
  }
  #expect(lifecycle.currentCarrier === carrier)
  #expect(events.values == ["child.start"])
  try await lifecycle.activate { _ in LifecyclePhone(events) }
  await lifecycle.stop()
}

@Test("ended phone preserves local runtime until explicit activation replaces its seeded owner")
func hostedLifecycleExplicitEndedRecovery() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  let previous = LifecycleCarrier(.servingPhoneSessions, events)
  let ended = LifecyclePhone(events)
  try lifecycle.start { previous }
  try await lifecycle.activate { _ in ended }
  await ended.stop()
  #expect(lifecycle.currentCarrier === previous)
  #expect(!events.values.contains("child.stop"))
  let replacement = LifecycleCarrier(.servingPhoneSessions, events)
  let current = LifecyclePhone(events)
  try await lifecycle.activate(makeCarrier: {
    #expect(events.values.last == "child.stop")
    #expect(previous.phase == .idle)
    return replacement
  }) { owner in
    #expect(owner === replacement)
    return current
  }
  #expect(lifecycle.currentCarrier === replacement)
  #expect(events.values.suffix(3) == ["child.stop", "child.start", "phone.resume"])
  await ended.stop()
  #expect(lifecycle.currentCarrier === replacement)
  #expect(!current.isEnded)
  await #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) {
    try await lifecycle.activate { _ in Issue.record("Live replacement superseded"); return LifecyclePhone(events) }
  }
  await lifecycle.stop()
}

@Test("explicit recovery awaits ended transport cleanup before stopping the old child")
func hostedLifecycleRecoveryWaitsForTransport() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  let ended = LifecyclePhone(events)
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  try await lifecycle.activate { _ in ended }
  await ended.stop()
  let suspension = LifecycleSuspension()
  ended.onStop = { await suspension.suspend() }
  let recovery = Task {
    try await lifecycle.activate(makeCarrier: { LifecycleCarrier(.servingPhoneSessions, events) }) { _ in LifecyclePhone(events) }
  }
  await suspension.waitForEntry()
  #expect(!events.values.contains("child.stop"))
  await suspension.finish()
  try await recovery.value
  ended.onStop = {}
  await lifecycle.stop()
}

@Test("stop during replacement startup cannot resurrect or overlap the canceled child")
func hostedLifecycleStopDuringRecovery() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  let ended = LifecyclePhone(events)
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  try await lifecycle.activate { _ in ended }
  await ended.stop()
  let release = DispatchSemaphore(value: 0)
  defer { release.signal() }
  let replacement = LifecycleCarrier(.servingPhoneSessions, events)
  replacement.onStart = { events.record("replacement.entered"); release.wait() }
  replacement.onStop = { events.record("replacement.stopped") }
  let recovery = Task.detached {
    try await lifecycle.activate(makeCarrier: { replacement }) { _ in
      Issue.record("Canceled replacement activated")
      return LifecyclePhone(events)
    }
  }
  await events.waitFor("replacement.entered")
  let stopping = Task { await lifecycle.stop(); events.record("stop.returned") }
  await events.waitFor("replacement.stopped")
  #expect(!events.values.contains("stop.returned"))
  #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) {
    try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  }
  release.signal()
  await #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) { try await recovery.value }
  await stopping.value
  #expect(replacement.phase == .idle)
  #expect(lifecycle.currentCarrier == nil)
}

@Test("failed replacement startup leaves no retained seeded child and permits local restart")
func hostedLifecycleFailedRecoveryCanRestart() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  let ended = LifecyclePhone(events)
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  try await lifecycle.activate { _ in ended }
  await ended.stop()
  let replacement = LifecycleCarrier(.servingPhoneSessions, events)
  replacement.onStart = { throw LifecycleTestError.handshakeTimeout }
  await #expect(throws: LifecycleTestError.self) {
    try await lifecycle.activate(makeCarrier: { replacement }) { _ in
      Issue.record("Failed child activated")
      return LifecyclePhone(events)
    }
  }
  #expect(lifecycle.currentCarrier == nil)
  #expect(replacement.phase == .idle)
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  try await lifecycle.activate { _ in LifecyclePhone(events) }
  await lifecycle.stop()
}

@Test("stop while recovery constructs a session prevents activation and waits for disposal")
func hostedLifecycleStopDuringRecoveryFactory() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  let ended = LifecyclePhone(events)
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  try await lifecycle.activate { _ in ended }
  await ended.stop()
  let release = DispatchSemaphore(value: 0)
  defer { release.signal() }
  let replacement = LifecycleCarrier(.servingPhoneSessions, events)
  replacement.onStop = { events.record("replacement.stopped") }
  let recovery = Task.detached {
    try await lifecycle.activate(makeCarrier: { replacement }) { _ in
      events.record("factory.entered")
      release.wait()
      return LifecyclePhone(events)
    }
  }
  await events.waitFor("factory.entered")
  let stopping = Task { await lifecycle.stop(); events.record("stop.returned") }
  await events.waitFor("replacement.stopped")
  #expect(!events.values.contains("stop.returned"))
  release.signal()
  await #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) { try await recovery.value }
  await stopping.value
  #expect(events.values.filter { $0 == "phone.resume" }.count == 1)
  #expect(replacement.phase == .idle)
  #expect(lifecycle.currentCarrier == nil)
}

@Test("failed replacement construction releases its reservation for local restart")
func hostedLifecycleFailedRecoveryFactoryCanRestart() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  let ended = LifecyclePhone(events)
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  try await lifecycle.activate { _ in ended }
  await ended.stop()
  await #expect(throws: LifecycleTestError.self) {
    try await lifecycle.activate(makeCarrier: { throw LifecycleTestError.handshakeTimeout }) { _ in
      Issue.record("Session constructed without a child")
      return LifecyclePhone(events)
    }
  }
  #expect(lifecycle.currentCarrier == nil)
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  try await lifecycle.activate { _ in LifecyclePhone(events) }
  await lifecycle.stop()
}

@Test("stop during old transport cleanup cancels recovery before any replacement factory")
func hostedLifecycleStopDuringRecoveryCleanup() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  let ended = LifecyclePhone(events)
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  try await lifecycle.activate { _ in ended }
  await ended.stop()
  let suspension = LifecycleSuspension()
  ended.onStop = { await suspension.suspend() }
  let recovery = Task {
    try await lifecycle.activate(makeCarrier: {
      Issue.record("Canceled recovery constructed a child")
      return LifecycleCarrier(.servingPhoneSessions, events)
    }) { _ in LifecyclePhone(events) }
  }
  await suspension.waitForEntry()
  let stopping = Task { await lifecycle.stop(); events.record("stop.returned") }
  await suspension.waitForEntry(count: 2)
  #expect(!events.values.contains("child.stop"))
  #expect(!events.values.contains("stop.returned"))
  await suspension.finish()
  await #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) { try await recovery.value }
  await stopping.value
  #expect(lifecycle.currentCarrier == nil)
  try lifecycle.start { LifecycleCarrier(.servingPhoneSessions, events) }
  await lifecycle.stop()
}

@Test("stop during replacement child construction disposes the late candidate without starting it")
func hostedLifecycleStopDuringCarrierFactory() async throws {
  let events = LifecycleEvents()
  let lifecycle = TestLifecycle()
  let previous = LifecycleCarrier(.servingPhoneSessions, events)
  let ended = LifecyclePhone(events)
  try lifecycle.start { previous }
  try await lifecycle.activate { _ in ended }
  await ended.stop()
  let release = DispatchSemaphore(value: 0)
  defer { release.signal() }
  let replacement = LifecycleCarrier(.servingPhoneSessions, events)
  let recovery = Task.detached {
    try await lifecycle.activate(makeCarrier: {
      previous.onStop = { events.record("stop.observed") }
      events.record("factory.entered")
      release.wait()
      return replacement
    }) { _ in Issue.record("Canceled child activated"); return LifecyclePhone(events) }
  }
  await events.waitFor("factory.entered")
  let stopping = Task { await lifecycle.stop(); events.record("stop.returned") }
  await events.waitFor("stop.observed")
  #expect(!events.values.contains("stop.returned"))
  release.signal()
  await #expect(throws: Fd199HandoffCoordinator.CoordinatorError.self) { try await recovery.value }
  await stopping.value
  #expect(events.values.filter { $0 == "child.start" }.count == 1)
  #expect(replacement.phase == .idle)
  #expect(lifecycle.currentCarrier == nil)
}
