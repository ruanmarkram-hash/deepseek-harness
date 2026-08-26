import Foundation

/** A sealed, per-route owner lease. Its release must be idempotent. */
public protocol RelayConnectionEpochCoordinatorLease: AnyObject, Sendable {
  func release()
}

/**
 * Serializes epoch ownership and short Keychain read-modify-write intervals.
 *
 * Production uses the nested, code-authorized XPC service. The in-process
 * implementation exists only for unit stores and disappears with its process.
 */
public protocol RelayConnectionEpochCoordinator: AnyObject, Sendable {
  func acquireLease(routeId: String) throws -> any RelayConnectionEpochCoordinatorLease
  func withTransaction<T: Sendable>(routeId: String, _ operation: () throws -> T) throws -> T
}

/**
 * Native-only durable epoch state for one active V3 route.
 *
 * `pendingEpoch` is preserved when a socket write or process exit makes the
 * outcome uncertain. A retry must use that exact value rather than advancing.
 */
public struct RelayConnectionEpochState: Codable, Equatable, Sendable {
  public let routeId: String
  public let lastCommittedEpoch: Int
  public let pendingEpoch: Int?
  let leaseOwner: UUID?
  let revoking: Bool

  public init(routeId: String, lastCommittedEpoch: Int, pendingEpoch: Int?) throws {
    guard matches(routeID, routeId),
          lastCommittedEpoch >= 0, lastCommittedEpoch <= RelayConnectionEpoch.maximum,
          pendingEpoch.map({ $0 >= 1 && $0 <= RelayConnectionEpoch.maximum && $0 == lastCommittedEpoch + 1 }) ?? true
    else { throw RelayOwnerError.invalidCredential }
    self.routeId = routeId
    self.lastCommittedEpoch = lastCommittedEpoch
    self.pendingEpoch = pendingEpoch
    leaseOwner = nil
    revoking = false
  }

  init(routeId: String, lastCommittedEpoch: Int, pendingEpoch: Int?, leaseOwner: UUID?, revoking: Bool) throws {
    guard matches(routeID, routeId), lastCommittedEpoch >= 0, lastCommittedEpoch <= RelayConnectionEpoch.maximum,
          pendingEpoch.map({ $0 >= 1 && $0 <= RelayConnectionEpoch.maximum && $0 == lastCommittedEpoch + 1 }) ?? true
    else { throw RelayOwnerError.invalidCredential }
    self.routeId = routeId; self.lastCommittedEpoch = lastCommittedEpoch; self.pendingEpoch = pendingEpoch
    self.leaseOwner = leaseOwner; self.revoking = revoking
  }


  static func initial(routeId: String) throws -> RelayConnectionEpochState {
    try RelayConnectionEpochState(routeId: routeId, lastCommittedEpoch: 0, pendingEpoch: nil)
  }
}

/** An opaque, route-bound epoch held only by the signed Host connection owner. */
public struct RelayConnectionEpochReservation: Equatable, Sendable {
  public let routeId: String
  public let generation: Int
  public let epoch: Int
  let reconciliationEpoch: Int?
  fileprivate let credential: RelayRouteCredential
  fileprivate let owner: UUID

  fileprivate init(credential: RelayRouteCredential, epoch: Int, reconciliationEpoch: Int?, owner: UUID) {
    routeId = credential.routeId
    generation = credential.generation
    self.epoch = epoch
    self.reconciliationEpoch = reconciliationEpoch
    self.credential = credential
    self.owner = owner
  }
}

/**
 * Serializes exact-next V3 epoch ownership for an active Keychain route.
 *
 * Reservation is durable before any WebSocket is constructed. Commit occurs
 * only after the encrypted `commit` record was accepted by the socket adapter.
 * A failed or uncertain attempt deliberately leaves the reservation pending.
 */
public final class RelayConnectionEpochLedger: @unchecked Sendable {
  private let lock = NSLock()
  private let store: RelaySecretStore
  private let coordinator: any RelayConnectionEpochCoordinator
  private let owner = UUID()
  private var reservations: [String: RelayConnectionEpochReservation] = [:]
  private var coordinatorLeases: [String: any RelayConnectionEpochCoordinatorLease] = [:]

  public init(store: RelaySecretStore) {
    self.store = store
    coordinator = store.connectionEpochCoordinator
  }

  /**
   * One-time migration for routes paired by a Host release that predates the
   * durable epoch record. It may create only the initial zero-epoch state for
   * the exact active credential, under the same sealed XPC transaction used by
   * normal reservations. Existing or revoking state is never replaced.
   */
  public static func initializeMissingState(for credential: RelayRouteCredential, store: RelaySecretStore) throws {
    try store.connectionEpochCoordinator.withTransaction(routeId: credential.routeId) {
      guard let active = try store.activeRouteCredential(), active == credential else {
        throw RelayOwnerError.unavailable
      }
      if let existing = try store.connectionEpochState(routeId: credential.routeId) {
        guard existing.routeId == credential.routeId, !existing.revoking else {
          throw RelayOwnerError.unavailable
        }
        return
      }
      try store.saveConnectionEpochState(try RelayConnectionEpochState.initial(routeId: credential.routeId))
    }
  }

  /** Reserves the active route's pending epoch or creates its exact next epoch. */
  public func reserveExpectedEpoch(for credential: RelayRouteCredential) throws -> RelayConnectionEpochReservation {
    try lock.withLock {
      if let reservation = reservations[credential.routeId] {
        guard reservation.credential == credential else { throw RelayOwnerError.unavailable }
        return reservation
      }
      let lease = try coordinator.acquireLease(routeId: credential.routeId)
      do {
      let reservation = try coordinator.withTransaction(routeId: credential.routeId) { () throws -> RelayConnectionEpochReservation in
        guard let active = try store.activeRouteCredential(), active == credential,
              let state = try store.connectionEpochState(routeId: credential.routeId), state.routeId == credential.routeId,
              !state.revoking
        else { throw RelayOwnerError.unavailable }
        let epoch: Int
        if let pending = state.pendingEpoch { epoch = pending }
        else {
          guard state.lastCommittedEpoch < RelayConnectionEpoch.maximum else { throw RelayOwnerError.invalidState }
          epoch = state.lastCommittedEpoch + 1
        }
        let next = try RelayConnectionEpochState(routeId: state.routeId, lastCommittedEpoch: state.lastCommittedEpoch, pendingEpoch: epoch, leaseOwner: nil, revoking: state.revoking)
        try store.saveConnectionEpochState(next)
        return RelayConnectionEpochReservation(credential: credential, epoch: epoch, reconciliationEpoch: state.lastCommittedEpoch == 0 ? nil : state.lastCommittedEpoch, owner: owner)
      }
      reservations[credential.routeId] = reservation
      coordinatorLeases[credential.routeId] = lease
      return reservation
      } catch {
        lease.release()
        throw error
      }
    }
  }

  /**
   * Atomically finalizes the authenticated epoch after device `confirm`.
   *
   * An exact pending epoch advances durable state. A prior committed epoch is
   * accepted only while this same Host lease has reserved its next epoch, which
   * reconciles a lost receipt without accepting an arbitrary stale connection.
   */
  public func finalize(_ reservation: RelayConnectionEpochReservation, connectionEpoch: Int) throws {
    try lock.withLock {
      guard reservation.owner == owner, reservations[reservation.routeId] == reservation, coordinatorLeases[reservation.routeId] != nil else { throw RelayOwnerError.unavailable }
      try coordinator.withTransaction(routeId: reservation.routeId) {
        guard let active = try store.activeRouteCredential(), active == reservation.credential,
              let state = try store.connectionEpochState(routeId: reservation.routeId), !state.revoking
        else { throw RelayOwnerError.unavailable }
        if connectionEpoch == reservation.epoch, state.pendingEpoch == reservation.epoch, reservation.epoch == state.lastCommittedEpoch + 1 {
          try store.saveConnectionEpochState(try RelayConnectionEpochState(routeId: state.routeId, lastCommittedEpoch: reservation.epoch, pendingEpoch: nil, leaseOwner: nil, revoking: state.revoking))
        } else if connectionEpoch == reservation.reconciliationEpoch, state.lastCommittedEpoch == connectionEpoch, state.pendingEpoch == reservation.epoch { return }
        else { throw RelayOwnerError.unavailable }
      }
    }
  }

  /** Releases a stopped connection without changing an uncommitted pending epoch. */
  public func release(_ reservation: RelayConnectionEpochReservation) {
    lock.withLock {
      guard reservation.owner == owner, reservations[reservation.routeId] == reservation else { return }
      reservations.removeValue(forKey: reservation.routeId)
      let coordinatorLease = coordinatorLeases.removeValue(forKey: reservation.routeId)
      try? coordinator.withTransaction(routeId: reservation.routeId) {
        guard let state = try store.connectionEpochState(routeId: reservation.routeId) else { return }
        try store.saveConnectionEpochState(try RelayConnectionEpochState(routeId: state.routeId, lastCommittedEpoch: state.lastCommittedEpoch, pendingEpoch: state.pendingEpoch, leaseOwner: nil, revoking: state.revoking))
      }
      coordinatorLease?.release()
    }
  }

  /** Rechecks durable admission before opening or using a leased socket. */
  public func ensureReservationIsAdmitted(_ reservation: RelayConnectionEpochReservation) throws {
    try lock.withLock {
      guard reservation.owner == owner, reservations[reservation.routeId] == reservation, coordinatorLeases[reservation.routeId] != nil else { throw RelayOwnerError.unavailable }
      try coordinator.withTransaction(routeId: reservation.routeId) {
        guard let active = try store.activeRouteCredential(), active == reservation.credential,
              let state = try store.connectionEpochState(routeId: reservation.routeId), !state.revoking
        else { throw RelayOwnerError.unavailable }
        let reserved = state.pendingEpoch == reservation.epoch
        let finalized = state.lastCommittedEpoch == reservation.epoch && state.pendingEpoch == nil
        let reconciled = reservation.reconciliationEpoch == state.lastCommittedEpoch && state.pendingEpoch == reservation.epoch
        guard reserved || finalized || reconciled else { throw RelayOwnerError.unavailable }
      }
    }
  }

  /** Persists revocation admission denial before an active socket is fenced. */
  public static func beginRevocation(for credential: RelayRouteCredential, store: RelaySecretStore) throws {
    try store.connectionEpochCoordinator.withTransaction(routeId: credential.routeId) {
      guard let active = try store.activeRouteCredential(), active == credential,
            let state = try store.connectionEpochState(routeId: credential.routeId)
      else { throw RelayOwnerError.unavailable }
      try store.saveConnectionEpochState(try RelayConnectionEpochState(routeId: state.routeId, lastCommittedEpoch: state.lastCommittedEpoch, pendingEpoch: state.pendingEpoch, leaseOwner: nil, revoking: true))
    }
  }
}


/** Coordinates the one native Host socket permitted to own a route at a time. */
public protocol RelayActiveRouteConnectionOwner: Sendable {
  func beginRevocation(for credential: RelayRouteCredential) async
  func finishRevocation(for credential: RelayRouteCredential) async
  func stopConnection(for credential: RelayRouteCredential) async
}

/**
 * Host-owned route coordinator. It admits one supervisor for each route and
 * fences it before lifecycle revoke or compensation can remove credentials.
 */
public actor RelayHostRouteConnectionCoordinator: RelayActiveRouteConnectionOwner {
  private let store: RelaySecretStore
  private var supervisors: [String: RelayHostSocketSupervisor] = [:]
  private var revokingRoutes = Set<String>()

  public init(store: RelaySecretStore) { self.store = store }

  func claim(_ supervisor: RelayHostSocketSupervisor, credential: RelayRouteCredential) throws {
    guard !revokingRoutes.contains(credential.routeId), supervisors[credential.routeId] == nil,
          let active = try store.activeRouteCredential(), active == credential,
          let epoch = try store.connectionEpochState(routeId: credential.routeId), !epoch.revoking
    else { throw RelayOwnerError.unavailable }
    supervisors[credential.routeId] = supervisor
  }

  func release(_ supervisor: RelayHostSocketSupervisor, credential: RelayRouteCredential) {
    guard let current = supervisors[credential.routeId], current === supervisor else { return }
    supervisors.removeValue(forKey: credential.routeId)
  }

  public func beginRevocation(for credential: RelayRouteCredential) async {
    revokingRoutes.insert(credential.routeId)
    await stopConnection(for: credential)
  }

  public func finishRevocation(for credential: RelayRouteCredential) async {
    revokingRoutes.remove(credential.routeId)
  }

  public func stopConnection(for credential: RelayRouteCredential) async {
    guard let supervisor = supervisors.removeValue(forKey: credential.routeId) else { return }
    await supervisor.stop()
  }
}

private enum RelayConnectionEpoch {
  static let maximum = 2_147_483_647
}
