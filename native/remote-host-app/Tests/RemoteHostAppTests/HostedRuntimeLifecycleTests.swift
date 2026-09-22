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
  private var entered = false
  private var arrival: CheckedContinuation<Void, Never>?
  private var release: CheckedContinuation<Void, Never>?
  func suspend() async {
    entered = true
    arrival?.resume()
    arrival = nil
    await withCheckedContinuation { release = $0 }
  }
  func waitForEntry() async {
    if !entered { await withCheckedContinuation { arrival = $0 } }
  }
  func finish() { release?.resume(); release = nil }
}

private final class LifecycleCarrier: HostedRuntimeCarrier, @unchecked Sendable {
  private let lock = NSLock()
  private var currentPhase: Fd199HandoffCoordinator.Phase = .idle
  let restoredPhase: Fd199HandoffCoordinator.Phase
  let events: LifecycleEvents
  var onStart: @Sendable () -> Void = {}
  init(_ phase: Fd199HandoffCoordinator.Phase, _ events: LifecycleEvents) {
    restoredPhase = phase
    self.events = events
  }
  var phase: Fd199HandoffCoordinator.Phase { lock.withLock { currentPhase } }
  func startHostedRuntime() throws {
    events.record("child.start")
    onStart()
    lock.withLock { currentPhase = restoredPhase }
  }
  func stop() {
    events.record("child.stop")
    lock.withLock { currentPhase = .idle }
  }
}

private enum LifecycleTestError: Error { case handshakeTimeout }

private final class LifecyclePhone: HostedRuntimePhoneSession, @unchecked Sendable {
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
  func stop() async { events.record("phone.stop") }
}

private typealias TestLifecycle = HostedRuntimeLifecycle<LifecycleCarrier, LifecyclePhone>

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
