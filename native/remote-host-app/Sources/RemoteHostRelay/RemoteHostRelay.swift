import Foundation
import LocalAuthentication
import RemoteHostWire
import RemoteHostXChaCha
import Security

public enum RelayOwnerError: Error, Equatable, Sendable {
  case invalidCredential
  case unavailable
  case rejected
  case invalidState
  case deadlineExceeded
}

private let relayOrigin = URL(string: "https://dshrelay.rulabs.dev")!
let routeID = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$")
let token = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{32,256}$")

func matches(_ expression: NSRegularExpression, _ value: String) -> Bool {
  expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
}

/** A V3 provisioning credential. It remains inside signed native code. */
public struct RelayProvisioningCredential: Equatable, Sendable {
  fileprivate let value: String
  public init(_ value: String) throws {
    guard matches(token, value) else { throw RelayOwnerError.invalidCredential }
    self.value = value
  }
}

/** Exact private material required by one V3 relay route. */
public struct RelayRouteCredential: Equatable, Sendable {
  public let routeId: String
  public let hostDeviceId: String
  public let hostEnrollmentId: String
  public let deviceId: String
  public let deviceEnrollmentId: String
  /// Canonical enrolled device Ed25519 verification key used for later native connection attestation.
  public let deviceSigningPublicKey: String
  /// Canonical enrolled device X25519 public key. This is public identity data,
  /// not a route capability, but it is mandatory for the V3 3DH transcript.
  public let deviceAgreementPublicKey: String
  public let generation: Int
  let hostToken: String
  /// The remote-client role credential. It stays module-internal so only the
  /// signed Host enrollment owner can place it in a phone invitation.
  let deviceToken: String

  public init(routeId: String, hostDeviceId: String, hostEnrollmentId: String, deviceId: String, deviceEnrollmentId: String, deviceSigningPublicKey: String, deviceAgreementPublicKey: String, generation: Int, hostToken: String, deviceToken: String) throws {
    guard matches(routeID, routeId), matches(routeID, hostDeviceId), matches(routeID, hostEnrollmentId),
          matches(routeID, deviceId), matches(routeID, deviceEnrollmentId),
          canonicalX25519(deviceSigningPublicKey), canonicalX25519(deviceAgreementPublicKey), deviceSigningPublicKey != deviceAgreementPublicKey,
          generation >= 1, generation <= 2_147_483_647,
          matches(token, hostToken), matches(token, deviceToken), hostToken != deviceToken
    else { throw RelayOwnerError.invalidCredential }
    self.routeId = routeId
    self.hostDeviceId = hostDeviceId
    self.hostEnrollmentId = hostEnrollmentId
    self.deviceId = deviceId
    self.deviceEnrollmentId = deviceEnrollmentId
    self.deviceSigningPublicKey = deviceSigningPublicKey
    self.deviceAgreementPublicKey = deviceAgreementPublicKey
    self.generation = generation
    self.hostToken = hostToken
    self.deviceToken = deviceToken
  }
}

func canonicalX25519(_ value: String) -> Bool {
  guard value.count == 43, value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return false }
  let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="
  guard var decoded = Data(base64Encoded: base64), decoded.count == 32 else { return false }
  defer { XChaCha.zeroize(&decoded) }
  return decoded.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value
}

/** Fixed request shape accepted by an injected native-only HTTP transport. */
public struct RelayHTTPRequest: Equatable, Sendable {
  public let method: String
  public let url: URL
  public let headers: [String: String]
  public let body: Data?
}

public struct RelayHTTPResponse: Equatable, Sendable {
  public let status: Int
  public init(status: Int) { self.status = status }
}

/** No URLSession implementation is supplied by this foundation, preventing accidental real provisioning. */
public protocol RelayHTTPTransport: Sendable {
  func send(_ request: RelayHTTPRequest) throws -> RelayHTTPResponse
}

/** Signed-native secret storage boundary. No caller receives a token through Remote Wire or a generic API. */
public protocol RelaySecretStore: AnyObject, Sendable {
  func provisioningCredential() throws -> RelayProvisioningCredential
  func routeCredential(routeId: String) throws -> RelayRouteCredential?
  func saveRouteCredential(_ credential: RelayRouteCredential) throws
  func removeRouteCredential(routeId: String) throws
  /// The sole active route pointer used to resume native-only lifecycle ownership after restart.
  func activeRouteCredential() throws -> RelayRouteCredential?
  func saveActiveRouteCredential(_ credential: RelayRouteCredential) throws
  func removeActiveRouteCredential(routeId: String) throws
  /// Durable recovery state for a route whose remote creation outcome is uncertain.
  func pendingRouteCredential() throws -> RelayRouteCredential?
  func savePendingRouteCredential(_ credential: RelayRouteCredential) throws
  func removePendingRouteCredential(routeId: String) throws
  /// Durable intent to remove a route after its remote revocation completes.
  func revokedCleanupRouteCredential() throws -> RelayRouteCredential?
  func saveRevokedCleanupRouteCredential(_ credential: RelayRouteCredential) throws
  func removeRevokedCleanupRouteCredential(routeId: String) throws
  /// V3 connection epochs are native-only state for the current active route.
  func connectionEpochState(routeId: String) throws -> RelayConnectionEpochState?
  func saveConnectionEpochState(_ state: RelayConnectionEpochState) throws
  func removeConnectionEpochState(routeId: String) throws
  /// The sealed coordinator that owns epoch admission for this store's routes.
  var connectionEpochCoordinator: any RelayConnectionEpochCoordinator { get }
}

private struct StoredRoute: Codable {
  let routeId: String
  let hostDeviceId: String
  let hostEnrollmentId: String
  let deviceId: String
  let deviceEnrollmentId: String
  let deviceSigningPublicKey: String
  let deviceAgreementPublicKey: String
  let generation: Int
  let hostToken: String
  let deviceToken: String

  init(_ value: RelayRouteCredential) {
    routeId = value.routeId; hostDeviceId = value.hostDeviceId; hostEnrollmentId = value.hostEnrollmentId
    deviceId = value.deviceId; deviceEnrollmentId = value.deviceEnrollmentId; deviceSigningPublicKey = value.deviceSigningPublicKey; deviceAgreementPublicKey = value.deviceAgreementPublicKey; generation = value.generation
    hostToken = value.hostToken; deviceToken = value.deviceToken
  }

  func credential() throws -> RelayRouteCredential {
    try RelayRouteCredential(routeId: routeId, hostDeviceId: hostDeviceId, hostEnrollmentId: hostEnrollmentId, deviceId: deviceId, deviceEnrollmentId: deviceEnrollmentId, deviceSigningPublicKey: deviceSigningPublicKey, deviceAgreementPublicKey: deviceAgreementPublicKey, generation: generation, hostToken: hostToken, deviceToken: deviceToken)
  }
}

private struct StoredConnectionEpoch: Codable {
  let routeId: String
  let lastCommittedEpoch: Int
  let pendingEpoch: Int?
  /// The durable signed-Host owner of the in-flight exact-next epoch.
  /// This is intentionally persisted, not process-local: a second signed
  /// Host process must not be able to reserve the same epoch.
  let leaseOwner: UUID?
  /// Durable admission fence installed before a route is revoked.
  let revoking: Bool

  private enum CodingKeys: String, CodingKey {
    case routeId, lastCommittedEpoch, pendingEpoch, leaseOwner, revoking
  }

  init(_ value: RelayConnectionEpochState) {
    routeId = value.routeId
    lastCommittedEpoch = value.lastCommittedEpoch
    pendingEpoch = value.pendingEpoch
    leaseOwner = value.leaseOwner
    revoking = value.revoking
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    routeId = try values.decode(String.self, forKey: .routeId)
    lastCommittedEpoch = try values.decode(Int.self, forKey: .lastCommittedEpoch)
    pendingEpoch = try values.decodeIfPresent(Int.self, forKey: .pendingEpoch)
    // Earlier V3 state did not carry an owner/fence. Treat it as unleased and
    // not revoking rather than silently dropping the new fields on future saves.
    leaseOwner = try values.decodeIfPresent(UUID.self, forKey: .leaseOwner)
    revoking = try values.decodeIfPresent(Bool.self, forKey: .revoking) ?? false
  }

  func state() throws -> RelayConnectionEpochState {
    try RelayConnectionEpochState(routeId: routeId, lastCommittedEpoch: lastCommittedEpoch, pendingEpoch: pendingEpoch, leaseOwner: leaseOwner, revoking: revoking)
  }
}

/** Keychain-backed native-only store. Setup must provision the bearer secret directly into this item. */
public final class KeychainRelaySecretStore: @unchecked Sendable, RelaySecretStore {
  private let service = "com.deepseek.dsh.remote-host.relay-v3"
  private let access: SecAccess
  public let connectionEpochCoordinator: any RelayConnectionEpochCoordinator

  public init(hostExecutablePath: String) throws {
    var application: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath(hostExecutablePath, &application) == errSecSuccess, let application else { throw RelayOwnerError.unavailable }
    var access: SecAccess?
    guard SecAccessCreate("DSH Host V3 relay credentials" as CFString, [application] as CFArray, &access) == errSecSuccess, let access else { throw RelayOwnerError.unavailable }
    self.access = access
    connectionEpochCoordinator = try RelayConnectionEpochXPCCoordinator.openSealedHostConnection()
  }

  public func provisioningCredential() throws -> RelayProvisioningCredential {
    let data = try read("provisioning")
    guard let value = String(data: data, encoding: .utf8) else { throw RelayOwnerError.unavailable }
    return try RelayProvisioningCredential(value)
  }

  /** One-shot signed-Host setup path. It only writes a validated credential. */
  public func installProvisioningCredential(_ credential: RelayProvisioningCredential) throws {
    var data = Data(credential.value.utf8)
    defer { XChaCha.zeroize(&data) }
    try upsert(data, account: "provisioning")
  }

  public func routeCredential(routeId: String) throws -> RelayRouteCredential? {
    guard matches(routeID, routeId) else { throw RelayOwnerError.invalidCredential }
    guard let data = try readOptional(account: "route." + routeId) else { return nil }
    guard let value = try? JSONDecoder().decode(StoredRoute.self, from: data) else { throw RelayOwnerError.unavailable }
    return try value.credential()
  }

  public func saveRouteCredential(_ credential: RelayRouteCredential) throws {
    let data = try JSONEncoder().encode(StoredRoute(credential))
    let account = "route." + credential.routeId
    try upsert(data, account: account)
  }

  public func removeRouteCredential(routeId: String) throws {
    guard matches(routeID, routeId) else { throw RelayOwnerError.invalidCredential }
    let status = SecItemDelete(noninteractiveQuery("route." + routeId) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw RelayOwnerError.unavailable }
  }

  public func activeRouteCredential() throws -> RelayRouteCredential? {
    guard let data = try readOptional(account: "route.active") else { return nil }
    guard let value = try? JSONDecoder().decode(StoredRoute.self, from: data) else { throw RelayOwnerError.unavailable }
    return try value.credential()
  }

  public func saveActiveRouteCredential(_ credential: RelayRouteCredential) throws {
    let data = try JSONEncoder().encode(StoredRoute(credential))
    try upsert(data, account: "route.active")
  }

  public func removeActiveRouteCredential(routeId: String) throws {
    guard matches(routeID, routeId) else { throw RelayOwnerError.invalidCredential }
    guard let stored = try activeRouteCredential(), stored.routeId == routeId else { return }
    let status = SecItemDelete(noninteractiveQuery("route.active") as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw RelayOwnerError.unavailable }
  }

  public func pendingRouteCredential() throws -> RelayRouteCredential? {
    guard let data = try readOptional(account: "pending.active") else { return nil }
    guard let value = try? JSONDecoder().decode(StoredRoute.self, from: data) else { throw RelayOwnerError.unavailable }
    return try value.credential()
  }

  public func savePendingRouteCredential(_ credential: RelayRouteCredential) throws {
    let data = try JSONEncoder().encode(StoredRoute(credential))
    let account = "pending.active"
    try upsert(data, account: account)
  }

  public func removePendingRouteCredential(routeId: String) throws {
    guard matches(routeID, routeId) else { throw RelayOwnerError.invalidCredential }
    guard let stored = try pendingRouteCredential(), stored.routeId == routeId else { return }
    let status = SecItemDelete(noninteractiveQuery("pending.active") as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw RelayOwnerError.unavailable }
  }

  public func revokedCleanupRouteCredential() throws -> RelayRouteCredential? {
    guard let data = try readOptional(account: "revoked.cleanup") else { return nil }
    guard let value = try? JSONDecoder().decode(StoredRoute.self, from: data) else { throw RelayOwnerError.unavailable }
    return try value.credential()
  }

  public func saveRevokedCleanupRouteCredential(_ credential: RelayRouteCredential) throws {
    let data = try JSONEncoder().encode(StoredRoute(credential))
    try upsert(data, account: "revoked.cleanup")
  }

  public func removeRevokedCleanupRouteCredential(routeId: String) throws {
    guard matches(routeID, routeId) else { throw RelayOwnerError.invalidCredential }
    guard let stored = try revokedCleanupRouteCredential(), stored.routeId == routeId else { return }
    let status = SecItemDelete(noninteractiveQuery("revoked.cleanup") as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw RelayOwnerError.unavailable }
  }

  public func connectionEpochState(routeId: String) throws -> RelayConnectionEpochState? {
    guard matches(routeID, routeId) else { throw RelayOwnerError.invalidCredential }
    guard let data = try readOptional(account: "epoch." + routeId) else { return nil }
    guard let value = try? JSONDecoder().decode(StoredConnectionEpoch.self, from: data) else { throw RelayOwnerError.unavailable }
    let state = try value.state()
    guard state.routeId == routeId else { throw RelayOwnerError.unavailable }
    return state
  }

  public func saveConnectionEpochState(_ state: RelayConnectionEpochState) throws {
    let data = try JSONEncoder().encode(StoredConnectionEpoch(state))
    let account = "epoch." + state.routeId
    try upsert(data, account: account)
  }

  public func removeConnectionEpochState(routeId: String) throws {
    guard matches(routeID, routeId) else { throw RelayOwnerError.invalidCredential }
    let status = SecItemDelete(noninteractiveQuery("epoch." + routeId) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw RelayOwnerError.unavailable }
  }

  private func keychainQuery(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
  }

  static func duplicateUpdateAttributes(_ data: Data) -> [String: Any] {
    [kSecValueData as String: data]
  }

  private func noninteractiveQuery(_ account: String) -> [String: Any] {
    var query = keychainQuery(account)
    let context = LAContext()
    context.interactionNotAllowed = true
    query[kSecUseAuthenticationContext as String] = context
    return query
  }

  private func upsert(_ data: Data, account: String) throws {
    var add = keychainQuery(account)
    add[kSecValueData as String] = data
    add[kSecAttrAccess as String] = access
    let status = SecItemAdd(add as CFDictionary, nil)
    if status == errSecDuplicateItem {
      guard SecItemUpdate(noninteractiveQuery(account) as CFDictionary, Self.duplicateUpdateAttributes(data) as CFDictionary) == errSecSuccess else {
        throw RelayOwnerError.unavailable
      }
    } else if status != errSecSuccess {
      throw RelayOwnerError.unavailable
    }
  }

  private func read(_ account: String) throws -> Data {
    guard let data = try readOptional(account: account) else { throw RelayOwnerError.unavailable }
    return data
  }

  private func readOptional(account: String) throws -> Data? {
    var query = noninteractiveQuery(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw RelayOwnerError.unavailable }
    return data
  }
}

/** Pure fixed V3 codec. The caller cannot override origin, path, headers, or body vocabulary. */
public enum RelayV3RequestCodec {
  public static func create(_ credential: RelayRouteCredential, provisioning: RelayProvisioningCredential) throws -> RelayHTTPRequest {
    try request(method: "POST", path: routePath(credential.routeId), bearer: provisioning.value, body: creationBody(credential, includeGeneration: false))
  }

  public static func rotate(_ credential: RelayRouteCredential, previousHostToken: RelayRouteCredential) throws -> RelayHTTPRequest {
    guard credential.routeId == previousHostToken.routeId, credential.generation == previousHostToken.generation + 1 else { throw RelayOwnerError.invalidCredential }
    return try request(method: "POST", path: routePath(credential.routeId) + "/rotate", bearer: previousHostToken.hostToken, body: creationBody(credential, includeGeneration: true))
  }

  public static func revoke(_ credential: RelayRouteCredential) throws -> RelayHTTPRequest {
    try request(method: "DELETE", path: routePath(credential.routeId), bearer: credential.hostToken, body: nil)
  }

  private static func routePath(_ routeId: String) -> String { "/v3/routes/" + routeId }

  private static func request(method: String, path: String, bearer: String, body: Data?) throws -> RelayHTTPRequest {
    guard path.hasPrefix("/v3/routes/"), !path.contains("//"), let url = URL(string: path, relativeTo: relayOrigin)?.absoluteURL,
          url.scheme == "https", url.host == relayOrigin.host, url.port == nil, body?.count ?? 0 <= 8 * 1024
    else { throw RelayOwnerError.invalidCredential }
    var headers = ["authorization": "Bearer " + bearer, "cache-control": "no-store"]
    if body != nil { headers["content-type"] = "application/json; charset=utf-8" }
    return RelayHTTPRequest(method: method, url: url, headers: headers, body: body)
  }

  private static func creationBody(_ credential: RelayRouteCredential, includeGeneration: Bool) -> Data {
    var object: [String: Any] = [
      "version": 3, "hostDeviceId": credential.hostDeviceId, "hostEnrollmentId": credential.hostEnrollmentId,
      "deviceId": credential.deviceId, "deviceEnrollmentId": credential.deviceEnrollmentId,
      "hostToken": credential.hostToken, "deviceToken": credential.deviceToken,
    ]
    if includeGeneration { object["generation"] = credential.generation }
    return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }
}

/** Fixed HTTPS vocabulary for the short-lived QR/code V3 pairing rendezvous. */
public enum RelayV3PairingRequestCodec {
  public static func create(pairingId: String, code: String, hostToken: String, expiresAt: Int, provisioning: RelayProvisioningCredential) throws -> RelayHTTPRequest {
    guard matches(routeID, pairingId), matches(token, code), matches(token, hostToken), code != hostToken else { throw RelayOwnerError.invalidCredential }
    return try request(method: "POST", path: "/v3/pairings/" + pairingId, headers: ["authorization": "Bearer " + provisioning.value], body: ["code": code, "hostToken": hostToken, "expiresAt": expiresAt])
  }

  public static func offer(pairingId: String, hostToken: String) throws -> RelayHTTPRequest {
    guard matches(routeID, pairingId), matches(token, hostToken) else { throw RelayOwnerError.invalidCredential }
    return try request(method: "GET", path: "/v3/pairings/" + pairingId + "/offer", headers: ["authorization": "Bearer " + hostToken], body: nil)
  }

  public static func publishInvitation(pairingId: String, hostToken: String, hostStaticAgreementPublicKey: String, nonce: String, ciphertext: String) throws -> RelayHTTPRequest {
    guard matches(routeID, pairingId), matches(token, hostToken), canonicalX25519(hostStaticAgreementPublicKey), validSealedInvitationComponent(nonce, expectedLength: 16), validSealedInvitationComponent(ciphertext, expectedLength: nil) else { throw RelayOwnerError.invalidCredential }
    return try request(method: "POST", path: "/v3/pairings/" + pairingId + "/invitation", headers: ["authorization": "Bearer " + hostToken], body: ["version": 1, "hostStaticAgreementPublicKey": hostStaticAgreementPublicKey, "nonce": nonce, "ciphertext": ciphertext])
  }

  private static func validSealedInvitationComponent(_ value: String, expectedLength: Int?) -> Bool {
    guard value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }), expectedLength.map({ value.count == $0 }) ?? (value.count >= 32 && value.count <= 8192) else { return false }
    return value.count % 4 != 1
  }

  private static func request(method: String, path: String, headers: [String: String], body: [String: Any]?) throws -> RelayHTTPRequest {
    guard path.hasPrefix("/v3/pairings/"), !path.contains("//"), let url = URL(string: path, relativeTo: relayOrigin)?.absoluteURL, url.scheme == "https", url.host == relayOrigin.host, url.port == nil else { throw RelayOwnerError.invalidCredential }
    var fixed = headers
    fixed["cache-control"] = "no-store"
    let encoded = try body.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
    if encoded != nil { fixed["content-type"] = "application/json; charset=utf-8" }
    return RelayHTTPRequest(method: method, url: url, headers: fixed, body: encoded)
  }
}

/** Fixed public route facts for the existing private Remote Wire. Route tokens are intentionally absent. */
public enum RelayWireCodec {
  public static func upsert(_ credential: RelayRouteCredential) throws -> RemoteWireRecord {
    let metadata = try JSONSerialization.data(withJSONObject: [
      "routeId": credential.routeId, "hostDeviceId": credential.hostDeviceId,
      "hostEnrollmentId": credential.hostEnrollmentId, "deviceId": credential.deviceId,
      "deviceEnrollmentId": credential.deviceEnrollmentId, "generation": credential.generation,
    ], options: [.sortedKeys])
    return RemoteWireRecord(kind: .routeUpsert, metadata: metadata)
  }

  public static func revoked(_ credential: RelayRouteCredential) throws -> RemoteWireRecord {
    let metadata = try JSONSerialization.data(withJSONObject: ["deviceId": credential.deviceId], options: [.sortedKeys])
    return RemoteWireRecord(kind: .routeRevoked, metadata: metadata)
  }
}

public enum RelayOwnerState: Equatable, Sendable { case idle, provisioning, provisioned, revoked, stopped }

/** Owner lifecycle skeleton. It accepts only typed native credentials and emits no generic wire operation. */
public final class RelayOwner: @unchecked Sendable {
  private let lock = NSLock()
  private let store: RelaySecretStore
  private let transport: RelayHTTPTransport
  private var value: RelayOwnerState = .idle

  public init(store: RelaySecretStore, transport: RelayHTTPTransport) { self.store = store; self.transport = transport }
  public var state: RelayOwnerState { lock.lock(); defer { lock.unlock() }; return value }

  public func provision(_ credential: RelayRouteCredential) throws {
    lock.lock(); defer { lock.unlock() }
    guard value == .idle || value == .revoked else { throw RelayOwnerError.invalidState }
    value = .provisioning
    do {
      let response = try transport.send(RelayV3RequestCodec.create(credential, provisioning: try store.provisioningCredential()))
      guard response.status == 201 else { throw RelayOwnerError.rejected }
      try store.saveRouteCredential(credential)
      value = .provisioned
    } catch {
      value = .idle
      throw error
    }
  }

  public func revoke(routeId: String) throws {
    lock.lock(); defer { lock.unlock() }
    guard value == .provisioned, let credential = try store.routeCredential(routeId: routeId) else { throw RelayOwnerError.invalidState }
    guard try transport.send(RelayV3RequestCodec.revoke(credential)).status == 204 else { throw RelayOwnerError.rejected }
    try store.removeRouteCredential(routeId: routeId)
    value = .revoked
  }

  public func stop() { lock.lock(); defer { lock.unlock() }; value = .stopped }
}
