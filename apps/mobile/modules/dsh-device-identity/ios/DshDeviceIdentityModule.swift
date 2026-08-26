import CryptoKit
import ExpoModulesCore
import LocalAuthentication
import Security

/**
 The physical device's V3 identity. iOS Secure Enclave does not offer an
 X25519 key class, so the two Curve25519 private keys live in a
 user-presence, this-device-only Keychain item and are never bridged to JS.
 */
public final class DshDeviceIdentityModule: Module {
  private let identity = DshDeviceIdentityStore()
  private let remoteState = DshMobileRemoteStateStore()

  public func definition() -> ModuleDefinition {
    Name("DshDeviceIdentity")

    AsyncFunction("deviceIdentity") { () throws -> [String: String] in
      try self.identity.publicDescriptor()
    }

    AsyncFunction("requireUserPresence") { (promise: Promise) in
      self.identity.requireUserPresence(promise: promise)
    }

    // The shared protocol's protected-agreement API is synchronous. A custom
    // development or production build supplies this JSI function; Expo Go is
    // rejected by the JavaScript provider before enrollment can proceed.
    Function("deriveSharedSecret") { (peerAgreementPublicKey: String) throws -> String in
      try self.identity.deriveSharedSecret(peerAgreementPublicKey: peerAgreementPublicKey)
    }

    Function("clearUserPresence") {
      self.identity.clearUserPresence()
    }

    AsyncFunction("loadRemoteState") { () throws -> String? in
      try self.remoteState.load()
    }

    AsyncFunction("saveRemoteState") { (record: String) throws in
      try self.remoteState.save(record)
    }

    AsyncFunction("clearRemoteState") { () throws in
      try self.remoteState.clear()
    }
  }
}

/**
 The accepted Host route credential, receipt-confirmed epoch, and event cursor.
 This Keychain item is device-only and never contains either Curve25519 private
 key. JavaScript receives it only to construct the already authenticated V3
 connection and never renders or logs it.
 */
private final class DshMobileRemoteStateStore {
  private static let account = "v1-host-remote-state"
  private static let service = "app.dsh.mobile.remote-state"

  func load() throws -> String? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: Self.service,
      kSecAttrAccount: Self.account,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, var data = result as? Data else {
      throw DshIdentityError("The local DSH Host record is unavailable")
    }
    defer { data.resetBytes(in: 0..<data.count) }
    guard let encoded = String(data: data, encoding: .utf8) else {
      throw DshIdentityError("The local DSH Host record is malformed")
    }
    _ = try DshStoredRemoteState.parse(encoded)
    return encoded
  }

  func save(_ encoded: String) throws {
    var data = try DshStoredRemoteState.parse(encoded)
    defer { data.resetBytes(in: 0..<data.count) }
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: Self.service,
      kSecAttrAccount: Self.account,
    ]
    let update = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
    if update == errSecSuccess { return }
    guard update == errSecItemNotFound else {
      throw DshIdentityError("Could not protect the local DSH Host record")
    }
    let creation: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: Self.service,
      kSecAttrAccount: Self.account,
      kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecValueData: data,
    ]
    guard SecItemAdd(creation as CFDictionary, nil) == errSecSuccess else {
      throw DshIdentityError("Could not protect the local DSH Host record")
    }
  }

  func clear() throws {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: Self.service,
      kSecAttrAccount: Self.account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw DshIdentityError("Could not clear the local DSH Host record")
    }
  }
}

/** Strict native validation for the JSON record supplied by the TypeScript owner client. */
private struct DshStoredRemoteState: Decodable {
  let version: Int
  let config: DshStoredRemoteConfig
  let eventCursor: Int
  let expiresAt: String
  let nextConnectionEpoch: Int

  static func parse(_ encoded: String) throws -> Data {
    guard let input = encoded.data(using: .utf8),
      let object = try JSONSerialization.jsonObject(with: input) as? [String: Any],
      Set(object.keys) == Set(["version", "config", "eventCursor", "expiresAt", "nextConnectionEpoch"]),
      let configObject = object["config"] as? [String: Any],
      Set(configObject.keys) == Set(["clientAuthToken", "connectionEpoch", "deviceEnrollmentId", "hostDeviceId", "hostEnrollmentId", "hostStaticAgreementPublicKey", "routeGeneration", "routeId"])
    else { throw DshIdentityError("The local DSH Host record is malformed") }
    let state = try JSONDecoder().decode(DshStoredRemoteState.self, from: input)
    try state.validate()
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  private func validate() throws {
    guard version == 1,
      eventCursor >= 0, eventCursor <= 2_147_483_647,
      nextConnectionEpoch >= 1, nextConnectionEpoch <= 2_147_483_647,
      config.connectionEpoch == nextConnectionEpoch,
      Self.canonicalInstant(expiresAt)
    else { throw DshIdentityError("The local DSH Host record is malformed") }
    try config.validate()
  }

  private static func canonicalInstant(_ value: String) -> Bool {
    guard value.count == 24, value.hasSuffix("Z"), value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", options: .regularExpression) != nil else { return false }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) != nil
  }
}

private struct DshStoredRemoteConfig: Decodable {
  let clientAuthToken: String
  let connectionEpoch: Int
  let deviceEnrollmentId: String
  let hostDeviceId: String
  let hostEnrollmentId: String
  let hostStaticAgreementPublicKey: String
  let routeGeneration: Int
  let routeId: String

  func validate() throws {
    guard Self.identifier(deviceEnrollmentId), Self.identifier(hostDeviceId), Self.identifier(hostEnrollmentId), Self.identifier(routeId),
      Self.base64Url(clientAuthToken, minimum: 24, maximum: 128),
      Self.base64Url(hostStaticAgreementPublicKey, minimum: 43, maximum: 43),
      connectionEpoch >= 1, connectionEpoch <= 2_147_483_647,
      routeGeneration >= 1, routeGeneration <= 2_147_483_647
    else { throw DshIdentityError("The local DSH Host configuration is malformed") }
  }

  private static func identifier(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$", options: .regularExpression) != nil
  }

  private static func base64Url(_ value: String, minimum: Int, maximum: Int) -> Bool {
    value.count >= minimum && value.count <= maximum && value.count % 4 != 1
      && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
  }
}

private final class DshDeviceIdentityStore {
  fileprivate static let account = "v3-curve25519"
  fileprivate static let service = "app.dsh.mobile.device-identity"
  fileprivate static let recordLength = 1 + 24 + 32 + 32
  private let presence = DshPresenceSession<DshPrivateIdentity>()

  func publicDescriptor() throws -> [String: String] {
    var record = try loadOrCreate()
    defer { record.resetBytes(in: 0..<record.count) }
    let identity = try DshPrivateIdentity(record: record)
    return identity.publicDescriptor()
  }

  func requireUserPresence(promise: Promise) {
    let requestedGeneration = presence.begin()
    let context = LAContext()
    context.evaluatePolicy(
      .deviceOwnerAuthentication,
      localizedReason: "Authenticate to use this DSH Mobile identity"
    ) { success, error in
      guard success else {
        promise.reject(DshIdentityError("Device-owner authentication was not completed"))
        return
      }
      do {
        var record = try self.loadOrCreate(context: context)
        defer { record.resetBytes(in: 0..<record.count) }
        let identity = try DshPrivateIdentity(record: record)
        guard self.presence.complete(identity, generation: requestedGeneration) else {
          promise.reject(DshIdentityError("The device-owner authentication session is no longer active"))
          return
        }
        promise.resolve()
      } catch {
        promise.reject(DshIdentityError("The protected DSH Mobile identity is unavailable"))
      }
    }
  }

  func deriveSharedSecret(peerAgreementPublicKey: String) throws -> String {
    var peer = try DshBase64Url.decode(peerAgreementPublicKey, expectedLength: 32)
    defer { peer.resetBytes(in: 0..<peer.count) }
    let identity = presence.current()
    guard let identity else {
      throw DshIdentityError("Current device-owner authentication is required")
    }
    let publicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peer)
    var sharedSecret = try identity.agreement.sharedSecretFromKeyAgreement(with: publicKey)
    var bytes = sharedSecret.withUnsafeBytes { Data($0) }
    defer { bytes.resetBytes(in: 0..<bytes.count) }
    return DshBase64Url.encode(bytes)
  }

  func clearUserPresence() {
    presence.clear()
  }

  private func loadOrCreate(context: LAContext? = nil) throws -> Data {
    if let existing = try read(context: context) {
      guard existing.count == Self.recordLength else { throw DshIdentityError("The protected identity is malformed") }
      return existing
    }
    guard context == nil else { throw DshIdentityError("The protected identity disappeared during authentication") }
    return try create()
  }

  private func create() throws -> Data {
    let signing = Curve25519.Signing.PrivateKey()
    let agreement = Curve25519.KeyAgreement.PrivateKey()
    var deviceId = Data(count: 24)
    let randomStatus = deviceId.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 24, $0.baseAddress!) }
    guard randomStatus == errSecSuccess else { throw DshIdentityError("Could not create a protected mobile identity") }
    var signingBytes = signing.rawRepresentation
    var agreementBytes = agreement.rawRepresentation
    defer {
      deviceId.resetBytes(in: 0..<deviceId.count)
      signingBytes.resetBytes(in: 0..<signingBytes.count)
      agreementBytes.resetBytes(in: 0..<agreementBytes.count)
    }
    var record = Data([1]) + deviceId + signingBytes + agreementBytes
    do {
      try save(record)
      return record
    } catch {
      record.resetBytes(in: 0..<record.count)
      throw error
    }
  }

  private func read(context: LAContext?) throws -> Data? {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: Self.service,
      kSecAttrAccount: Self.account,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    if let context {
      query[kSecUseAuthenticationContext] = context
    } else {
      query[kSecUseOperationPrompt] = "Authenticate to use this DSH Mobile identity"
    }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw DshIdentityError("The protected DSH Mobile identity is unavailable")
    }
    return data
  }

  private func save(_ record: Data) throws {
    var unmanaged: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      .userPresence,
      &unmanaged
    ) else {
      throw DshIdentityError("Could not protect the DSH Mobile identity")
    }
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: Self.service,
      kSecAttrAccount: Self.account,
      kSecAttrAccessControl: access,
      kSecValueData: record,
    ]
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw DshIdentityError("Could not protect the DSH Mobile identity")
    }
  }
}

private struct DshPrivateIdentity {
  private let deviceId: Data
  let signing: Curve25519.Signing.PrivateKey
  let agreement: Curve25519.KeyAgreement.PrivateKey

  init(record: Data) throws {
    guard record.count == DshDeviceIdentityStore.recordLength, record.first == 1 else {
      throw DshIdentityError("The protected identity is malformed")
    }
    deviceId = record.subdata(in: 1..<25)
    signing = try Curve25519.Signing.PrivateKey(rawRepresentation: record.subdata(in: 25..<57))
    agreement = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: record.subdata(in: 57..<89))
  }

  func publicDescriptor() -> [String: String] {
    [
      "deviceId": DshBase64Url.encode(deviceId),
      "signingPublicKey": DshBase64Url.encode(signing.publicKey.rawRepresentation),
      "agreementPublicKey": DshBase64Url.encode(agreement.publicKey.rawRepresentation),
    ]
  }
}

private enum DshBase64Url {
  static func encode(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  static func decode(_ value: String, expectedLength: Int) throws -> Data {
    guard value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil, value.count % 4 != 1 else {
      throw DshIdentityError("The peer agreement key is invalid")
    }
    let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)
    guard let data = Data(base64Encoded: padded), data.count == expectedLength, encode(data) == value else {
      throw DshIdentityError("The peer agreement key is invalid")
    }
    return data
  }
}

private struct DshIdentityError: Error, LocalizedError {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var errorDescription: String? { message }
}
