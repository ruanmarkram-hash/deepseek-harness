import CryptoKit
import Darwin
import Foundation
import Security

private let helperIdentifier = "com.deepseek.dsh.remote-host.keychain"
private let keychainService = "com.deepseek.dsh.remote-host.keychain.identity.v2"
private let processPathCapacity = 4_096

private enum HelperError: Error {
  case invalidInput
  case unavailable
  case corrupt
  case keychain(OSStatus)
}

private extension HelperError {
  var code: String {
    switch self {
    case .invalidInput: "REMOTE_HOST_IDENTITY_INPUT_INVALID"
    case .unavailable: "REMOTE_HOST_IDENTITY_UNAVAILABLE"
    case .corrupt: "REMOTE_HOST_IDENTITY_CORRUPT"
    case .keychain: "REMOTE_HOST_IDENTITY_KEYCHAIN_FAILURE"
    }
  }
}

private struct PublicIdentity: Codable {
  let hostDeviceId: String
  let signingPublicKey: String
  let agreementPublicKey: String
}

private struct StoredIdentity: Codable {
  let version: Int
  let designatedRequirement: Data
  let publicIdentity: PublicIdentity
  let signingPrivateKey: Data
  let agreementPrivateKey: Data
}

struct AuthorizedClient: Decodable {
  let requirement: String
  let bundleIdentifier: String
  let bundleVersion: String
}

struct AuthorizedHostLocation: Equatable {
  let bundleURL: URL
  let executableURL: URL
}

private struct SuccessResponse: Encodable {
  let ok = true
  let publicIdentity: PublicIdentity
}

private struct FailureResponse: Encodable {
  let ok = false
  let error: String
}

/** The only XPC interface exported by the signed service: public identity and typed X25519 agreement. */
@objc private protocol RemoteHostKeychainXPC {
  func openHostPublicIdentity(withReply reply: @escaping (Data) -> Void)
  func deriveHostSharedSecret(withPeerPublicKey peerPublicKey: Data, withReply reply: @escaping (Data) -> Void)
  func acquireEpochLease(forRouteId routeId: String, withReply reply: @escaping (Bool) -> Void)
  func releaseEpochLease(forRouteId routeId: String, withReply reply: @escaping () -> Void)
  func beginEpochTransaction(forRouteId routeId: String, withReply reply: @escaping (Bool) -> Void)
  func endEpochTransaction(forRouteId routeId: String, withReply reply: @escaping () -> Void)
  func signFd199OwnershipPayload(_ payload: Data, withReply reply: @escaping (Data) -> Void)
}

private func base64url(_ value: Data) -> String {
  value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

private func decodeBase64url(_ value: String, maximumLength: Int) throws -> Data {
  guard !value.isEmpty, value.count <= maximumLength * 2, value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
    throw HelperError.invalidInput
  }
  let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  let padding = String(repeating: "=", count: (4 - base64.count % 4) % 4)
  guard let decoded = Data(base64Encoded: base64 + padding), decoded.count <= maximumLength, base64url(decoded) == value else {
    throw HelperError.invalidInput
  }
  return decoded
}

/**
 Signs only bounded, canonical FD199 export or activation payloads admitted
 by the version-specific validator. Invalid input never opens the protected
 identity; admitted bytes are signed unchanged for journal recovery.
 */
private func signStoredFd199OwnershipPayload(payload: Data) throws -> Data {
  do { try validateFd199OwnershipPayload(payload) }
  catch { throw HelperError.invalidInput }
  let identity = try openIdentity(profile: "dsh-host-v1")
  var privateBytes = identity.signingPrivateKey
  defer { erase(&privateBytes) }
  let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: privateBytes)
  return try privateKey.signature(for: payload)
}

private func erase(_ data: inout Data) {
  data.withUnsafeMutableBytes { bytes in
    guard let base = bytes.baseAddress else { return }
    base.initializeMemory(as: UInt8.self, repeating: 0, count: bytes.count)
  }
  data.removeAll(keepingCapacity: false)
}

private func profileAccount(_ profile: String) throws -> String {
  guard profile.count <= 96, !profile.isEmpty, profile.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-") }) else {
    throw HelperError.invalidInput
  }
  return profile
}

private func checkedSelf() throws -> (path: String, designatedRequirement: Data) {
  let path = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
  var staticCode: SecStaticCode?
  guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &staticCode) == errSecSuccess,
        let code = staticCode,
        SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess
  else {
    throw HelperError.unavailable
  }
  var requirement: SecRequirement?
  var requirementData: CFData?
  guard SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess,
        let requirement,
        SecRequirementCopyData(requirement, [], &requirementData) == errSecSuccess
  else {
    throw HelperError.unavailable
  }
  guard let rawRequirement = requirementData as Data?, !rawRequirement.isEmpty else { throw HelperError.unavailable }
  var signingInformation: CFDictionary?
  guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &signingInformation) == errSecSuccess,
        let information = signingInformation as? [String: Any],
        information[kSecCodeInfoIdentifier as String] as? String == helperIdentifier
  else {
    throw HelperError.unavailable
  }
  return (path, rawRequirement)
}

private func validateServiceBundle() throws {
  let bundle = Bundle.main
  let bundleURL = bundle.bundleURL.resolvingSymlinksInPath()
  guard bundleURL.pathExtension == "xpc",
        bundle.executableURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
  else { throw HelperError.unavailable }
  var code: SecStaticCode?
  guard SecStaticCodeCreateWithPath(bundleURL as CFURL, [], &code) == errSecSuccess,
        let code,
        SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess
  else { throw HelperError.unavailable }
  var information: CFDictionary?
  guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
        let values = information as? [String: Any],
        values[kSecCodeInfoIdentifier as String] as? String == helperIdentifier
  else { throw HelperError.unavailable }
}

private func trustedAccessForSelf() throws -> SecAccess {
  var trustedApplication: SecTrustedApplication?
  guard SecTrustedApplicationCreateFromPath(nil, &trustedApplication) == errSecSuccess,
        let trustedApplication
  else {
    throw HelperError.unavailable
  }
  var access: SecAccess?
  let status = SecAccessCreate("DSH remote Host identity" as CFString, [trustedApplication] as CFArray, &access)
  guard status == errSecSuccess, let access else { throw HelperError.keychain(status) }
  return access
}

private func keychainQuery(account: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: keychainService,
    kSecAttrAccount as String: account,
    kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
  ]
}

private func loadIdentity(account: String, expectedRequirement: Data) throws -> StoredIdentity? {
  var query = keychainQuery(account: account)
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound { return nil }
  guard status == errSecSuccess, let encoded = result as? Data else { throw HelperError.keychain(status) }
  let decoder = PropertyListDecoder()
  guard let stored = try? decoder.decode(StoredIdentity.self, from: encoded), stored.version == 1, stored.designatedRequirement == expectedRequirement else {
    throw HelperError.corrupt
  }
  do {
    let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: stored.signingPrivateKey)
    let agreement = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: stored.agreementPrivateKey)
    guard base64url(signing.publicKey.rawRepresentation) == stored.publicIdentity.signingPublicKey,
          base64url(agreement.publicKey.rawRepresentation) == stored.publicIdentity.agreementPublicKey,
          try decodeBase64url(stored.publicIdentity.hostDeviceId, maximumLength: 32).count == 32
    else { throw HelperError.corrupt }
  } catch is HelperError {
    throw HelperError.corrupt
  } catch {
    throw HelperError.corrupt
  }
  return stored
}

private func createIdentity(account: String, designatedRequirement: Data) throws -> StoredIdentity {
  let signing = Curve25519.Signing.PrivateKey()
  let agreement = Curve25519.KeyAgreement.PrivateKey()
  var signingPrivate = signing.rawRepresentation
  var agreementPrivate = agreement.rawRepresentation
  var hostDeviceId = Data(count: 32)
  let randomStatus = hostDeviceId.withUnsafeMutableBytes { bytes in SecRandomCopyBytes(kSecRandomDefault, bytes.count, bytes.baseAddress!) }
  guard randomStatus == errSecSuccess else { throw HelperError.keychain(randomStatus) }
  defer {
    erase(&signingPrivate)
    erase(&agreementPrivate)
    erase(&hostDeviceId)
  }
  let publicIdentity = PublicIdentity(
    hostDeviceId: base64url(hostDeviceId),
    signingPublicKey: base64url(signing.publicKey.rawRepresentation),
    agreementPublicKey: base64url(agreement.publicKey.rawRepresentation),
  )
  let stored = StoredIdentity(
    version: 1,
    designatedRequirement: designatedRequirement,
    publicIdentity: publicIdentity,
    signingPrivateKey: signingPrivate,
    agreementPrivateKey: agreementPrivate,
  )
  let encoded = try PropertyListEncoder().encode(stored)
  let access = try trustedAccessForSelf()
  var query = keychainQuery(account: account)
  query[kSecValueData as String] = encoded
  query[kSecAttrAccess as String] = access
  let status = SecItemAdd(query as CFDictionary, nil)
  if status == errSecDuplicateItem {
    guard let concurrent = try loadIdentity(account: account, expectedRequirement: designatedRequirement) else { throw HelperError.corrupt }
    return concurrent
  }
  guard status == errSecSuccess else { throw HelperError.keychain(status) }
  return stored
}

private func openIdentity(profile: String) throws -> StoredIdentity {
  let account = try profileAccount(profile)
  let helper = try checkedSelf()
  if let stored = try loadIdentity(account: account, expectedRequirement: helper.designatedRequirement) { return stored }
  return try createIdentity(account: account, designatedRequirement: helper.designatedRequirement)
}

/** Derives one exact 32-byte X25519 secret inside the signed Keychain service. */
private func deriveStoredHostSharedSecret(peerPublicKey: Data) throws -> Data {
  guard peerPublicKey.count == 32 else { throw HelperError.invalidInput }
  let identity = try openIdentity(profile: "dsh-host-v1")
  var privateBytes = identity.agreementPrivateKey
  defer { erase(&privateBytes) }
  let privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateBytes)
  let peerKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKey)
  let sharedSecret = try privateKey.sharedSecretFromKeyAgreement(with: peerKey)
  var bytes = sharedSecret.withUnsafeBytes { Data($0) }
  guard bytes.count == 32, bytes.contains(where: { $0 != 0 }) else {
    erase(&bytes)
    throw HelperError.invalidInput
  }
  return bytes
}

private func encoded(_ response: some Encodable) -> Data {
  (try? JSONEncoder().encode(response)) ?? Data("{\"ok\":false,\"error\":\"REMOTE_HOST_IDENTITY_UNAVAILABLE\"}".utf8)
}

private func authorizedClient() throws -> AuthorizedClient {
  guard let url = Bundle.main.url(forResource: "AuthorizedClient", withExtension: "plist"),
        let data = try? Data(contentsOf: url),
        let client = try? PropertyListDecoder().decode(AuthorizedClient.self, from: data),
        !client.requirement.isEmpty,
        !client.bundleIdentifier.isEmpty,
        !client.bundleVersion.isEmpty
  else { throw HelperError.unavailable }
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(client.requirement as CFString, [], &requirement) == errSecSuccess, requirement != nil else {
    throw HelperError.unavailable
  }
  return client
}

/** Derives the signed Host from the XPC service's fixed nested bundle position. */
func authorizedHostLocation(serviceBundleURL: URL, client: AuthorizedClient) throws -> AuthorizedHostLocation {
  let service = serviceBundleURL.standardizedFileURL
  guard service == service.resolvingSymlinksInPath().standardizedFileURL,
        service.lastPathComponent == "DSHRemoteHostKeychain.xpc",
        service.deletingLastPathComponent().lastPathComponent == "XPCServices",
        service.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "Contents"
  else { throw HelperError.unavailable }
  let host = service.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  guard host.pathExtension == "app",
        host == host.resolvingSymlinksInPath().standardizedFileURL,
        host.appendingPathComponent("Contents/XPCServices/DSHRemoteHostKeychain.xpc").standardizedFileURL == service,
        let bundle = Bundle(url: host),
        bundle.bundleIdentifier == client.bundleIdentifier,
        bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String == client.bundleVersion
  else { throw HelperError.unavailable }
  let executable = host.appendingPathComponent("Contents/MacOS/dsh-remote-host-app").standardizedFileURL
  var metadata = Darwin.stat()
  guard executable == executable.resolvingSymlinksInPath().standardizedFileURL,
        lstat(executable.path, &metadata) == 0,
        metadata.st_mode & S_IFMT == S_IFREG
  else { throw HelperError.unavailable }
  return AuthorizedHostLocation(bundleURL: host, executableURL: executable)
}

private func connectionMatches(_ connection: NSXPCConnection, client: AuthorizedClient, location: AuthorizedHostLocation) -> Bool {
  var callerPath = [CChar](repeating: 0, count: processPathCapacity)
  guard proc_pidpath(connection.processIdentifier, &callerPath, UInt32(callerPath.count)) > 0,
        URL(fileURLWithPath: String(cString: callerPath)).resolvingSymlinksInPath().standardizedFileURL == location.executableURL
  else { return false }
  var guest: SecCode?
  let attributes = [kSecGuestAttributePid: connection.processIdentifier] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
        let guest
  else { return false }
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(client.requirement as CFString, [], &requirement) == errSecSuccess,
        let requirement,
        SecCodeCheckValidity(guest, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess
  else { return false }
  var expected: SecStaticCode?
  guard SecStaticCodeCreateWithPath(location.executableURL as CFURL, [], &expected) == errSecSuccess,
        let expected,
        SecStaticCodeCheckValidity(expected, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess
  else { return false }
  var signingInformation: CFDictionary?
  guard SecCodeCopySigningInformation(expected, SecCSFlags(rawValue: kSecCSSigningInformation), &signingInformation) == errSecSuccess,
        let information = signingInformation as? [String: Any],
        information[kSecCodeInfoIdentifier as String] as? String == client.bundleIdentifier,
        Bundle(url: location.bundleURL)?.object(forInfoDictionaryKey: "CFBundleVersion") as? String == client.bundleVersion
  else { return false }
  return true
}

private func validEpochRouteId(_ value: String) -> Bool {
  value.count >= 16 && value.count <= 128 && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
}

/**
 * Holds epoch ownership in the sealed service rather than in a user-writable
 * filesystem object. Both ownership and the short Keychain transaction lock
 * are bound to an authenticated XPC connection and are reclaimed on disconnect.
 */
private final class EpochCoordinator: @unchecked Sendable {
  private let lock = NSLock()
  private var owners: [String: UUID] = [:]
  private var transactions: [String: UUID] = [:]

  func acquire(routeId: String, client: UUID) -> Bool {
    guard validEpochRouteId(routeId) else { return false }
    return lock.withLock {
      guard let owner = owners[routeId] else { owners[routeId] = client; return true }
      return owner == client
    }
  }

  func release(routeId: String, client: UUID) {
    guard validEpochRouteId(routeId) else { return }
    lock.withLock {
      guard owners[routeId] == client else { return }
      owners.removeValue(forKey: routeId)
      if transactions[routeId] == client { transactions.removeValue(forKey: routeId) }
    }
  }

  func beginTransaction(routeId: String, client: UUID) -> Bool {
    guard validEpochRouteId(routeId) else { return false }
    return lock.withLock {
      // Revocation is allowed to acquire this short write interval even when a
      // different live Host owns the connection lease. Its durable revoking
      // fence makes that owner fail its next admission check.
      guard transactions[routeId] == nil else { return false }
      transactions[routeId] = client
      return true
    }
  }

  func endTransaction(routeId: String, client: UUID) {
    guard validEpochRouteId(routeId) else { return }
    lock.withLock { if transactions[routeId] == client { transactions.removeValue(forKey: routeId) } }
  }

  func releaseAll(client: UUID) {
    lock.withLock {
      let routes = owners.compactMap { $0.value == client ? $0.key : nil }
      for route in routes { owners.removeValue(forKey: route); if transactions[route] == client { transactions.removeValue(forKey: route) } }
    }
  }
}

/** Per-XPC-client fixed methods; no route secret or arbitrary operation is accepted. */
private final class RemoteHostKeychainConnection: NSObject, RemoteHostKeychainXPC {
  private let identifier = UUID()
  private let coordinator: EpochCoordinator
  init(coordinator: EpochCoordinator) { self.coordinator = coordinator }

  func openHostPublicIdentity(withReply reply: @escaping (Data) -> Void) {
    do { let identity = try openIdentity(profile: "dsh-host-v1"); reply(encoded(SuccessResponse(publicIdentity: identity.publicIdentity))) }
    catch let error as HelperError { reply(encoded(FailureResponse(error: error.code))) }
    catch { reply(encoded(FailureResponse(error: "REMOTE_HOST_IDENTITY_UNAVAILABLE"))) }
  }

  func deriveHostSharedSecret(withPeerPublicKey peerPublicKey: Data, withReply reply: @escaping (Data) -> Void) {
    do { var secret = try deriveStoredHostSharedSecret(peerPublicKey: peerPublicKey); defer { erase(&secret) }; reply(secret) }
    catch { reply(Data()) }
  }

  func signFd199OwnershipPayload(_ payload: Data, withReply reply: @escaping (Data) -> Void) {
    do { reply(try signStoredFd199OwnershipPayload(payload: payload)) }
    catch { reply(Data()) }
  }

  func acquireEpochLease(forRouteId routeId: String, withReply reply: @escaping (Bool) -> Void) { reply(coordinator.acquire(routeId: routeId, client: identifier)) }
  func releaseEpochLease(forRouteId routeId: String, withReply reply: @escaping () -> Void) { coordinator.release(routeId: routeId, client: identifier); reply() }
  func beginEpochTransaction(forRouteId routeId: String, withReply reply: @escaping (Bool) -> Void) { reply(coordinator.beginTransaction(routeId: routeId, client: identifier)) }
  func endEpochTransaction(forRouteId routeId: String, withReply reply: @escaping () -> Void) { coordinator.endTransaction(routeId: routeId, client: identifier); reply() }
  func invalidate() { coordinator.releaseAll(client: identifier) }
}

private final class RemoteHostKeychainService: NSObject, NSXPCListenerDelegate {
  private let client: AuthorizedClient
  private let location: AuthorizedHostLocation
  private let coordinator = EpochCoordinator()

  init(client: AuthorizedClient, location: AuthorizedHostLocation) {
    self.client = client
    self.location = location
  }

  func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
    guard connectionMatches(connection, client: client, location: location) else { return false }
    let exported = RemoteHostKeychainConnection(coordinator: coordinator)
    connection.exportedInterface = NSXPCInterface(with: RemoteHostKeychainXPC.self)
    connection.exportedObject = exported
    connection.invalidationHandler = { [weak exported] in exported?.invalidate() }
    connection.resume()
    return true
  }
}

private func runXPCService() throws -> Never {
  try validateServiceBundle()
  let client = try authorizedClient()
  let location = try authorizedHostLocation(serviceBundleURL: Bundle.main.bundleURL, client: client)
  let listener = NSXPCListener.service()
  let delegate = RemoteHostKeychainService(client: client, location: location)
  listener.delegate = delegate
  listener.resume()
  RunLoop.current.run()
  fatalError("The XPC service run loop unexpectedly returned")
}

do {
  guard CommandLine.arguments.count == 1 else { throw HelperError.unavailable }
  try runXPCService()
} catch {
  exit(1)
}
