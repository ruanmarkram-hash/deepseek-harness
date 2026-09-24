import Foundation

/** Fixed local diagnostics only; relay control messages never authorize state changes. */
public enum RelayPeerInputDiagnostic: String, Sendable {
  case malformedFlight = "malformed-flight"
  case routeTupleMismatch = "route-tuple-mismatch"
  case epochMismatch = "connection-epoch-mismatch"
  case keyMaterialInvalid = "key-material-invalid"
  case relayHandshakeTimeout = "relay-reported-handshake-timeout"
  case relayPeerDisconnected = "relay-reported-peer-disconnected"
  case relayRouteRotated = "relay-reported-route-rotated"
  case relayRouteRevoked = "relay-reported-route-revoked"
  case relayHandshakeDenied = "relay-reported-handshake-denied"
  case relaySequenceDenied = "relay-reported-sequence-denied"
  case relayRecipientUnavailable = "relay-reported-recipient-unavailable"
  case relayRecipientOffline = "relay-reported-recipient-offline"
  case relayMalformedMessage = "relay-reported-malformed-message"
  case relaySenderDenied = "relay-reported-sender-denied"

  /** Recognizes only bounded, exact server control envelopes and fixed reason values. */
  static func control(_ data: Data) -> Self? {
    guard data.count <= 1024, let object = try? strictJSONObject(data),
          let version = object["version"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID(), version == 3,
          let type = object["type"] as? String else { return nil }
    switch type {
    case "route-revoked":
      guard Set(object.keys) == ["version", "type", "reason"], let reason = object["reason"] as? String else { return nil }
      switch reason {
      case "handshake-timeout": return .relayHandshakeTimeout
      case "peer-disconnected": return .relayPeerDisconnected
      case "route-rotated": return .relayRouteRotated
      case "route-revoked": return .relayRouteRevoked
      case "handshake-denied": return .relayHandshakeDenied
      case "sequence-denied": return .relaySequenceDenied
      case "recipient-unavailable": return .relayRecipientUnavailable
      default: return nil
      }
    case "relay-error":
      guard Set(object.keys) == ["version", "type", "code"], let code = object["code"] as? String else { return nil }
      switch code {
      case "recipient-offline": return .relayRecipientOffline
      case "malformed-message": return .relayMalformedMessage
      case "sender-denied": return .relaySenderDenied
      case "route-revoked": return .relayRouteRevoked
      default: return nil
      }
    default: return nil
    }
  }
}

/** A fixed phase and category, never the rejected frame or underlying error text. */
public struct RelayHostConnectionRejection: Error, CustomStringConvertible, Equatable {
  public let phase: RelayHostConnectionTimeout.Phase
  public let reason: RelayPeerInputDiagnostic
  public var description: String { "connectionRejected (\(phase.rawValue), \(reason.rawValue))" }
}
