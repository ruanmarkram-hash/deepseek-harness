import Foundation
import RemoteHostFd199

/** The retained child owner; starting it never requires a phone handshake. */
protocol HostedRuntimeCarrier: AnyObject, Sendable {
  var phase: Fd199HandoffCoordinator.Phase { get }
  func startHostedRuntime() throws
  func stop()
}

extension Fd199HandoffCoordinator: HostedRuntimeCarrier {
  func startHostedRuntime() throws { try start() }
}

/** An inert phone session bound to one child owner and authorized credential. */
protocol HostedRuntimePhoneSession: AnyObject, Sendable {
  func activate() async throws
  func resume() async throws
  func stop() async
}

/**
 Owns local startup independently of phone activation. A canceled operation
 retains its reservation until cleanup completes, so it cannot affect a
 replacement owner. Stop also detaches an activation that is still awaiting
 the phone, rather than only sessions that have completed their handshake.
 */
final class HostedRuntimeLifecycle<Carrier: HostedRuntimeCarrier, Session: HostedRuntimePhoneSession>: @unchecked Sendable {
  private let lock = NSLock()
  private var carrier: Carrier?
  private var session: Session?
  private var operation: UUID?
  private var canceled = false
  private var stopping = false
  private var operationWaiters: [CheckedContinuation<Void, Never>] = []
  private var stopWaiters: [CheckedContinuation<Void, Never>] = []

  var currentCarrier: Carrier? { lock.withLock { carrier } }

  func whileIdle<T>(_ body: () throws -> T) throws -> T {
    let token = try reserveIdle()
    defer { finish(token) }
    return try body()
  }

  func start(makeCarrier: () throws -> Carrier) throws {
    let token = try reserveIdle()
    defer { finish(token) }
    let candidate = try makeCarrier()
    do {
      try lock.withLock {
        guard operation == token, !canceled else { throw invalidState }
        carrier = candidate
      }
      try candidate.startHostedRuntime()
      try lock.withLock {
        guard operation == token, !canceled, carrier === candidate else { throw invalidState }
      }
    } catch {
      candidate.stop()
      lock.withLock { if carrier === candidate { carrier = nil } }
      throw error
    }
  }

  func activate(makeSession: (Carrier) throws -> Session) async throws {
    let (token, owner) = try reserveActivation()
    defer { finish(token) }
    // Validation or credential lookup failure before construction leaves the
    // unseeded local child available for a later explicit activation.
    let candidate = try makeSession(owner)
    do {
      let phase = try lock.withLock {
        guard operation == token, !canceled, carrier === owner else { throw invalidState }
        session = candidate
        return owner.phase
      }
      switch phase {
      case .desktopAdmitted: try await candidate.activate()
      case .servingPhoneSessions: try await candidate.resume()
      case .idle, .transferringOwnership: throw invalidState
      }
      try lock.withLock {
        guard operation == token, !canceled, carrier === owner, session === candidate else { throw invalidState }
      }
    } catch {
      await candidate.stop()
      // Enrollment seed is one-shot in the child. A failed handshake therefore
      // requires a fresh child, but never resets the activated journal or keys.
      owner.stop()
      lock.withLock {
        if session === candidate { session = nil }
        if carrier === owner { carrier = nil }
      }
      throw error
    }
  }

  func stop() async {
    let owners: (Session?, Carrier?)? = lock.withLock {
      guard !stopping else { return nil }
      stopping = true
      canceled = true
      let owners = (session, carrier)
      session = nil
      carrier = nil
      return owners
    }
    guard let owners else {
      await waitForStop()
      return
    }
    await owners.0?.stop()
    owners.1?.stop()
    // A synchronous child spawn can finish after its first stop request. Its
    // canceled operation must perform final cleanup before Stop returns.
    await waitForOperation()
    let waiters = lock.withLock {
      stopping = false
      let waiters = stopWaiters
      stopWaiters = []
      return waiters
    }
    for waiter in waiters { waiter.resume() }
  }

  private var invalidState: Fd199HandoffCoordinator.CoordinatorError { .invalidState }

  private func reserveIdle() throws -> UUID {
    try lock.withLock {
      guard carrier == nil, session == nil, operation == nil, !stopping else { throw invalidState }
      let token = UUID()
      operation = token
      canceled = false
      return token
    }
  }

  private func reserveActivation() throws -> (UUID, Carrier) {
    try lock.withLock {
      guard let carrier, session == nil, operation == nil, !stopping,
            carrier.phase == .desktopAdmitted || carrier.phase == .servingPhoneSessions else { throw invalidState }
      let token = UUID()
      operation = token
      canceled = false
      return (token, carrier)
    }
  }

  private func finish(_ token: UUID) {
    let waiters: [CheckedContinuation<Void, Never>] = lock.withLock {
      guard operation == token else { return [] }
      operation = nil
      let waiters = operationWaiters
      operationWaiters = []
      return waiters
    }
    for waiter in waiters { waiter.resume() }
  }

  private func waitForOperation() async {
    await withCheckedContinuation { continuation in
      let finished = lock.withLock {
        guard operation != nil else { return true }
        operationWaiters.append(continuation)
        return false
      }
      if finished { continuation.resume() }
    }
  }

  private func waitForStop() async {
    await withCheckedContinuation { continuation in
      let finished = lock.withLock {
        guard stopping else { return true }
        stopWaiters.append(continuation)
        return false
      }
      if finished { continuation.resume() }
    }
  }
}
