import Foundation
import RemoteHostWire

/** Fixed public projection of a native-finalized epoch; no credential values enter the wire. */
public enum RelayFinalizedEpochWire {
  public static func request(credential: RelayRouteCredential, epoch: Int) throws -> RemoteWireRecord {
    guard epoch > 0, epoch <= 2_147_483_647 else { throw RelayOwnerError.invalidCredential }
    let metadata = try JSONSerialization.data(withJSONObject: [
      "routeId": credential.routeId, "deviceId": credential.deviceId,
      "deviceEnrollmentId": credential.deviceEnrollmentId, "hostDeviceId": credential.hostDeviceId,
      "hostEnrollmentId": credential.hostEnrollmentId, "generation": credential.generation,
      "connectionEpoch": epoch,
    ], options: [.sortedKeys])
    return RemoteWireRecord(kind: .epochSynchronize, metadata: metadata)
  }

  /** Reject wrong-direction, nonempty, ambiguous, or mismatched child acknowledgments. */
  public static func validate(_ receipt: RemoteWireRecord, expected: RemoteWireRecord) throws {
    guard expected.kind == .epochSynchronize, receipt.kind == .epochSynchronized, receipt.payload.isEmpty,
          let actual = try? strictJSONObject(receipt.metadata),
          let required = try? strictJSONObject(expected.metadata),
          let actualData = try? JSONSerialization.data(withJSONObject: actual, options: [.sortedKeys]),
          let requiredData = try? JSONSerialization.data(withJSONObject: required, options: [.sortedKeys]),
          actualData == requiredData
    else { throw RelayOwnerError.invalidCredential }
  }
}
