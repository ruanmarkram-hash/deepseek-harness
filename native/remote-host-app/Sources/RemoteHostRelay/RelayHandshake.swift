import Foundation

/** Parses one JSON object only after rejecting duplicate object-member names at every depth. */
func strictJSONObject(_ data: Data) throws -> [String: Any] {
  var scanner = StrictJSONDuplicateKeyScanner(bytes: Array(data))
  try scanner.document()
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw RelayOwnerError.invalidCredential }
  return object
}

/** Minimal JSON grammar scanner used before Foundation's duplicate-key-collapsing object decoder. */
private struct StrictJSONDuplicateKeyScanner {
  private let bytes: [UInt8]
  private var index = 0

  init(bytes: [UInt8]) { self.bytes = bytes }

  mutating func document() throws {
    whitespace()
    guard peek() == 0x7b else { throw RelayOwnerError.invalidCredential }
    try value()
    whitespace()
    guard index == bytes.count else { throw RelayOwnerError.invalidCredential }
  }

  private mutating func value() throws {
    whitespace()
    guard let current = peek() else { throw RelayOwnerError.invalidCredential }
    switch current {
    case 0x7b: try object()
    case 0x5b: try array()
    case 0x22: _ = try string()
    case 0x74: try literal([0x74, 0x72, 0x75, 0x65])
    case 0x66: try literal([0x66, 0x61, 0x6c, 0x73, 0x65])
    case 0x6e: try literal([0x6e, 0x75, 0x6c, 0x6c])
    case 0x2d, 0x30...0x39: try number()
    default: throw RelayOwnerError.invalidCredential
    }
  }

  private mutating func object() throws {
    try consume(0x7b)
    whitespace()
    if peek() == 0x7d { index += 1; return }
    var keys = Set<String>()
    while true {
      whitespace()
      let key = try string()
      guard keys.insert(key).inserted else { throw RelayOwnerError.invalidCredential }
      whitespace(); try consume(0x3a); try value(); whitespace()
      guard let next = peek() else { throw RelayOwnerError.invalidCredential }
      if next == 0x7d { index += 1; return }
      try consume(0x2c)
    }
  }

  private mutating func array() throws {
    try consume(0x5b)
    whitespace()
    if peek() == 0x5d { index += 1; return }
    while true {
      try value(); whitespace()
      guard let next = peek() else { throw RelayOwnerError.invalidCredential }
      if next == 0x5d { index += 1; return }
      try consume(0x2c)
    }
  }

  private mutating func string() throws -> String {
    let start = index
    try consume(0x22)
    while let current = peek() {
      if current == 0x22 {
        index += 1
        let encoded = Data([0x5b] + Array(bytes[start..<index]) + [0x5d])
        guard let value = try JSONSerialization.jsonObject(with: encoded) as? [String], value.count == 1 else { throw RelayOwnerError.invalidCredential }
        return value[0]
      }
      guard current >= 0x20 else { throw RelayOwnerError.invalidCredential }
      if current == 0x5c {
        index += 1
        guard let escaped = peek() else { throw RelayOwnerError.invalidCredential }
        if escaped == 0x75 {
          index += 1
          for _ in 0..<4 { guard let digit = peek(), (digit >= 0x30 && digit <= 0x39) || (digit >= 0x41 && digit <= 0x46) || (digit >= 0x61 && digit <= 0x66) else { throw RelayOwnerError.invalidCredential }; index += 1 }
        } else {
          guard [0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].contains(escaped) else { throw RelayOwnerError.invalidCredential }
          index += 1
        }
      } else { index += 1 }
    }
    throw RelayOwnerError.invalidCredential
  }

  private mutating func number() throws {
    if peek() == 0x2d { index += 1 }
    guard let first = peek() else { throw RelayOwnerError.invalidCredential }
    if first == 0x30 { index += 1 }
    else {
      guard first >= 0x31 && first <= 0x39 else { throw RelayOwnerError.invalidCredential }
      repeat { index += 1 } while peek().map({ $0 >= 0x30 && $0 <= 0x39 }) == true
    }
    if peek() == 0x2e {
      index += 1; let start = index
      while peek().map({ $0 >= 0x30 && $0 <= 0x39 }) == true { index += 1 }
      guard index > start else { throw RelayOwnerError.invalidCredential }
    }
    if peek() == 0x45 || peek() == 0x65 {
      index += 1
      if peek() == 0x2b || peek() == 0x2d { index += 1 }
      let start = index
      while peek().map({ $0 >= 0x30 && $0 <= 0x39 }) == true { index += 1 }
      guard index > start else { throw RelayOwnerError.invalidCredential }
    }
  }

  private mutating func literal(_ expected: [UInt8]) throws {
    guard bytes.count - index >= expected.count, bytes[index..<(index + expected.count)].elementsEqual(expected) else { throw RelayOwnerError.invalidCredential }
    index += expected.count
  }

  private mutating func consume(_ expected: UInt8) throws {
    guard peek() == expected else { throw RelayOwnerError.invalidCredential }
    index += 1
  }

  private mutating func whitespace() {
    while peek().map({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0a || $0 == 0x0d }) == true { index += 1 }
  }

  private func peek() -> UInt8? { index < bytes.count ? bytes[index] : nil }
}

/** Protected static X25519 seam. Implementations must retain private material in native code. */
public protocol RelayProtectedAgreement: Sendable {
  var publicKey: String { get }
  func deriveSharedSecret(peerPublicKey: String) throws -> Data
}

public enum RelayFlightKind: String, Sendable { case hello, welcome, ready, finish, ack, commit, confirm, receipt, ciphertext }

/** Strict public V3 envelope. Ciphertext bytes remain opaque until RFC 8439 ChaCha20-Poly1305 authentication succeeds. */
public struct RelayFlight: Equatable, Sendable {
  public let kind: RelayFlightKind
  public let routeId: String
  public let generation: Int
  public let connectionEpoch: Int
  public let senderDeviceId: String
  public let senderEnrollmentId: String
  public let recipientDeviceId: String
  public let recipientEnrollmentId: String
  public let ephemeralPublicKey: String?
  /// Strictly monotonic only on committed ciphertext records.
  public let sequence: Int?
  public let nonce: String?
  public let ciphertext: String?
}

/** Fixed destination and subprotocol constructor. This value has no connect method. */
public struct RelayWebSocketRequest: Equatable, Sendable {
  public let url: URL
  public let protocols: [String]
}

public enum RelayV3WebSocketCodec {
  public static func request(_ credential: RelayRouteCredential) throws -> RelayWebSocketRequest {
    let url = URL(string: "https://dshrelay.rulabs.dev/v3/routes/" + credential.routeId + "/connect")!
    guard url.scheme == "https", url.host == "dshrelay.rulabs.dev", url.port == nil else { throw RelayOwnerError.invalidCredential }
    return RelayWebSocketRequest(url: url, protocols: ["dsh-remote-v3", "dsh-host." + credential.hostToken])
  }
}

/** Exact-key JSON codec for the deployed V3 message vocabulary. */
public enum RelayFlightCodec {
  private static func isBoolean(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
  }
  private static let maxTextBytes = 12 * 1024 * 1024 + 16 * 1024

  private static func base64url(_ value: String, minimum: Int, maximum: Int) -> Bool {
    guard value.count >= minimum && value.count <= maximum && value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return false }
    var padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
    guard let decoded = Data(base64Encoded: padded) else { return false }
    return decoded.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value
  }
  private static func decodedBase64urlCount(_ value: String) -> Int? {
    var padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
    return Data(base64Encoded: padded)?.count
  }

  public static func decode(_ data: Data) throws -> RelayFlight {
    guard !data.isEmpty, data.count <= maxTextBytes,
          let object = try? strictJSONObject(data),
          !isBoolean(object["version"]), object["version"] as? Int == 3,
          let rawKind = object["type"] as? String,
          let kind = RelayFlightKind(rawValue: rawKind)
    else { throw RelayOwnerError.invalidCredential }
    let base = ["version", "type", "routeId", "generation", "connectionEpoch", "senderDeviceId", "senderEnrollmentId", "recipientDeviceId", "recipientEnrollmentId"]
    let extra: [String]
    switch kind {
    case .hello, .welcome: extra = ["ephemeralPublicKey", "nonce"]
    case .ready, .finish, .ack, .commit, .confirm, .receipt: extra = ["nonce", "ciphertext"]
    case .ciphertext: extra = ["sequence", "nonce", "ciphertext"]
    }
    guard Set(object.keys) == Set(base + extra),
          let routeId = object["routeId"] as? String, matches(routeID, routeId),
          !isBoolean(object["generation"]), let generation = object["generation"] as? Int, generation >= 1, generation <= 2_147_483_647,
          !isBoolean(object["connectionEpoch"]), let epoch = object["connectionEpoch"] as? Int, epoch >= 1, epoch <= 2_147_483_647,
          let sender = object["senderDeviceId"] as? String, matches(routeID, sender),
          let senderEnrollment = object["senderEnrollmentId"] as? String, matches(routeID, senderEnrollment),
          let recipient = object["recipientDeviceId"] as? String, matches(routeID, recipient),
          let recipientEnrollment = object["recipientEnrollmentId"] as? String, matches(routeID, recipientEnrollment)
    else { throw RelayOwnerError.invalidCredential }
    let ephemeral = object["ephemeralPublicKey"] as? String
    let sequence = object["sequence"]
    let nonce = object["nonce"] as? String
    let ciphertext = object["ciphertext"] as? String
    let validEphemeral = ephemeral.map { base64url($0, minimum: 43, maximum: 43) } ?? true
    let validNonce = nonce.map { base64url($0, minimum: 16, maximum: 16) } ?? false
    let validCiphertext: Bool
    if kind == .ready || kind == .finish || kind == .ack || kind == .commit || kind == .confirm || kind == .receipt {
      validCiphertext = ciphertext.map { base64url($0, minimum: 23, maximum: 684) && (decodedBase64urlCount($0).map { $0 >= 17 && $0 <= 512 } ?? false) } ?? false
    } else { validCiphertext = ciphertext.map { base64url($0, minimum: 22, maximum: 12 * 1024 * 1024) } ?? true }
    let validSequence: Bool
    if kind == .ciphertext {
      validSequence = !isBoolean(sequence) && (sequence as? Int).map { $0 >= 1 && $0 <= 2_147_483_647 } == true
    } else {
      validSequence = sequence == nil
    }
    guard (kind == .hello || kind == .welcome ? ephemeral != nil && nonce != nil : nonce != nil && ciphertext != nil),
          validSequence,
          validEphemeral, validNonce, validCiphertext
    else { throw RelayOwnerError.invalidCredential }
    return RelayFlight(kind: kind, routeId: routeId, generation: generation, connectionEpoch: epoch, senderDeviceId: sender, senderEnrollmentId: senderEnrollment, recipientDeviceId: recipient, recipientEnrollmentId: recipientEnrollment, ephemeralPublicKey: ephemeral, sequence: sequence as? Int, nonce: nonce, ciphertext: ciphertext)
  }

  /// Emits only host handshake records. Ciphertext records use `encodeCiphertext`
  /// so their monotonic sequence remains owned by the post-commit transport.
  static func encode(_ flight: RelayFlight) throws -> Data {
    guard flight.kind != .ciphertext else { throw RelayOwnerError.invalidState }
    var object: [String: Any] = [
      "version": 3, "type": flight.kind.rawValue, "routeId": flight.routeId,
      "generation": flight.generation, "connectionEpoch": flight.connectionEpoch,
      "senderDeviceId": flight.senderDeviceId, "senderEnrollmentId": flight.senderEnrollmentId,
      "recipientDeviceId": flight.recipientDeviceId, "recipientEnrollmentId": flight.recipientEnrollmentId,
    ]
    if flight.kind == .hello || flight.kind == .welcome {
      guard let key = flight.ephemeralPublicKey, let nonce = flight.nonce else { throw RelayOwnerError.invalidCredential }
      object["ephemeralPublicKey"] = key; object["nonce"] = nonce
    } else {
      guard let nonce = flight.nonce, let ciphertext = flight.ciphertext else { throw RelayOwnerError.invalidCredential }
      object["nonce"] = nonce; object["ciphertext"] = ciphertext
    }
    let encoded = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    _ = try decode(encoded) // Keep encoder and hostile-input decoder exactly coupled.
    return encoded
  }

  /// Encodes one post-commit ciphertext record with its transport-owned sequence.
  static func encodeCiphertext(_ flight: RelayFlight) throws -> Data {
    guard flight.kind == .ciphertext,
          let sequence = flight.sequence, sequence >= 1 && sequence <= 2_147_483_647,
          let nonce = flight.nonce, let ciphertext = flight.ciphertext
    else { throw RelayOwnerError.invalidState }
    let object: [String: Any] = [
      "version": 3, "type": flight.kind.rawValue, "routeId": flight.routeId,
      "generation": flight.generation, "connectionEpoch": flight.connectionEpoch,
      "senderDeviceId": flight.senderDeviceId, "senderEnrollmentId": flight.senderEnrollmentId,
      "recipientDeviceId": flight.recipientDeviceId, "recipientEnrollmentId": flight.recipientEnrollmentId,
      "sequence": sequence, "nonce": nonce, "ciphertext": ciphertext,
    ]
    let encoded = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    _ = try decode(encoded)
    return encoded
  }

  /** Canonical bytes shared with the deployed Noble implementation for 3DH HKDF salt. */
  public static func handshakeContext(hello: RelayFlight, welcome: RelayFlight) throws -> Data {
    guard hello.kind == .hello, welcome.kind == .welcome,
          hello.routeId == welcome.routeId, hello.generation == welcome.generation, hello.connectionEpoch == welcome.connectionEpoch,
          let helloKey = hello.ephemeralPublicKey, let helloNonce = hello.nonce,
          let welcomeKey = welcome.ephemeralPublicKey, let welcomeNonce = welcome.nonce
    else { throw RelayOwnerError.invalidCredential }
    let values: [Any] = ["dsh-remote", 3, hello.routeId, hello.generation, hello.connectionEpoch,
      hello.senderDeviceId, hello.senderEnrollmentId, hello.recipientDeviceId, hello.recipientEnrollmentId, helloKey, helloNonce,
      welcome.senderDeviceId, welcome.senderEnrollmentId, welcome.recipientDeviceId, welcome.recipientEnrollmentId, welcomeKey, welcomeNonce]
    return try JSONSerialization.data(withJSONObject: values, options: [])
  }
}

/** Host-only flight order gate. It deliberately cannot declare a connection live without crypto verification. */
public final class RelayHostHandshakeState: @unchecked Sendable {
  public enum State: Equatable, Sendable { case awaitingHello, mustSendWelcome, awaitingReady, mustSendFinish, awaitingAck, mustSendCommit, awaitingConfirm, mustSendReceipt, unavailable, stopped }
  private let lock = NSLock()
  private var value: State = .awaitingHello
  public var state: State { lock.lock(); defer { lock.unlock() }; return value }

  public func acceptInbound(_ flight: RelayFlight) throws {
    lock.lock(); defer { lock.unlock() }
    switch (value, flight.kind) {
    case (.awaitingHello, .hello): value = .mustSendWelcome
    case (.awaitingReady, .ready): value = .mustSendFinish
    case (.awaitingAck, .ack): value = .mustSendCommit
    case (.awaitingConfirm, .confirm): value = .mustSendReceipt
    default: value = .unavailable; throw RelayOwnerError.invalidState
    }
  }

  public func markWelcomeSent() throws {
    lock.lock(); defer { lock.unlock() }
    guard value == .mustSendWelcome else { value = .unavailable; throw RelayOwnerError.invalidState }
    value = .awaitingReady
  }

  public func markFinishSent() throws {
    lock.lock(); defer { lock.unlock() }
    guard value == .mustSendFinish else { value = .unavailable; throw RelayOwnerError.invalidState }
    value = .awaitingAck
  }

  public func markCommitSent() throws {
    lock.lock(); defer { lock.unlock() }
    guard value == .mustSendCommit else { value = .unavailable; throw RelayOwnerError.invalidState }
    value = .awaitingConfirm
  }

  public func markReceiptSent() throws {
    lock.lock(); defer { lock.unlock() }
    guard value == .mustSendReceipt else { value = .unavailable; throw RelayOwnerError.invalidState }
    value = .unavailable
  }

  public func stop() { lock.lock(); defer { lock.unlock() }; value = .stopped }
}
