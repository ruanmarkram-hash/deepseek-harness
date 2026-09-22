import CryptoKit
import Foundation
import Testing
@testable import RemoteHostRelay

private final class PairingRepairStore: @unchecked Sendable, RelaySecretStore {
  let connectionEpochCoordinator: any RelayConnectionEpochCoordinator = RelayConnectionEpochInMemoryCoordinator()
  var active: RelayRouteCredential?
  var route: RelayRouteCredential?
  var pending: RelayRouteCredential?
  var cleanup: RelayRouteCredential?
  var epoch: RelayConnectionEpochState?
  var writes = 0
  func provisioningCredential() throws -> RelayProvisioningCredential { throw RelayOwnerError.unavailable }
  func routeCredential(routeId: String) throws -> RelayRouteCredential? { route }
  func saveRouteCredential(_ credential: RelayRouteCredential) throws { writes += 1 }
  func removeRouteCredential(routeId: String) throws { writes += 1 }
  func activeRouteCredential() throws -> RelayRouteCredential? { active }
  func saveActiveRouteCredential(_ credential: RelayRouteCredential) throws { writes += 1 }
  func removeActiveRouteCredential(routeId: String) throws { writes += 1 }
  func pendingRouteCredential() throws -> RelayRouteCredential? { pending }
  func savePendingRouteCredential(_ credential: RelayRouteCredential) throws { writes += 1 }
  func removePendingRouteCredential(routeId: String) throws { writes += 1 }
  func revokedCleanupRouteCredential() throws -> RelayRouteCredential? { cleanup }
  func saveRevokedCleanupRouteCredential(_ credential: RelayRouteCredential) throws { writes += 1 }
  func removeRevokedCleanupRouteCredential(routeId: String) throws { writes += 1 }
  func connectionEpochState(routeId: String) throws -> RelayConnectionEpochState? { epoch }
  func saveConnectionEpochState(_ state: RelayConnectionEpochState) throws { writes += 1 }
  func removeConnectionEpochState(routeId: String) throws { writes += 1 }
}

private func eligibleRepairStore() throws -> PairingRepairStore {
  func key(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
  let credential = try RelayRouteCredential(
    routeId: String(repeating: "r", count: 16), hostDeviceId: String(repeating: "h", count: 16), hostEnrollmentId: String(repeating: "e", count: 16),
    deviceId: String(repeating: "d", count: 16), deviceEnrollmentId: String(repeating: "e", count: 16),
    deviceSigningPublicKey: key(Data(repeating: 9, count: 32)),
    deviceAgreementPublicKey: key(Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 3, count: 32)).publicKey.rawRepresentation),
    generation: 1, hostToken: String(repeating: "H", count: 32), deviceToken: String(repeating: "D", count: 32)
  )
  let store = PairingRepairStore()
  store.active = credential; store.route = credential
  store.epoch = try .initial(routeId: credential.routeId)
  return store
}

@Test("repair native admission holds the sole route lease without changing credentials or epoch")
func pairingRepairNativeEligibility() throws {
  let store = try eligibleRepairStore()
  let before = store.epoch
  let result = try RelayPairingRepairEligibility.withEligibleRoute(store: store) { credential in credential.generation }
  #expect(result == 1 && store.writes == 0 && store.epoch == before)
  let lease = try store.connectionEpochCoordinator.acquireLease(routeId: store.active!.routeId)
  #expect(throws: RelayPairingRepairRefusal.self) { try RelayPairingRepairEligibility.withEligibleRoute(store: store) { _ in true } }
  lease.release()
  #expect(try RelayPairingRepairEligibility.withEligibleRoute(store: store) { _ in true })
}

@Test("native pending, used, revoked, absent and inconsistent states cannot enter repair")
func pairingRepairNativeRefusals() throws {
  for scenario in 0..<8 {
    let store = try eligibleRepairStore()
    let route = store.active!
    switch scenario {
    case 0: store.pending = route
    case 1: store.cleanup = route
    case 2: store.epoch = try RelayConnectionEpochState(routeId: route.routeId, lastCommittedEpoch: 1, pendingEpoch: nil)
    case 3: store.epoch = try RelayConnectionEpochState(routeId: route.routeId, lastCommittedEpoch: 0, pendingEpoch: 1)
    case 4: store.epoch = try RelayConnectionEpochState(routeId: route.routeId, lastCommittedEpoch: 0, pendingEpoch: nil, leaseOwner: nil, revoking: true)
    case 5: store.epoch = nil
    case 6: store.route = nil
    default: store.active = nil
    }
    var called = false
    #expect(throws: RelayPairingRepairRefusal.self) { try RelayPairingRepairEligibility.withEligibleRoute(store: store) { _ in called = true; return true } }
    #expect(!called && store.writes == 0)
  }
}
