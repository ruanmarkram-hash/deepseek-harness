import Foundation

/** A socket that remains inert until its owning Host explicitly starts it. */
public protocol RelayHostStartableSocket: RelayHostSocket {
  /// Resumes this one socket exactly once. Implementations must not connect before this call.
  func start() async throws
}

/** Creates only a socket for the supplied already-owned route credential. */
public protocol RelayHostSocketFactory: Sendable {
  func make(credential: RelayRouteCredential) throws -> any RelayHostStartableSocket
}

/** Production URLSession WebSocket adapter for the fixed DSH V3 Host endpoint. */
public actor RelayURLSessionHostSocket: RelayHostStartableSocket {
  static let maximumMessageBytes = 12 * 1024 * 1024 + 16 * 1024

  private let task: URLSessionWebSocketTask
  private var started = false
  private var closed = false

  /// Construction creates a suspended task only. It never starts network activity.
  public init(credential: RelayRouteCredential, session: URLSession) throws {
    task = try RelayUnstartedURLSessionTaskFactory.make(credential: credential, session: session)
  }

  public func start() async throws {
    guard !started, !closed, task.state == .suspended else { throw RelayOwnerError.invalidState }
    task.maximumMessageSize = Self.maximumMessageBytes
    started = true
    task.resume()
  }

  public func send(_ data: Data, fence: RelayHostSendFence) async throws -> Bool {
    guard started, !closed, data.count <= Self.maximumMessageBytes, await fence.isOpen() else { return false }
    do {
      guard let text = String(data: data, encoding: .utf8) else { throw RelayOwnerError.invalidCredential }
      try await task.send(.string(text))
    } catch {
      throw RelayOwnerError.unavailable
    }
    // A close races URLSession outside this actor. Returning false is conservative:
    // the caller must tear down rather than expose an uncertain write as committed.
    let fenceStillOpen = await fence.isOpen()
    return !closed && fenceStillOpen
  }

  public func receive() async throws -> Data {
    guard started, !closed else { throw RelayOwnerError.unavailable }
    let message: URLSessionWebSocketTask.Message
    do { message = try await task.receive() }
    catch { throw RelayOwnerError.unavailable }
    guard case let .string(text) = message else {
      throw RelayOwnerError.invalidCredential
    }
    let data = Data(text.utf8)
    guard !data.isEmpty, data.count <= Self.maximumMessageBytes else { throw RelayOwnerError.invalidCredential }
    return data
  }

  public func close() async {
    guard !closed else { return }
    closed = true
    task.cancel(with: .goingAway, reason: nil)
  }
}

/** Fixed-production factory. It has no route storage, key-store, or provisioner reference. */
public final class RelayURLSessionHostSocketFactory: @unchecked Sendable, RelayHostSocketFactory {
  private let session: URLSession
  private let redirectDelegate: RelayRejectRedirects

  public init() {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    let redirectDelegate = RelayRejectRedirects()
    self.redirectDelegate = redirectDelegate
    session = URLSession(configuration: configuration, delegate: redirectDelegate, delegateQueue: nil)
  }

  /** Test-only session injection. Production uses the fixed no-redirect session above. */
  init(session: URLSession, redirectDelegate: RelayRejectRedirects) {
    self.session = session
    self.redirectDelegate = redirectDelegate
  }

  public func make(credential: RelayRouteCredential) throws -> any RelayHostStartableSocket {
    try RelayURLSessionHostSocket(credential: credential, session: session)
  }
}

/** Observable state for one explicitly Host-owned native V3 connection. */
public enum RelayHostSocketSupervisorState: Equatable, Sendable {
  case idle
  case handshaking
  case established
  case stopped
}

/**
 * Starts one fixed V3 socket only after an explicit Host-owner action. It receives
 * credentials and agreement capability from its caller but has no Keychain, identity,
 * provisioning, pairing, XPC, or FD-runtime access of its own.
 */
public actor RelayHostSocketSupervisor {
  private let credential: RelayRouteCredential
  private let agreement: RelayProtectedAgreement
  private let socketFactory: RelayHostSocketFactory
  private let clock: RelayTransportClock
  private let random: RelayTransportRandom
  private let epochLedger: RelayConnectionEpochLedger
  private let connectionCoordinator: RelayHostRouteConnectionCoordinator
  private let flightTimeoutNanoseconds: UInt64
  private var socket: (any RelayHostStartableSocket)?
  private var transport: RelayHostTransport?
  private var epochReservation: RelayConnectionEpochReservation?
  private var coordinatorClaimed = false
  private var value: RelayHostSocketSupervisorState = .idle

  public init(credential: RelayRouteCredential, agreement: RelayProtectedAgreement, epochLedger: RelayConnectionEpochLedger, connectionCoordinator: RelayHostRouteConnectionCoordinator, socketFactory: RelayHostSocketFactory = RelayURLSessionHostSocketFactory(), clock: RelayTransportClock = RelaySystemClock(), random: RelayTransportRandom = RelaySystemRandom(), flightTimeoutNanoseconds: UInt64 = 10_000_000_000) {
    self.credential = credential
    self.agreement = agreement
    self.epochLedger = epochLedger
    self.connectionCoordinator = connectionCoordinator
    self.socketFactory = socketFactory
    self.clock = clock
    self.random = random
    self.flightTimeoutNanoseconds = flightTimeoutNanoseconds
  }

  public func state() -> RelayHostSocketSupervisorState { value }

  /** Public facts needed to open the one FD198 application connection after handshake. */
  public func establishedConnectionEpoch() async throws -> Int {
    guard value == .established, let transport,
          let epoch = await transport.establishedConnectionEpoch()
    else { throw RelayOwnerError.invalidState }
    return epoch
  }

  /** Runs the exact four inbound handshake flights after the owner explicitly starts. */
  public func start() async throws {
    guard value == .idle else { throw RelayOwnerError.invalidState }
    value = .handshaking
    do {
      try await connectionCoordinator.claim(self, credential: credential)
      coordinatorClaimed = true
      let reservation = try epochLedger.reserveExpectedEpoch(for: credential)
      epochReservation = reservation
      try epochLedger.ensureReservationIsAdmitted(reservation)
      let socket = try socketFactory.make(credential: credential)
      self.socket = socket
      try await socket.start()
      // A revoke can be persisted by a different signed Host between the
      // admission check and `start`. Close before any handshake frame is read.
      try epochLedger.ensureReservationIsAdmitted(reservation)
      let transport = try RelayHostTransport(credential: credential, agreement: agreement, socket: socket, clock: clock, random: random, expectedConnectionEpoch: reservation.epoch, reconciliationEpoch: reservation.reconciliationEpoch, finalizeConnectionEpoch: { [epochLedger] epoch in try epochLedger.finalize(reservation, connectionEpoch: epoch) }, ensureConnectionAdmitted: { [epochLedger] in try epochLedger.ensureReservationIsAdmitted(reservation) }, flightTimeoutNanoseconds: flightTimeoutNanoseconds)
      self.transport = transport
      try await transport.processOneInbound()
      try await transport.processOneInbound()
      try await transport.processOneInbound()
      try await transport.processOneInbound()
      value = .established
    } catch {
      await stop()
      throw error
    }
  }

  public func sendCiphertext(_ plaintext: Data) async throws {
    guard value == .established, let transport, let epochReservation else { throw RelayOwnerError.invalidState }
    do {
      try epochLedger.ensureReservationIsAdmitted(epochReservation)
      try await transport.sendCiphertext(plaintext)
    }
    catch {
      await stop()
      throw error
    }
  }

  public func receiveCiphertext() async throws -> Data {
    guard value == .established, let transport, let epochReservation else { throw RelayOwnerError.invalidState }
    do {
      try epochLedger.ensureReservationIsAdmitted(epochReservation)
      return try await transport.receiveCiphertext()
    }
    catch {
      await stop()
      throw error
    }
  }

  public func stop() async {
    guard value != .stopped else { return }
    value = .stopped
    if let transport {
      await transport.stop()
      self.transport = nil
    } else if let socket {
      await socket.close()
    }
    socket = nil
    if let epochReservation {
      epochLedger.release(epochReservation)
      self.epochReservation = nil
    }
    if coordinatorClaimed {
      await connectionCoordinator.release(self, credential: credential)
      coordinatorClaimed = false
    }
  }
}
