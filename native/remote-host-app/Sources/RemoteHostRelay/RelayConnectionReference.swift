import Foundation
import RemoteHostWire

/** Distinguishes authenticated connection-open facts from strict FD198 connection references. */
public struct RelayConnectionReference: Sendable {
  private let connectionId: String
  public let metadata: Data
  private static let openKeys: Set<String> = [
    "connectionId", "deviceId", "enrollmentId", "signingPublicKey",
    "agreementPublicKey", "routeId", "generation", "connectionEpoch",
  ]
  private static let closeReasons: Set<String> = [
    "gateway-disposed", "protocol-rejected", "unauthorized-device", "superseded", "transport-failed",
  ]

  /** Accepts Host-owned open metadata and derives the one-field frame/send reference. */
  public init(openMetadata: Data) throws {
    let object = try Self.object(openMetadata, keys: Self.openKeys)
    guard let id = object["connectionId"] as? String,
          id.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$", options: .regularExpression) != nil
    else { throw RelayOwnerError.invalidCredential }
    connectionId = id
    metadata = try JSONSerialization.data(withJSONObject: ["connectionId": id], options: [.sortedKeys])
  }

  /** Requires the exact child send schema; member order and JSON escaping do not affect identity. */
  public func matchesSend(_ candidate: Data) -> Bool {
    guard let object = try? Self.object(candidate, keys: ["connectionId"]) else { return false }
    return object["connectionId"] as? String == connectionId
  }

  /** Requires the exact child close schema and a fixed gateway close reason. */
  public func matchesClose(_ candidate: Data) -> Bool {
    guard let object = try? Self.object(candidate, keys: ["connectionId", "reason"]),
          let reason = object["reason"] as? String, Self.closeReasons.contains(reason)
    else { return false }
    return object["connectionId"] as? String == connectionId
  }

  private static func object(_ data: Data, keys: Set<String>) throws -> [String: Any] {
    guard !data.isEmpty, data.count <= RemoteWire.maximumMetadataBytes else { throw RelayOwnerError.invalidCredential }
    let object = try strictJSONObject(data)
    guard Set(object.keys) == keys else { throw RelayOwnerError.invalidCredential }
    return object
  }
}
