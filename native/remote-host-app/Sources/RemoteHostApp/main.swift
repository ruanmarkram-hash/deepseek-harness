import AppKit
import Darwin
import Foundation
import RemoteHostFd199
import RemoteHostRelay
import RemoteHostXChaCha
import Security

private let hostIdentifier = "com.deepseek.dsh.remote-host"
private let keychainServiceName = "com.deepseek.dsh.remote-host.keychain"

private enum HostError: Error { case unavailable }

private struct ServiceRequirement: Decodable { let requirement: String }
private struct HostIdentityResponse: Decodable {
  let ok: Bool
  let publicIdentity: HostPublicIdentity?
}
private struct HostPublicIdentity: Decodable {
  let hostDeviceId: String
  let signingPublicKey: String
  let agreementPublicKey: String
}

/** The helper's identity response, retained so the FD199 signer can read its public key. */
private final class HostIdentityCache: @unchecked Sendable {
  static let shared = HostIdentityCache()
  private let lock = NSLock()
  private var stored: Data? = nil
  func store(_ value: Data) { lock.lock(); stored = value; lock.unlock() }
  func load() -> Data? { lock.lock(); defer { lock.unlock() }; return stored }
}

/** Private, typed XPC calls. They cannot request signing or arbitrary operations. */
@objc private protocol FixedHostIdentityXPC {
  func openHostPublicIdentity(withReply reply: @escaping (Data) -> Void)
  func deriveHostSharedSecret(withPeerPublicKey peerPublicKey: Data, withReply reply: @escaping (Data) -> Void)
  func signFd199OwnershipPayload(_ payload: Data, withReply reply: @escaping (Data) -> Void)
}

/**
 * The sealed Host's public identity and static X25519 operation. The helper
 * receives only one exact peer key and returns only the resulting secret.
 */
private final class FixedHostProtectedAgreement: @unchecked Sendable, RelayHostPublicIdentityProvider, RelayProtectedAgreement {
  private let requirement: String
  private let hostIdentity: RelayEnrollmentHostIdentity

  init() throws {
    guard let resource = Bundle.main.url(forResource: "RemoteHostKeychainServiceRequirement", withExtension: "plist"),
          let data = try? Data(contentsOf: resource),
          let value = try? PropertyListDecoder().decode(ServiceRequirement.self, from: data),
          !value.requirement.isEmpty
    else { throw HostError.unavailable }
    requirement = value.requirement
    hostIdentity = try Self.openHostIdentity(requirement: value.requirement)
  }

  func openHostIdentity() throws -> RelayEnrollmentHostIdentity {
    hostIdentity
  }

  var publicKey: String {
    hostIdentity.agreementPublicKey
  }

  func deriveSharedSecret(peerPublicKey: String) throws -> Data {
    var peer = try canonicalPeerPublicKey(peerPublicKey)
    defer { erase(&peer) }
    let connection = NSXPCConnection(serviceName: keychainServiceName)
    connection.remoteObjectInterface = NSXPCInterface(with: FixedHostIdentityXPC.self)
    connection.setCodeSigningRequirement(requirement)
    let completion = DispatchSemaphore(value: 0)
    let response = LockedResponse()
    let proxy = connection.remoteObjectProxyWithErrorHandler { _ in completion.signal() } as? FixedHostIdentityXPC
    guard let proxy else { throw HostError.unavailable }
    connection.resume()
    proxy.deriveHostSharedSecret(withPeerPublicKey: peer) { value in response.set(value); completion.signal() }
    guard completion.wait(timeout: .now() + .seconds(5)) == .success,
          let secret = response.take(),
          secret.count == 32,
          secret.contains(where: { $0 != 0 })
    else {
      connection.invalidate()
      throw HostError.unavailable
    }
    connection.invalidate()
    return secret
  }

  private static func openHostIdentity(requirement: String) throws -> RelayEnrollmentHostIdentity {
    let connection = NSXPCConnection(serviceName: keychainServiceName)
    connection.remoteObjectInterface = NSXPCInterface(with: FixedHostIdentityXPC.self)
    connection.setCodeSigningRequirement(requirement)
    let completion = DispatchSemaphore(value: 0)
    let response = LockedResponse()
    let proxy = connection.remoteObjectProxyWithErrorHandler { _ in completion.signal() } as? FixedHostIdentityXPC
    guard let proxy else { throw HostError.unavailable }
    connection.resume()
    proxy.openHostPublicIdentity { value in response.set(value); completion.signal() }
    guard completion.wait(timeout: .now() + .seconds(5)) == .success,
          let data = response.take(),
          let decoded = try? JSONDecoder().decode(HostIdentityResponse.self, from: data),
          decoded.ok,
          let identity = decoded.publicIdentity
    else {
      connection.invalidate()
      throw HostError.unavailable
    }
    connection.invalidate()
    HostIdentityCache.shared.store(Data(base64urlEncoded: identity.signingPublicKey) ?? Data())
    return try RelayEnrollmentHostIdentity(hostDeviceId: identity.hostDeviceId, agreementPublicKey: identity.agreementPublicKey)
  }
}

/**
 Production FD199 signing identity: the private key never leaves the signed
 Keychain helper. Each signature call opens one pinned-requirement XPC
 connection and asks for the gated ownership-payload operation; the helper
 refuses anything outside the two canonical payload shapes.
 */
struct Fd199KeychainSigningIdentity: Fd199SigningIdentity {
  var publicKey: Data {
    if let cached = HostIdentityCache.shared.load() { return cached }
    _ = try? FixedHostProtectedAgreement().openHostIdentity()
    return HostIdentityCache.shared.load() ?? Data()
  }

  func signature(_ payload: Data) throws -> Data {
    guard let resource = Bundle.main.url(forResource: "RemoteHostKeychainServiceRequirement", withExtension: "plist"),
          let data = try? Data(contentsOf: resource),
          let value = try? PropertyListDecoder().decode(ServiceRequirement.self, from: data),
          !value.requirement.isEmpty
    else { throw HostError.unavailable }
    let connection = NSXPCConnection(serviceName: keychainServiceName)
    connection.remoteObjectInterface = NSXPCInterface(with: FixedHostIdentityXPC.self)
    connection.setCodeSigningRequirement(value.requirement)
    let completion = DispatchSemaphore(value: 0)
    let response = LockedResponse()
    let proxy = connection.remoteObjectProxyWithErrorHandler { _ in completion.signal() } as? FixedHostIdentityXPC
    guard let proxy else { throw HostError.unavailable }
    connection.resume()
    proxy.signFd199OwnershipPayload(payload) { value in response.set(value); completion.signal() }
    guard completion.wait(timeout: .now() + .seconds(5)) == .success,
          let signature = response.take(),
          signature.count == 64
    else {
      connection.invalidate()
      throw HostError.unavailable
    }
    connection.invalidate()
    return signature
  }
}

/** Decodes unpadded base64url into raw bytes, rejecting every other form. */
private extension Data {
  init?(base64urlEncoded value: String) {
    guard value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let padding = String(repeating: "=", count: (4 - base64.count % 4) % 4)
    guard let decoded = Data(base64Encoded: base64 + padding) else { return nil }
    self = decoded
  }
}

/** Decodes the only textual peer-key form accepted before the typed XPC call. */
private func canonicalPeerPublicKey(_ value: String) throws -> Data {
  guard value.count == 43,
        value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
  else { throw HostError.unavailable }
  let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="
  guard let decoded = Data(base64Encoded: base64), decoded.count == 32,
        decoded.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value
  else { throw HostError.unavailable }
  return decoded
}

private func erase(_ data: inout Data) {
  data.withUnsafeMutableBytes { bytes in
    guard let base = bytes.baseAddress else { return }
    base.initializeMemory(as: UInt8.self, repeating: 0, count: bytes.count)
  }
  data.removeAll(keepingCapacity: false)
}

private final class LockedResponse: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Data?
  func set(_ value: Data) { lock.lock(); self.value = value; lock.unlock() }
  func take() -> Data? { lock.lock(); defer { lock.unlock() }; return value }
}

/** Reject redirects before a native pairing capability can be sent elsewhere. */
private final class PairingNoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

/** The Host-only half of the internet QR/code enrollment exchange. */
@MainActor private final class InternetPairingActions {
  private let actions: LocalPairingActions
  private let store: RelaySecretStore
  private let agreement: FixedHostProtectedAgreement
  private let redirectDelegate = PairingNoRedirects()
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: configuration, delegate: redirectDelegate, delegateQueue: nil)
  }()

  init(actions: LocalPairingActions, store: RelaySecretStore, agreement: FixedHostProtectedAgreement) { self.actions = actions; self.store = store; self.agreement = agreement }

  func begin() async throws {
    let pairingId = try randomToken(bytes: 24)
    let code = try randomToken(bytes: 32)
    let hostToken = try randomToken(bytes: 32)
    let expiresAt = Date().addingTimeInterval(10 * 60)
    let expiryMilliseconds = Int(expiresAt.timeIntervalSince1970 * 1_000)
    let creation = try RelayV3PairingRequestCodec.create(pairingId: pairingId, code: code, hostToken: hostToken, expiresAt: expiryMilliseconds, provisioning: try store.provisioningCredential())
    guard try await send(creation).statusCode == 201 else { throw HostError.unavailable }
    let encoded = "dsh3.\(pairingId).\(code)"
    showCode(encoded, expiresAt: expiresAt)
    while Date() < expiresAt {
      try await Task.sleep(for: .seconds(2))
      let response = try await send(try RelayV3PairingRequestCodec.offer(pairingId: pairingId, hostToken: hostToken))
      if response.statusCode == 204 { continue }
      guard response.statusCode == 200 else { throw HostError.unavailable }
      let device = try RelayEnrollmentOfferCodec.decode(response.body)
      let fingerprint = try RelayEnrollmentOfferCodec.fingerprint(device)
      let confirmation = NSAlert()
      confirmation.messageText = "Approve iPhone pairing?"
      confirmation.informativeText = "Device: \(device.label)\nFingerprint: \(fingerprint)\n\nOnly approve after comparing this fingerprint with the phone."
      confirmation.addButton(withTitle: "Approve")
      confirmation.addButton(withTitle: "Decline")
      guard confirmation.runModal() == .alertFirstButtonReturn else { throw HostError.unavailable }
      let candidate = try actions.recordReviewedPublicOffer(device)
      let invitation = try await actions.confirmRecordedOffer(candidate)
      let sealed = try seal(invitation, pairingId: pairingId)
      guard try await send(try RelayV3PairingRequestCodec.publishInvitation(pairingId: pairingId, hostToken: hostToken, hostStaticAgreementPublicKey: invitation.hostStaticAgreementPublicKey, nonce: sealed.nonce, ciphertext: sealed.ciphertext)).statusCode == 204 else {
        try? await actions.revokeActiveRoute()
        throw HostError.unavailable
      }
      return
    }
    throw HostError.unavailable
  }

  private func send(_ fixed: RelayHTTPRequest) async throws -> (statusCode: Int, body: Data) {
    var request = URLRequest(url: fixed.url)
    request.httpMethod = fixed.method; request.httpBody = fixed.body
    for (field, value) in fixed.headers { request.setValue(value, forHTTPHeaderField: field) }
    let result = try await session.data(for: request)
    guard let response = result.1 as? HTTPURLResponse, response.url == fixed.url else { throw HostError.unavailable }
    return (response.statusCode, result.0)
  }

  private func showCode(_ code: String, expiresAt: Date) {
    PairingCodeDialog.make(code: code, expiresAt: expiresAt).runModal()
  }

  private func randomToken(bytes: Int) throws -> String {
    var data = Data(repeating: 0, count: bytes)
    let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
    guard status == errSecSuccess else { throw HostError.unavailable }
    return data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private func seal(_ invitation: RelayEnrollmentInvitation, pairingId: String) throws -> (nonce: String, ciphertext: String) {
    var sharedSecret = try agreement.deriveSharedSecret(peerPublicKey: invitation.deviceAgreementPublicKey)
    defer { erase(&sharedSecret) }
    var nonce = Data(repeating: 0, count: 12)
    let nonceLength = nonce.count
    guard nonce.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, nonceLength, $0.baseAddress!) }) == errSecSuccess else { throw HostError.unavailable }
    defer { erase(&nonce) }
    let plaintext = try RelayPhoneInvitationCodec.encode(invitation)
    let ciphertext = try XChaCha.seal(plaintext, aad: Data("dsh3.invitation.\(pairingId)".utf8), key: try XChaChaKey(sharedSecret), nonce: try XChaChaNonce(nonce))
    return (nonce.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""), ciphertext.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""))
  }
}

/** Process-local explicit actions. No listener, token, key, or generic IPC is exposed. */
@MainActor private final class LocalPairingActions {
  private let composition: RelayHostPairingComposition
  init(composition: RelayHostPairingComposition) { self.composition = composition }
  /** Records only a human-reviewed public offer as pending local confirmation. */
  func recordReviewedPublicOffer(_ device: RelayEnrollmentDevice) throws -> RelayEnrollmentCandidate {
    try composition.acceptIPhoneIdentity(device)
  }
  func confirmRecordedOffer(_ candidate: RelayEnrollmentCandidate) async throws -> RelayEnrollmentInvitation {
    try await composition.confirmLocally(candidate)
  }
  func reissueActiveInvitation() throws -> RelayEnrollmentInvitation {
    try composition.reissueActiveInvitation()
  }
  func revokeActiveRoute() async throws {
    try await composition.revokeActiveRoute()
  }
}

/**
 * Host-local menu control. It imports only a bounded public offer selected by
 * the person at this Mac, renders its full fingerprint, and requires a second
 * local click before recording a pending candidate. It has no IPC endpoint.
 */
@MainActor private final class LocalEnrollmentMenu: NSObject {
  private let actions: LocalPairingActions
  private let internetPairing: InternetPairingActions
  private let hostedRuntime: HostedRuntimeController
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

  init(actions: LocalPairingActions, internetPairing: InternetPairingActions, hostedRuntime: HostedRuntimeController) {
    self.actions = actions
    self.internetPairing = internetPairing
    self.hostedRuntime = hostedRuntime
  }

  func install() {
    statusItem.button?.title = "DSH Host"
    let menu = NSMenu()
    let importOffer = NSMenuItem(title: "Import iPhone enrollment offer…", action: #selector(importOffer), keyEquivalent: "")
    importOffer.target = self
    menu.addItem(importOffer)
    let pairFromAnywhere = NSMenuItem(title: "Pair iPhone from anywhere…", action: #selector(pairIPhoneFromAnywhere), keyEquivalent: "")
    pairFromAnywhere.target = self
    menu.addItem(pairFromAnywhere)
    let startHosted = NSMenuItem(title: "Start hosted runtime", action: #selector(startHostedRuntime), keyEquivalent: "")
    startHosted.target = self
    menu.addItem(startHosted)
    let activatePhone = NSMenuItem(title: "Activate paired phone", action: #selector(activatePairedPhone), keyEquivalent: "")
    activatePhone.target = self
    menu.addItem(activatePhone)
    let copyInvitation = NSMenuItem(title: "Copy fresh iPhone invitation", action: #selector(copyActiveInvitation), keyEquivalent: "")
    copyInvitation.target = self
    menu.addItem(copyInvitation)
    let revokePhone = NSMenuItem(title: "Revoke paired phone…", action: #selector(revokePairedPhone), keyEquivalent: "")
    revokePhone.target = self
    menu.addItem(revokePhone)
    menu.addItem(.separator())
    let quit = NSMenuItem(title: "Quit DSH Host", action: #selector(quitHost), keyEquivalent: "q")
    quit.target = self
    menu.addItem(quit)
    statusItem.menu = menu
    // Opening this accessory app must expose its controls even when macOS has
    // overflowed the status item out of the visible menu bar.
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      NSApp.activate(ignoringOtherApps: true)
      self.presentControls()
    }
  }

  private func presentControls() {
    let alert = NSAlert()
    alert.messageText = "DSH Host controls"
    alert.informativeText = "Start the sealed hosted runtime, then activate the paired phone transport."
    alert.addButton(withTitle: "Start hosted runtime")
    alert.addButton(withTitle: "Activate paired phone")
    alert.addButton(withTitle: "Revoke paired phone…")
    alert.addButton(withTitle: "Not now")
    switch alert.runModal() {
    case .alertFirstButtonReturn: startHostedRuntime()
    case .alertSecondButtonReturn: activatePairedPhone()
    case .alertThirdButtonReturn: revokePairedPhone()
    default: break
    }
  }

  @objc private func importOffer() {
    let panel = NSOpenPanel()
    panel.title = "Import iPhone enrollment offer"
    panel.message = "Choose the public offer file you transferred from the iPhone."
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = false
    panel.allowedContentTypes = [.json]
    panel.begin { [weak self] result in
      guard result == .OK, let url = panel.url, let self else { return }
      do {
        let review = try self.readPublicOffer(url)
        self.review(review)
      } catch {
        self.showFailure("That file is not an exact DSH public enrollment offer.")
      }
    }
  }

  @objc private func pairIPhoneFromAnywhere() {
    Task { @MainActor [internetPairing] in
      do {
        try await internetPairing.begin()
        self.showSuccess("The approved phone invitation was delivered through the public relay. The phone can now connect from any network.")
      } catch {
        self.showFailure("Internet pairing could not complete. No route is active unless the Host explicitly approved the displayed phone fingerprint.")
      }
    }
  }

  private func readPublicOffer(_ url: URL) throws -> RelayLocalEnrollmentOfferReview {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    guard let data = try handle.read(upToCount: 4 * 1024 + 1), data.count <= 4 * 1024 else {
      throw RelayEnrollmentError.invalidInput
    }
    return try RelayLocalEnrollmentOfferReview(importedOffer: data)
  }

  private func review(_ review: RelayLocalEnrollmentOfferReview) {
    let alert = NSAlert()
    alert.messageText = "Confirm iPhone enrollment offer"
    alert.informativeText = "Device: \(review.preview.label)\nFingerprint: \(review.preview.fingerprint)\n\nCompare both with the iPhone. Confirming records a local pending offer only. Provisioning remains disabled."
    alert.addButton(withTitle: "Confirm locally")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    do {
      var candidate: RelayEnrollmentCandidate?
      try review.confirm { device in candidate = try actions.recordReviewedPublicOffer(device) }
      guard let candidate else { throw RelayEnrollmentError.unavailable }
      Task { @MainActor [actions] in
        do {
          let invitation = try await actions.confirmRecordedOffer(candidate)
          self.presentPhoneInvitation(invitation)
        } catch RelayEnrollmentLifecycleError.provisioningDisabled {
          self.showFailure("Offer is pending locally. No route, token, socket, or phone pairing was created because this signed Host has no provisioning activation configuration.")
        } catch {
          self.showFailure("The local confirmation could not complete. No invitation was shown.")
        }
      }
    } catch {
      showFailure("The offer could not be recorded. No pairing or route was created.")
    }
  }

  private func presentPhoneInvitation(_ invitation: RelayEnrollmentInvitation) {
    guard let data = try? RelayPhoneInvitationCodec.encode(invitation), let text = String(data: data, encoding: .utf8) else { showFailure("Invitation presentation failed."); return }
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    let alert = NSAlert(); alert.messageText = "Phone invitation copied"; alert.informativeText = "The exact phone-safe V3 invitation is in the local clipboard. It contains no Host token or private key."; alert.addButton(withTitle: "OK"); alert.runModal()
  }

  /**
   Starts the hosted FD199 runtime behind every production gate: sealed bundle
   validation, embedded-child manifest verification, Keychain-signed proofs,
   and the signed supervisor spawn. Absent release artifacts this fails closed
   with an explicit unavailable message, exactly like the sealed gateway path.
   */
  @objc private func startHostedRuntime() {
    Task { @MainActor [hostedRuntime] in
      do {
        try await hostedRuntime.start()
        showSuccess("Hosted runtime started. The relay remains off until you explicitly activate the paired phone.")
        presentControls()
      } catch {
        showFailure("The hosted runtime could not start: \(String(describing: error))")
      }
    }
  }

  /** Runs the signed ownership transition before the native relay socket is allowed to start. */
  @objc private func activatePairedPhone() {
    Task { @MainActor [hostedRuntime] in
      do {
        try await hostedRuntime.activatePhoneSessions()
        self.showSuccess("The paired phone is now eligible to connect through the activated Host transport.")
      } catch {
        self.showFailure("Phone activation could not complete: \(String(describing: error))")
      }
    }
  }

  @objc private func copyActiveInvitation() {
    do { presentPhoneInvitation(try actions.reissueActiveInvitation()) }
    catch { showFailure("There is no active route for this Host to copy.") }
  }

  @objc private func revokePairedPhone() {
    let alert = NSAlert()
    alert.messageText = "Revoke paired phone?"
    alert.informativeText = "This stops the retained relay and hosted child, removes the route credentials, and requires a fresh pairing before the phone can connect again."
    alert.addButton(withTitle: "Revoke")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    Task { @MainActor [actions, hostedRuntime] in
      do {
        try await hostedRuntime.revokePhoneSessions { try await actions.revokeActiveRoute() }
        self.showSuccess("The paired phone was revoked. Pair again to create a fresh route.")
      } catch {
        self.showFailure("Phone revocation could not complete: \(String(describing: error))")
      }
    }
  }

  private func showSuccess(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "DSH Host"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.runModal()
  }

  private func showFailure(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "DSH Host enrollment"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.runModal()
  }

  @objc private func quitHost() {
    Task { @MainActor [hostedRuntime] in
      await hostedRuntime.stop()
      NSApp.terminate(nil)
    }
  }
}

/** Validates the sealed enclosing Host bundle before it reads or starts any runtime resource. */
private func validateSelf() throws {
  let bundle = Bundle.main
  let bundleURL = bundle.bundleURL.resolvingSymlinksInPath()
  guard bundleURL.pathExtension == "app",
        bundle.executableURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
  else { throw HostError.unavailable }
  var code: SecStaticCode?
  guard SecStaticCodeCreateWithPath(bundleURL as CFURL, [], &code) == errSecSuccess,
        let code,
        SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess
  else { throw HostError.unavailable }
  var information: CFDictionary?
  guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
        let values = information as? [String: Any],
        values[kSecCodeInfoIdentifier as String] as? String == hostIdentifier
  else { throw HostError.unavailable }
}

var startupStage: Int32 = 1
do {
  if CommandLine.arguments == [CommandLine.arguments[0], "--copy-active-invitation"] {
    try validateSelf()
    let provider = try FixedHostProtectedAgreement()
    let store = try KeychainRelaySecretStore(hostExecutablePath: CommandLine.arguments[0])
    guard let route = try store.activeRouteCredential() else { throw HostError.unavailable }
    let invitation = try RelayActiveRouteInvitationIssuer.issue(route: route, host: provider.openHostIdentity())
    guard let data = try? RelayPhoneInvitationCodec.encode(invitation), let text = String(data: data, encoding: .utf8) else { throw HostError.unavailable }
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    exit(0)
  }
  if CommandLine.arguments == [CommandLine.arguments[0], "--install-provisioning-credential-stdin"] {
    try validateSelf()
    guard let input = try FileHandle.standardInput.read(upToCount: 258), input.count > 0, input.count <= 257, var token = String(data: input, encoding: .utf8) else { throw HostError.unavailable }
    defer { token.withUTF8 { bytes in _ = bytes } }
    token = token.trimmingCharacters(in: .newlines)
    let store = try KeychainRelaySecretStore(hostExecutablePath: CommandLine.arguments[0])
    try store.installProvisioningCredential(try RelayProvisioningCredential(token))
    exit(0)
  }
  guard CommandLine.arguments.count == 1 else { throw HostError.unavailable }
  startupStage = 2
  try validateSelf()
  let runtime = RelayPrivateRuntimeSupervisor()
  startupStage = 3
  try runtime.start()
  startupStage = 4
  try runtime.waitUntilReady()
  startupStage = 5
  let provider = try FixedHostProtectedAgreement()
  startupStage = 6
  let store = try KeychainRelaySecretStore(hostExecutablePath: CommandLine.arguments[0])
  startupStage = 61
  _ = try store.revokedCleanupRouteCredential()
  _ = try store.pendingRouteCredential()
  _ = try store.activeRouteCredential()
  startupStage = 7
  let composition = try RelayHostPairingComposition.makeForVerifiedHost(identity: provider, store: store, supervisor: runtime)
  let localActions = LocalPairingActions(composition: composition)
  let internetPairing = InternetPairingActions(actions: localActions, store: store, agreement: provider)
  let hostedRuntime = HostedRuntimeController(agreement: provider, store: store, connectionCoordinator: composition.connectionCoordinator)
  MainActor.assumeIsolated {
    let localMenu = LocalEnrollmentMenu(actions: localActions, internetPairing: internetPairing, hostedRuntime: hostedRuntime)
    NSApplication.shared.setActivationPolicy(.accessory)
    localMenu.install()
    withExtendedLifetime((runtime, localMenu, provider, hostedRuntime, internetPairing)) { NSApplication.shared.run() }
  }
} catch {
  FileHandle.standardError.write(Data("DSH Host startup failed at stage \(startupStage)\n".utf8))
  exit(startupStage)
}
