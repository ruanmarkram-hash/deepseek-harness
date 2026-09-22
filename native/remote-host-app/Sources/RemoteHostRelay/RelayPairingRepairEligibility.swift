import Foundation

/** Sanitized local refusal reasons; no Keychain error or credential value is rendered. */
public enum RelayPairingRepairRefusal: String, Error {
  case noActiveRoute = "Repair refused: no active pairing credential is available."
  case activeOwner = "Repair refused: the route is owned or its native coordinator is unavailable."
  case credentialChanged = "Repair refused: the active native route records disagree."
  case recoveryPending = "Repair refused: native revocation or provisioning recovery is pending."
  case epochUnavailable = "Repair refused: native epoch state is missing, used, pending, revoking or leased."
}

/** Holds the existing route lease while a local, offline repair inspects its public projection. */
public enum RelayPairingRepairEligibility {
  public static func withEligibleRoute<T: Sendable>(
    store: RelaySecretStore,
    operation: (RelayRouteCredential) throws -> T
  ) throws -> T {
    guard let credential = try store.activeRouteCredential() else { throw RelayPairingRepairRefusal.noActiveRoute }
    let lease: any RelayConnectionEpochCoordinatorLease
    do { lease = try store.connectionEpochCoordinator.acquireLease(routeId: credential.routeId) }
    catch { throw RelayPairingRepairRefusal.activeOwner }
    defer { lease.release() }
    return try store.connectionEpochCoordinator.withTransaction(routeId: credential.routeId) {
      guard try store.activeRouteCredential() == credential,
            try store.routeCredential(routeId: credential.routeId) == credential
      else { throw RelayPairingRepairRefusal.credentialChanged }
      guard try store.pendingRouteCredential() == nil, try store.revokedCleanupRouteCredential() == nil
      else { throw RelayPairingRepairRefusal.recoveryPending }
      guard let epoch = try store.connectionEpochState(routeId: credential.routeId),
            epoch.routeId == credential.routeId, epoch.lastCommittedEpoch == 0,
            epoch.pendingEpoch == nil, !epoch.revoking, epoch.leaseOwner == nil
      else { throw RelayPairingRepairRefusal.epochUnavailable }
      return try operation(credential)
    }
  }
}
