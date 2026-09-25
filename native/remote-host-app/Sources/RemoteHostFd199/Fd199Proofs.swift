import CryptoKit
import Foundation

/// One manifest entry of the attested stopped-owner export.
public struct Fd199ManifestEntry: Equatable, Sendable {
  public let name: String
  public let sha256: String
  public let size: Int

  public init(name: String, sha256: String, size: Int) {
    self.name = name
    self.sha256 = sha256
    self.size = size
  }
}

/// The durable journal record for one ownership transition.
public struct Fd199JournalRecord: Equatable, Sendable {
  public let version: Int
  public let exportId: String
  public let stoppedAt: String
  public let generation: Int
  public let status: Fd199OwnershipStatus
  public let exportProof: String
  public let activationProof: String?
  public let manifest: [Fd199ManifestEntry]
  public let manifestDigest: String

  public init(
    version: Int,
    exportId: String,
    stoppedAt: String,
    generation: Int,
    status: Fd199OwnershipStatus,
    exportProof: String,
    activationProof: String?,
    manifest: [Fd199ManifestEntry],
    manifestDigest: String
  ) {
    self.version = version
    self.exportId = exportId
    self.stoppedAt = stoppedAt
    self.generation = generation
    self.status = status
    self.exportProof = exportProof
    self.activationProof = activationProof
    self.manifest = manifest
    self.manifestDigest = manifestDigest
  }
}

/// The signing identity the authority uses for export and activation proofs.
/// Production supplies the protected Host identity handle; tests supply a
/// generated Curve25519 key.
public protocol Fd199SigningIdentity: Sendable {
  /// The 32-byte Ed25519 public key.
  var publicKey: Data { get }
  /// Signs one canonical payload with the protected private key.
  func signature(_ payload: Data) throws -> Data
}

/// Curve25519 signing identity over an in-memory private key (test and
/// bootstrap use; the sealed app supplies its Keychain-backed handle).
public struct Fd199StaticSigningIdentity: Fd199SigningIdentity {
  private let privateKey: Curve25519.Signing.PrivateKey

  public init(privateKey: Curve25519.Signing.PrivateKey) {
    self.privateKey = privateKey
  }

  public init() throws {
    self.privateKey = Curve25519.Signing.PrivateKey()
  }

  public var publicKey: Data {
    privateKey.publicKey.rawRepresentation
  }

  public func signature(_ payload: Data) throws -> Data {
    try privateKey.signature(for: payload)
  }
}

/// Canonical proof construction and verification. The payload bytes are the
/// exact UTF-8 of the fixed-key-order JSON the TypeScript peer and the Swift
/// authority both reproduce; no serialization library participates.
public enum Fd199Proofs {
  /// Newly exported records use version 3; recovery separately admits version 2.
  public static let recordVersion = 3

  /**
   Builds the canonical export-proof payload: the stopped-owner fact, the
   export identity, the stopped instant, and every manifest entry digest.
   */
  public static func exportPayload(exportId: String, stoppedAt: String, manifest: [Fd199ManifestEntry], version: Int = recordVersion) -> Data {
    let entries = manifest.map { entry in
      "{\"name\":\(jsonString(entry.name)),\"sha256\":\(jsonString(entry.sha256)),\"size\":\(entry.size)}"
    }.joined(separator: ",")
    let text = "{\"exportId\":\(jsonString(exportId)),\"files\":[\(entries)],\"ownerState\":\"web-owner-stopped\",\"stoppedAt\":\(jsonString(stoppedAt)),\"version\":\(version)}"
    return Data(text.utf8)
  }

  /**
   Builds the canonical activation-proof payload: the export identity, its
   manifest digest, and the exact ownership generation being consumed.
   */
  public static func activationPayload(exportId: String, manifestDigest: String, generation: Int, version: Int = recordVersion) -> Data {
    let text = "{\"exportId\":\(jsonString(exportId)),\"generation\":\(generation),\"manifestDigest\":\(jsonString(manifestDigest)),\"version\":\(version)}"
    return Data(text.utf8)
  }

  /**
   Computes the manifest digest: SHA-256 over the canonical manifest JSON.
   */
  public static func manifestDigest(_ manifest: [Fd199ManifestEntry]) -> String {
    let entries = manifest.map { entry in
      "{\"name\":\(jsonString(entry.name)),\"sha256\":\(jsonString(entry.sha256)),\"size\":\(entry.size)}"
    }.joined(separator: ",")
    return Data(SHA256.hash(data: Data("[\(entries)]".utf8))).hexString
  }

  /**
   Signs the export payload and returns its unpadded base64url proof text.
   */
  public static func signExport(
    _ identity: Fd199SigningIdentity,
    exportId: String,
    stoppedAt: String,
    manifest: [Fd199ManifestEntry],
    version: Int = recordVersion
  ) throws -> String {
    base64url(try identity.signature(exportPayload(exportId: exportId, stoppedAt: stoppedAt, manifest: manifest, version: version)))
  }

  /**
   Signs the activation payload and returns its unpadded base64url proof text.
   */
  public static func signActivation(
    _ identity: Fd199SigningIdentity,
    exportId: String,
    manifestDigest: String,
    generation: Int,
    version: Int = recordVersion
  ) throws -> String {
    base64url(try identity.signature(activationPayload(exportId: exportId, manifestDigest: manifestDigest, generation: generation, version: version)))
  }

  /**
   Verifies one unpadded base64url export proof against the pinned identity.
   */
  public static func verifyExport(
    _ proofText: String,
    identity: Fd199SigningIdentity,
    exportId: String,
    stoppedAt: String,
    manifest: [Fd199ManifestEntry],
    version: Int = recordVersion
  ) throws {
    let signature = try decodeProof(proofText)
    guard let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: identity.publicKey) else {
      throw Fd199Error.proof
    }
    guard publicKey.isValidSignature(signature, for: exportPayload(exportId: exportId, stoppedAt: stoppedAt, manifest: manifest, version: version)) else {
      throw Fd199Error.proof
    }
  }

  /**
   Verifies one unpadded base64url activation proof against the pinned identity.
   */
  public static func verifyActivation(
    _ proofText: String,
    identity: Fd199SigningIdentity,
    exportId: String,
    manifestDigest: String,
    generation: Int,
    version: Int = recordVersion
  ) throws {
    let signature = try decodeProof(proofText)
    guard let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: identity.publicKey) else {
      throw Fd199Error.proof
    }
    guard publicKey.isValidSignature(signature, for: activationPayload(exportId: exportId, manifestDigest: manifestDigest, generation: generation, version: version)) else {
      throw Fd199Error.proof
    }
  }

  static func decodeProof(_ proofText: String) throws -> Data {
    guard proofText.count >= 86, proofText.count <= 8_192,
          proofText.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
      throw Fd199Error.proof
    }
    var base64 = proofText.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))
    guard let signature = Data(base64Encoded: base64), signature.count == 64 else { throw Fd199Error.proof }
    return signature
  }
}

extension Data {
  /// Lowercase hexadecimal text of these bytes.
  var hexString: String {
    map { String(format: "%02x", $0) }.joined()
  }
}

func base64url(_ value: Data) -> String {
  value.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

func jsonString(_ value: String) -> String {
  var escaped = ""
  for character in value {
    switch character {
    case "\"": escaped.append("\\\"")
    case "\\": escaped.append("\\\\")
    case "\n": escaped.append("\\n")
    case "\r": escaped.append("\\r")
    case "\t": escaped.append("\\t")
    default:
      if let scalar = character.unicodeScalars.first, scalar.value < 0x20 {
        escaped.append(String(format: "\\u%04x", scalar.value))
      } else {
        escaped.append(character)
      }
    }
  }
  return "\"\(escaped)\""
}
