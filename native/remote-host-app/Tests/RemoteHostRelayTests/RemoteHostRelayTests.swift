import Foundation
import Testing
import Security
@testable import RemoteHostRelay

@Test func duplicateKeychainUpdatesPreserveTheProvisionedAccessControlList() {
  let data = Data("replacement".utf8)
  let attributes = KeychainRelaySecretStore.duplicateUpdateAttributes(data)
  #expect(Set(attributes.keys) == [kSecValueData as String])
  #expect(attributes[kSecValueData as String] as? Data == data)
  #expect(attributes[kSecAttrAccess as String] == nil)
}
@testable import RemoteHostXChaCha
import CryptoKit

private let identifier = String(repeating: "a", count: 16)
private let hostIdentifier = String(repeating: "h", count: 16)
private let deviceIdentifier = String(repeating: "d", count: 16)
private let enrollment = String(repeating: "e", count: 16)
private let hostToken = String(repeating: "H", count: 32)
private let deviceToken = String(repeating: "D", count: 32)
private let provisioningToken = String(repeating: "P", count: 32)
private let devicePrivate = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 3, count: 32))
private let hostPrivate = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
private func b64url(_ value: Data) -> String { value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
private func b64urlData(_ value: String) throws -> Data {
  var padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
  return try #require(Data(base64Encoded: padded))
}
private let deviceAgreement = b64url(devicePrivate.publicKey.rawRepresentation)
private let deviceSigning = b64url(Data(repeating: 9, count: 32))

private func route(generation: Int = 1, hostToken: String = hostToken, deviceToken: String = deviceToken) throws -> RelayRouteCredential {
  try RelayRouteCredential(routeId: identifier, hostDeviceId: hostIdentifier, hostEnrollmentId: enrollment, deviceId: deviceIdentifier, deviceEnrollmentId: enrollment, deviceSigningPublicKey: deviceSigning, deviceAgreementPublicKey: deviceAgreement, generation: generation, hostToken: hostToken, deviceToken: deviceToken)
}

private final class MemoryStore: @unchecked Sendable, RelaySecretStore {
  private let epochScope = UUID().uuidString
  lazy var connectionEpochCoordinator: any RelayConnectionEpochCoordinator = RelayConnectionEpochInMemoryCoordinator(scope: epochScope)
  let provisioning = try! RelayProvisioningCredential(provisioningToken)
  var routes: [String: RelayRouteCredential] = [:]
  var active: RelayRouteCredential?
  var pending: [String: RelayRouteCredential] = [:]
  var revokedCleanup: [String: RelayRouteCredential] = [:]
  var epochs: [String: RelayConnectionEpochState] = [:]
  func provisioningCredential() throws -> RelayProvisioningCredential { provisioning }
  func routeCredential(routeId: String) throws -> RelayRouteCredential? { routes[routeId] }
  func saveRouteCredential(_ credential: RelayRouteCredential) throws { routes[credential.routeId] = credential }
  func removeRouteCredential(routeId: String) throws { routes.removeValue(forKey: routeId) }
  func activeRouteCredential() throws -> RelayRouteCredential? { active }
  func saveActiveRouteCredential(_ credential: RelayRouteCredential) throws { active = credential }
  func removeActiveRouteCredential(routeId: String) throws { if active?.routeId == routeId { active = nil } }
  func pendingRouteCredential() throws -> RelayRouteCredential? { pending.values.first }
  func savePendingRouteCredential(_ credential: RelayRouteCredential) throws { pending = [credential.routeId: credential] }
  func removePendingRouteCredential(routeId: String) throws { pending.removeValue(forKey: routeId) }
  func revokedCleanupRouteCredential() throws -> RelayRouteCredential? { revokedCleanup.values.first }
  func saveRevokedCleanupRouteCredential(_ credential: RelayRouteCredential) throws { revokedCleanup = [credential.routeId: credential] }
  func removeRevokedCleanupRouteCredential(routeId: String) throws { revokedCleanup.removeValue(forKey: routeId) }
  func connectionEpochState(routeId: String) throws -> RelayConnectionEpochState? { epochs[routeId] }
  func saveConnectionEpochState(_ state: RelayConnectionEpochState) throws { epochs[state.routeId] = state }
  func removeConnectionEpochState(routeId: String) throws { epochs.removeValue(forKey: routeId) }
}

private final class RecordingTransport: @unchecked Sendable, RelayHTTPTransport {
  var requests: [RelayHTTPRequest] = []
  var next = RelayHTTPResponse(status: 201)
  func send(_ request: RelayHTTPRequest) throws -> RelayHTTPResponse { requests.append(request); return next }
}

private actor RecordingSocket: RelayHostSocket {
  var sent: [Data] = []
  var closed = false
  func send(_ data: Data, fence: RelayHostSendFence) async throws -> Bool { guard await fence.isOpen() else { return false }; sent.append(data); return true }
  func receive() async throws -> Data { throw RelayOwnerError.unavailable }
  func close() async { closed = true }
  func snapshot() -> ([Data], Bool) { (sent, closed) }
}

private actor QueueSocket: RelayHostSocket {
  var sent: [Data] = []
  var inbound: [Data] = []
  var closed = false
  func send(_ data: Data, fence: RelayHostSendFence) async throws -> Bool {
    guard await fence.isOpen(), !closed else { return false }
    sent.append(data)
    return true
  }
  func receive() async throws -> Data {
    guard !closed, !inbound.isEmpty else { throw RelayOwnerError.unavailable }
    return inbound.removeFirst()
  }
  func enqueue(_ data: Data) { inbound.append(data) }
  func close() async { closed = true }
}

private final class AdmissionCounter: @unchecked Sendable {
  private let lock = NSLock()
  private let allowedChecks: Int
  init(allowedChecks: Int) { self.allowedChecks = allowedChecks }
  func check() throws {
    let admitted = lock.withLock { () -> Bool in
      let next = checks + 1; checks = next; return next <= allowedChecks
    }
    guard admitted else { throw RelayOwnerError.unavailable }
  }
  private var checks = 0
}

private func establishedTransport(socket: QueueSocket, admission: AdmissionCounter) async throws -> (RelayHostTransport, RelayFlight, RelayFlight) {
  let transport = try RelayHostTransport(credential: route(), agreement: TestAgreement(), socket: socket, clock: TestClock(), random: TestRandom(), expectedConnectionEpoch: 1, finalizeConnectionEpoch: { _ in }, ensureConnectionAdmitted: { try admission.check() })
  let helloBytes = flight("hello")
  try await transport.processSimulatedInbound(helloBytes)
  let hello = try RelayFlightCodec.decode(helloBytes)
  let welcome = try RelayFlightCodec.decode((await socket.sent)[0])
  try await transport.processSimulatedInbound(try await encryptedDeviceFlight(type: "ready", text: "dsh-remote/v3/ready", hello: hello, welcome: welcome))
  try await transport.processSimulatedInbound(try await encryptedDeviceFlight(type: "ack", text: "dsh-remote/v3/ack", hello: hello, welcome: welcome))
  try await transport.processSimulatedInbound(try await encryptedDeviceFlight(type: "confirm", text: "dsh-remote/v3/confirm", hello: hello, welcome: welcome))
  return (transport, hello, welcome)
}

private actor CoordinatedStartableSocket: RelayHostStartableSocket {
  var sent: [Data] = []
  var inbound: [Data] = []
  var started = false
  var closed = false
  var rejectWrites = false
  var preserveReadOnClose = false
  private var receives = 0
  private var receiveObservers: [(Int, CheckedContinuation<Void, Never>)] = []
  private var receiveWaiter: CheckedContinuation<Data, Error>?
  private var sentWaiter: CheckedContinuation<Void, Never>?
  func start() async throws { started = true }
  func send(_ data: Data, fence: RelayHostSendFence) async throws -> Bool {
    guard !closed, !rejectWrites, await fence.isOpen() else { return false }
    sent.append(data)
    sentWaiter?.resume(); sentWaiter = nil
    return true
  }
  func receive() async throws -> Data {
    guard !closed else { throw RelayOwnerError.unavailable }
    receives += 1
    let ready = receiveObservers.filter { $0.0 <= receives }
    receiveObservers.removeAll { $0.0 <= receives }
    for (_, continuation) in ready { continuation.resume() }
    if !inbound.isEmpty { return inbound.removeFirst() }
    return try await withCheckedThrowingContinuation { receiveWaiter = $0 }
  }
  func enqueue(_ data: Data) {
    if let receiveWaiter { self.receiveWaiter = nil; receiveWaiter.resume(returning: data) }
    else { inbound.append(data) }
  }
  func waitForSent(count: Int) async {
    if sent.count >= count { return }
    await withCheckedContinuation { sentWaiter = $0 }
  }
  func setRejectWrites() { rejectWrites = true }
  func keepPendingReadAfterClose() { preserveReadOnClose = true }
  func waitForReceive(count: Int) async {
    if receives >= count { return }
    await withCheckedContinuation { receiveObservers.append((count, $0)) }
  }
  func close() async {
    closed = true
    if !preserveReadOnClose { receiveWaiter?.resume(throwing: RelayOwnerError.unavailable); receiveWaiter = nil }
  }
}

private final class CoordinatedSocketFactory: @unchecked Sendable, RelayHostSocketFactory {
  let socket: CoordinatedStartableSocket
  init(socket: CoordinatedStartableSocket) { self.socket = socket }
  func make(credential: RelayRouteCredential) throws -> any RelayHostStartableSocket { socket }
}

private actor GatedStartableSocket: RelayHostStartableSocket {
  private var startEntered: CheckedContinuation<Void, Never>?
  private var allowStart: CheckedContinuation<Void, Never>?
  private(set) var closed = false
  private(set) var sends = 0
  func start() async throws {
    startEntered?.resume(); startEntered = nil
    await withCheckedContinuation { allowStart = $0 }
  }
  func send(_ data: Data, fence: RelayHostSendFence) async throws -> Bool { sends += 1; return await fence.isOpen() }
  func receive() async throws -> Data { throw RelayOwnerError.unavailable }
  func close() async { closed = true; allowStart?.resume(); allowStart = nil }
  func waitForStart() async {
    if allowStart != nil { return }
    await withCheckedContinuation { startEntered = $0 }
  }
  func resumeStart() { allowStart?.resume(); allowStart = nil }
}

private final class GatedSocketFactory: @unchecked Sendable, RelayHostSocketFactory {
  let socket: GatedStartableSocket
  init(socket: GatedStartableSocket) { self.socket = socket }
  func make(credential: RelayRouteCredential) throws -> any RelayHostStartableSocket { socket }
}

private actor BlockingSocket: RelayHostSocket {
  var closed = false
  func send(_ data: Data, fence: RelayHostSendFence) async throws -> Bool { await fence.isOpen() }
  func receive() async throws -> Data { try await Task.sleep(nanoseconds: 60_000_000_000); throw RelayOwnerError.unavailable }
  func close() async { closed = true }
}
private actor DelayedFenceSocket: RelayHostSocket {
  var sent: [Data] = []; var closed = false
  func send(_ data: Data, fence: RelayHostSendFence) async throws -> Bool {
    try? await Task.sleep(nanoseconds: 20_000_000) // deliberately ignores cancellation
    guard await fence.isOpen() else { return false }
    sent.append(data); return true
  }
  func receive() async throws -> Data { throw RelayOwnerError.unavailable }
  func close() async { closed = true }
}
private actor ControlledFenceSocket: RelayHostSocket {
  var sent: [Data] = []; var closed = false; var closedWhileFenceOpen = false
  private var fence: RelayHostSendFence?; private var started = false; private var sendStarted: CheckedContinuation<Void, Never>?; private var releaseSend: CheckedContinuation<Void, Never>?; private var receiveWaiter: CheckedContinuation<Data, Error>?; private var closeWaiter: CheckedContinuation<Void, Never>?
  func send(_ data: Data, fence: RelayHostSendFence) async throws -> Bool {
    self.fence = fence; started = true; sendStarted?.resume(); sendStarted = nil
    await withCheckedContinuation { releaseSend = $0 }
    guard await fence.isOpen() else { return false }
    sent.append(data); return true
  }
  func receive() async throws -> Data { try await withCheckedThrowingContinuation { receiveWaiter = $0 } }
  func close() async { closed = true; if let fence { closedWhileFenceOpen = await fence.isOpen() }; receiveWaiter?.resume(throwing: RelayOwnerError.unavailable); receiveWaiter = nil; closeWaiter?.resume(); closeWaiter = nil }
  func waitForSendStart() async { if started { return }; await withCheckedContinuation { sendStarted = $0 } }
  func release() { releaseSend?.resume(); releaseSend = nil }
  func waitForClose() async { if closed { return }; await withCheckedContinuation { closeWaiter = $0 } }
}

private final class TestClock: @unchecked Sendable, RelayTransportClock {
  var value: UInt64 = 100
  func nowNanoseconds() -> UInt64 { value }
  func sleep(untilNanoseconds: UInt64) async throws { try await Task.sleep(nanoseconds: 60_000_000_000) }
}

private final class ControlledHostClock: @unchecked Sendable, RelayTransportClock {
  private let lock = NSLock()
  private var now: UInt64 = 0
  private var sleepers: [(UInt64, CheckedContinuation<Void, Never>)] = []
  func nowNanoseconds() -> UInt64 { lock.withLock { now } }
  func sleep(untilNanoseconds expiry: UInt64) async throws {
    await withCheckedContinuation { continuation in
      let expired = lock.withLock {
        if now >= expiry { return true }
        sleepers.append((expiry, continuation))
        return false
      }
      if expired { continuation.resume() }
    }
  }
  func advance(to value: UInt64) {
    let ready = lock.withLock {
      now = value
      let ready = sleepers.filter { $0.0 <= value }
      sleepers.removeAll { $0.0 <= value }
      return ready
    }
    for (_, continuation) in ready { continuation.resume() }
  }
}
private final class ImmediateDeadlineClock: @unchecked Sendable, RelayTransportClock {
  func nowNanoseconds() -> UInt64 { 100 }
  func sleep(untilNanoseconds: UInt64) async throws { throw RelayOwnerError.deadlineExceeded }
}
private final class RendezvousDeadlineClock: @unchecked Sendable, RelayTransportClock {
  enum Mode { case expiry, thrown }
  private let queue = DispatchQueue(label: "RendezvousDeadlineClock"); private let mode: Mode; private var sleeps = 0; private var firstWaiter: CheckedContinuation<Void, Never>?; private var firstSleep: CheckedContinuation<Void, Never>?
  init(_ mode: Mode) { self.mode = mode }
  func nowNanoseconds() -> UInt64 { 100 }
  func sleep(untilNanoseconds: UInt64) async throws {
    let count = queue.sync { () -> Int in sleeps += 1; return sleeps }
    if count == 1 { await withCheckedContinuation { continuation in queue.sync { firstSleep = continuation; firstWaiter?.resume(); firstWaiter = nil } }; return }
    if mode == .thrown { throw RelayOwnerError.deadlineExceeded }
  }
  func waitForFirstSleep() async {
    if queue.sync(execute: { firstSleep != nil }) { return }
    await withCheckedContinuation { continuation in queue.sync { if firstSleep != nil { continuation.resume() } else { firstWaiter = continuation } } }
  }
  func releaseFirstSleep() { queue.sync { firstSleep?.resume(); firstSleep = nil } }
}

private final class TestRandom: @unchecked Sendable, RelayTransportRandom {
  private var counter: UInt8 = 1
  func bytes(count: Int) throws -> Data {
    defer { counter &+= 1 }
    return Data(repeating: counter, count: count)
  }
}

private final class TestAgreement: @unchecked Sendable, RelayProtectedAgreement {
  let publicKey = b64url(hostPrivate.publicKey.rawRepresentation)
  var peers: [String] = []
  func deriveSharedSecret(peerPublicKey: String) throws -> Data {
    peers.append(peerPublicKey)
    var value = peerPublicKey.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    value += String(repeating: "=", count: (4 - value.count % 4) % 4)
    let peer = try! Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(base64Encoded: value)!)
    return try! hostPrivate.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
  }
}

@Test func fixedCreateRequestHasExactV3OriginHeadersAndBody() throws {
  let request = try RelayV3RequestCodec.create(route(), provisioning: try RelayProvisioningCredential(provisioningToken))
  #expect(request.method == "POST")
  #expect(request.url.absoluteString == "https://dshrelay.rulabs.dev/v3/routes/" + identifier)
  #expect(request.headers["authorization"] == "Bearer " + provisioningToken)
  #expect(request.headers["content-type"] == "application/json; charset=utf-8")
  let object = try JSONSerialization.jsonObject(with: try #require(request.body)) as! [String: Any]
  #expect(Set(object.keys) == Set(["version", "hostDeviceId", "hostEnrollmentId", "deviceId", "deviceEnrollmentId", "hostToken", "deviceToken"]))
  #expect(object["version"] as? Int == 3)
}

@Test func rejectsHostileCredentialsAndRotationMismatches() throws {
  #expect(throws: RelayOwnerError.invalidCredential) {
    try RelayRouteCredential(routeId: "../route", hostDeviceId: hostIdentifier, hostEnrollmentId: enrollment, deviceId: deviceIdentifier, deviceEnrollmentId: enrollment, deviceSigningPublicKey: deviceSigning, deviceAgreementPublicKey: deviceAgreement, generation: 1, hostToken: hostToken, deviceToken: deviceToken)
  }
  #expect(throws: RelayOwnerError.invalidCredential) {
    try RelayProvisioningCredential("not a token")
  }
  #expect(throws: RelayOwnerError.invalidCredential) {
    try RelayV3RequestCodec.rotate(route(generation: 3), previousHostToken: route(generation: 1))
  }
}

@Test func relayWireFactsCannotContainRouteTokens() throws {
  let record = try RelayWireCodec.upsert(route())
  #expect(record.kind == .routeUpsert)
  let text = String(data: record.metadata, encoding: .utf8)!
  #expect(!text.contains(hostToken))
  #expect(!text.contains(deviceToken))
  let revoked = try RelayWireCodec.revoked(route())
  #expect(revoked.kind == .routeRevoked)
  let revokedMetadata = try JSONSerialization.jsonObject(with: revoked.metadata) as! [String: Any]
  #expect(Set(revokedMetadata.keys) == ["deviceId"])
  #expect(revokedMetadata["deviceId"] as? String == deviceIdentifier)
}

@Test func ownerStoresOnlyAfterAcceptedCreateAndFailsClosed() throws {
  let store = MemoryStore(); let transport = RecordingTransport(); let owner = RelayOwner(store: store, transport: transport)
  let credential = try route()
  try owner.provision(credential)
  #expect(owner.state == .provisioned)
  #expect(try store.routeCredential(routeId: identifier) == credential)
  transport.next = RelayHTTPResponse(status: 500)
  #expect(throws: RelayOwnerError.rejected) { try owner.revoke(routeId: identifier) }
  #expect(owner.state == .provisioned)
  #expect(try store.routeCredential(routeId: identifier) == credential)
}

private func flight(_ type: String, sender: String = deviceIdentifier, recipient: String = hostIdentifier) -> Data {
  var value: [String: Any] = ["version": 3, "type": type, "routeId": identifier, "generation": 1, "connectionEpoch": 1,
    "senderDeviceId": sender, "senderEnrollmentId": enrollment, "recipientDeviceId": recipient, "recipientEnrollmentId": enrollment]
  if type == "hello" || type == "welcome" { value["ephemeralPublicKey"] = type == "hello" ? deviceAgreement : b64url(Data(repeating: 8, count: 32)); value["nonce"] = b64url(Data(repeating: 14, count: 12)) }
  else { value["nonce"] = b64url(Data(repeating: 14, count: 12)); value["ciphertext"] = b64url(Data(repeating: 12, count: 24)) }
  return try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}

private func encryptedDeviceFlight(type: String, text: String, hello: RelayFlight, welcome: RelayFlight) async throws -> Data {
  let context = try RelayFlightCodec.handshakeContext(hello: hello, welcome: welcome)
  var encodedWelcome = welcome.ephemeralPublicKey!.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  encodedWelcome += String(repeating: "=", count: (4 - encodedWelcome.count % 4) % 4)
  let welcomePublic = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: try #require(Data(base64Encoded: encodedWelcome)))
  let hostPublic = hostPrivate.publicKey
  func secret(_ peer: Curve25519.KeyAgreement.PublicKey) throws -> Data { try devicePrivate.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) } }
  var material = Data(); material.append(try secret(hostPublic)); material.append(try secret(welcomePublic)); material.append(try secret(hostPublic)); material.append(try secret(welcomePublic))
  let symmetric = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: material), salt: context, info: Data("dsh-remote/v3/3dh".utf8), outputByteCount: 64)
  let key = try XChaChaKey(symmetric.withUnsafeBytes { Data($0.prefix(32)) })
  let base: [String: Any] = ["version": 3, "type": type, "routeId": identifier, "generation": 1, "connectionEpoch": 1,
    "senderDeviceId": deviceIdentifier, "senderEnrollmentId": enrollment, "recipientDeviceId": hostIdentifier, "recipientEnrollmentId": enrollment,
    "nonce": String(repeating: "A", count: 16), "ciphertext": String(repeating: "A", count: 24)]
  let aad = try JSONSerialization.data(withJSONObject: [type, identifier, 1, 1, deviceIdentifier, enrollment, hostIdentifier, enrollment], options: [])
  let nonce = try XChaChaNonce(Data(repeating: 1, count: 12))
  let ciphertext = try XChaCha.seal(Data(text.utf8), aad: aad, key: key, nonce: nonce)
  let value = base.merging(["nonce": b64url(nonce.encoded), "ciphertext": b64url(ciphertext)]) { _, new in new }
  return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}

private func deviceDirectionKey(hello: RelayFlight, welcome: RelayFlight, hostToClient: Bool) throws -> Data {
  let context = try RelayFlightCodec.handshakeContext(hello: hello, welcome: welcome)
  var encodedWelcome = welcome.ephemeralPublicKey!.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  encodedWelcome += String(repeating: "=", count: (4 - encodedWelcome.count % 4) % 4)
  let welcomePublic = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: try #require(Data(base64Encoded: encodedWelcome)))
  func secret(_ peer: Curve25519.KeyAgreement.PublicKey) throws -> Data { try devicePrivate.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) } }
  var material = Data()
  material.append(try secret(hostPrivate.publicKey)); material.append(try secret(welcomePublic))
  material.append(try secret(hostPrivate.publicKey)); material.append(try secret(welcomePublic))
  defer { XChaCha.zeroize(&material) }
  let derived = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: material), salt: context, info: Data("dsh-remote/v3/3dh".utf8), outputByteCount: 64)
  var bytes = derived.withUnsafeBytes { Data($0) }
  defer { XChaCha.zeroize(&bytes) }
  return hostToClient ? Data(bytes.suffix(32)) : Data(bytes.prefix(32))
}

private func encryptedDeviceCiphertext(sequence: Int, plaintext: Data, hello: RelayFlight, welcome: RelayFlight) throws -> Data {
  let nonce = try XChaChaNonce(Data(repeating: 4, count: 12))
  var key = try deviceDirectionKey(hello: hello, welcome: welcome, hostToClient: false)
  defer { XChaCha.zeroize(&key) }
  let frame = RelayFlight(kind: .ciphertext, routeId: identifier, generation: 1, connectionEpoch: 1,
    senderDeviceId: deviceIdentifier, senderEnrollmentId: enrollment, recipientDeviceId: hostIdentifier,
    recipientEnrollmentId: enrollment, ephemeralPublicKey: nil, sequence: sequence, nonce: b64url(nonce.encoded), ciphertext: "")
  var ciphertext = try XChaCha.seal(plaintext, aad: try JSONSerialization.data(withJSONObject: ["ciphertext", identifier, 1, 1, deviceIdentifier, enrollment, hostIdentifier, enrollment, sequence], options: []), key: try XChaChaKey(key), nonce: nonce)
  defer { XChaCha.zeroize(&ciphertext) }
  return try RelayFlightCodec.encodeCiphertext(RelayFlight(kind: .ciphertext, routeId: frame.routeId, generation: frame.generation, connectionEpoch: frame.connectionEpoch,
    senderDeviceId: frame.senderDeviceId, senderEnrollmentId: frame.senderEnrollmentId, recipientDeviceId: frame.recipientDeviceId,
    recipientEnrollmentId: frame.recipientEnrollmentId, ephemeralPublicKey: nil, sequence: sequence, nonce: frame.nonce, ciphertext: b64url(ciphertext)))
}

@Test func strictEightFlightCodecAndHostOrderGate() throws {
  let hello = try RelayFlightCodec.decode(flight("hello"))
  let welcome = try RelayFlightCodec.decode(flight("welcome", sender: hostIdentifier, recipient: deviceIdentifier))
  #expect(try RelayFlightCodec.handshakeContext(hello: hello, welcome: welcome).count > 0)
  let gate = RelayHostHandshakeState()
  try gate.acceptInbound(hello); #expect(gate.state == .mustSendWelcome)
  try gate.markWelcomeSent()
  try gate.acceptInbound(RelayFlightCodec.decode(flight("ready"))); #expect(gate.state == .mustSendFinish)
  try gate.markFinishSent()
  try gate.acceptInbound(RelayFlightCodec.decode(flight("ack"))); #expect(gate.state == .mustSendCommit)
  try gate.markCommitSent(); #expect(gate.state == .awaitingConfirm)
  try gate.acceptInbound(RelayFlightCodec.decode(flight("confirm"))); #expect(gate.state == .mustSendReceipt)
  try gate.markReceiptSent(); #expect(gate.state == .unavailable)
  #expect(throws: RelayOwnerError.invalidCredential) { try RelayFlightCodec.decode(Data("{}".utf8)) }
}

@Test func strictParserRejectsBooleanNumbersNoncanonicalBase64AndOversizedHandshakeCiphertext() throws {
  var booleanEpoch = try JSONSerialization.jsonObject(with: flight("ready")) as! [String: Any]
  booleanEpoch["connectionEpoch"] = true
  #expect(throws: RelayOwnerError.invalidCredential) { try RelayFlightCodec.decode(JSONSerialization.data(withJSONObject: booleanEpoch)) }
  var noncanonical = try JSONSerialization.jsonObject(with: flight("hello")) as! [String: Any]
  let key = noncanonical["ephemeralPublicKey"] as! String
  noncanonical["ephemeralPublicKey"] = String(key.dropLast()) + "J"
  #expect(throws: RelayOwnerError.invalidCredential) { try RelayFlightCodec.decode(JSONSerialization.data(withJSONObject: noncanonical)) }
  var oversized = try JSONSerialization.jsonObject(with: flight("ready")) as! [String: Any]
  oversized["ciphertext"] = b64url(Data(repeating: 1, count: 513))
  #expect(throws: RelayOwnerError.invalidCredential) { try RelayFlightCodec.decode(JSONSerialization.data(withJSONObject: oversized)) }
  var padded = try JSONSerialization.jsonObject(with: flight("ready")) as! [String: Any]
  padded["ciphertext"] = (padded["ciphertext"] as! String) + "="
  #expect(throws: RelayOwnerError.invalidCredential) { try RelayFlightCodec.decode(JSONSerialization.data(withJSONObject: padded)) }
  let substitutedRouteId = String(repeating: "b", count: 16)
  let duplicateRouteId = Data(#"{"version":3,"type":"hello","routeId":"\#(identifier)","routeId":"\#(substitutedRouteId)","generation":1,"connectionEpoch":1,"senderDeviceId":"\#(deviceIdentifier)","senderEnrollmentId":"\#(enrollment)","recipientDeviceId":"\#(hostIdentifier)","recipientEnrollmentId":"\#(enrollment)","ephemeralPublicKey":"\#(deviceAgreement)","nonce":"\#(b64url(Data(repeating: 14, count: 12)))"}"#.utf8)
  #expect(throws: RelayOwnerError.invalidCredential) { try RelayFlightCodec.decode(duplicateRouteId) }
  let escapedDuplicateRouteId = Data(#"{"version":3,"type":"hello","routeId":"\#(identifier)","\u0072outeId":"\#(substitutedRouteId)","generation":1,"connectionEpoch":1,"senderDeviceId":"\#(deviceIdentifier)","senderEnrollmentId":"\#(enrollment)","recipientDeviceId":"\#(hostIdentifier)","recipientEnrollmentId":"\#(enrollment)","ephemeralPublicKey":"\#(deviceAgreement)","nonce":"\#(b64url(Data(repeating: 14, count: 12)))"}"#.utf8)
  #expect(throws: RelayOwnerError.invalidCredential) { try RelayFlightCodec.decode(escapedDuplicateRouteId) }
}

@Test func ciphertextParserRetainsOnlyValidMonotonicSequence() throws {
  let valid = RelayFlight(kind: .ciphertext, routeId: identifier, generation: 1, connectionEpoch: 1,
    senderDeviceId: deviceIdentifier, senderEnrollmentId: enrollment, recipientDeviceId: hostIdentifier,
    recipientEnrollmentId: enrollment, ephemeralPublicKey: nil, sequence: 1,
    nonce: b64url(Data(repeating: 3, count: 12)), ciphertext: b64url(Data(repeating: 4, count: 17)))
  let encoded = try RelayFlightCodec.encodeCiphertext(valid)
  #expect(try RelayFlightCodec.decode(encoded).sequence == 1)
  var malformed = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
  malformed["sequence"] = 0
  #expect(throws: RelayOwnerError.invalidCredential) { try RelayFlightCodec.decode(JSONSerialization.data(withJSONObject: malformed)) }
  malformed.removeValue(forKey: "sequence")
  #expect(throws: RelayOwnerError.invalidCredential) { try RelayFlightCodec.decode(JSONSerialization.data(withJSONObject: malformed)) }
}

@Test func fixedWebSocketRequestHasOnlyDeployedDestinationAndHostSubprotocol() throws {
  let request = try RelayV3WebSocketCodec.request(route())
  #expect(request.url.absoluteString == "https://dshrelay.rulabs.dev/v3/routes/" + identifier + "/connect")
  #expect(request.protocols == ["dsh-remote-v3", "dsh-host." + hostToken])
}

@Test func epochLedgerDurablyRetriesPendingEpochThenAdvancesOnlyAfterCommit() throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  let ledger = RelayConnectionEpochLedger(store: store)

  let first = try ledger.reserveExpectedEpoch(for: credential)
  #expect(first.epoch == 1)
  #expect(store.epochs[credential.routeId]?.lastCommittedEpoch == 0)
  #expect(store.epochs[credential.routeId]?.pendingEpoch == 1)
  #expect(try ledger.reserveExpectedEpoch(for: credential) == first)

  try ledger.finalize(first, connectionEpoch: first.epoch)
  #expect(store.epochs[credential.routeId]?.lastCommittedEpoch == 1)
  #expect(store.epochs[credential.routeId]?.pendingEpoch == nil)
  ledger.release(first)
  let next = try ledger.reserveExpectedEpoch(for: credential)
  defer { ledger.release(next) }
  #expect(next.epoch == 2)
}

@Test func epochLedgerFailsClosedWithoutAnActivePersistedEpochState() throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  let ledger = RelayConnectionEpochLedger(store: store)
  #expect(throws: RelayOwnerError.unavailable) { try ledger.reserveExpectedEpoch(for: credential) }
}

@Test func epochLedgerExcludesASecondHostOwnerUntilTheFirstSocketStops() throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  let firstLedger = RelayConnectionEpochLedger(store: store)
  let secondLedger = RelayConnectionEpochLedger(store: store)
  let first = try firstLedger.reserveExpectedEpoch(for: credential)
  #expect(throws: RelayOwnerError.unavailable) { try secondLedger.reserveExpectedEpoch(for: credential) }
  firstLedger.release(first)
  let retry = try secondLedger.reserveExpectedEpoch(for: credential)
  defer { secondLedger.release(retry) }
  #expect(retry.epoch == 1)
}

@Test func inMemoryEpochCoordinatorReclaimsALeaseWhenItsOwnerDisappears() throws {
  let coordinator = RelayConnectionEpochInMemoryCoordinator(scope: UUID().uuidString)
  let routeId = identifier
  do {
    let lease = try coordinator.acquireLease(routeId: routeId)
    #expect(throws: RelayOwnerError.unavailable) { try coordinator.acquireLease(routeId: routeId) }
    withExtendedLifetime(lease) {}
  }
  let reclaimed = try coordinator.acquireLease(routeId: routeId)
  reclaimed.release()
}

@Test func keychainTransactionExcludesInterleavingSignedHostOwners() async throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  let firstLedger = RelayConnectionEpochLedger(store: store)
  let secondLedger = RelayConnectionEpochLedger(store: store)

  async let first: Bool = { (try? firstLedger.reserveExpectedEpoch(for: credential)) != nil }()
  async let second: Bool = { (try? secondLedger.reserveExpectedEpoch(for: credential)) != nil }()
  let results = await [first, second]

  #expect(results.filter { $0 }.count == 1)
  #expect(store.epochs[credential.routeId]?.pendingEpoch == 1)
}

@Test func pendingEpochLeaseIsReclaimedAfterAnOwnerProcessExits() throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  let pending: RelayConnectionEpochReservation
  do {
    let crashedOwner = RelayConnectionEpochLedger(store: store)
    pending = try crashedOwner.reserveExpectedEpoch(for: credential)
  } // ARC closes the kernel-owned lease, as process exit does.

  let restartedOwner = RelayConnectionEpochLedger(store: store)
  let retry = try restartedOwner.reserveExpectedEpoch(for: credential)
  defer { restartedOwner.release(retry) }
  #expect(retry.epoch == pending.epoch)
}

@Test func durableRevocationTombstoneRejectsNewEpochReservations() throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  try RelayConnectionEpochLedger.beginRevocation(for: credential, store: store)
  #expect(throws: RelayOwnerError.unavailable) { try RelayConnectionEpochLedger(store: store).reserveExpectedEpoch(for: credential) }
}

@Test func durableRevocationFenceRejectsASupervisorAfterHostRestart() async throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  try RelayConnectionEpochLedger.beginRevocation(for: credential, store: store)
  let socket = CoordinatedStartableSocket()
  let coordinator = RelayHostRouteConnectionCoordinator(store: store)
  let supervisor = RelayHostSocketSupervisor(
    credential: credential,
    agreement: TestAgreement(),
    epochLedger: RelayConnectionEpochLedger(store: store),
    connectionCoordinator: coordinator,
    socketFactory: CoordinatedSocketFactory(socket: socket),
    clock: TestClock(),
    random: TestRandom()
  )

  await #expect(throws: RelayOwnerError.unavailable) { try await supervisor.start() }
  #expect(await supervisor.state() == .stopped)
  #expect(!(await socket.started))
}

@Test func revocationBetweenReservationAndSocketStartClosesBeforeHandshake() async throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  let socket = GatedStartableSocket()
  let supervisor = RelayHostSocketSupervisor(
    credential: credential,
    agreement: TestAgreement(),
    epochLedger: RelayConnectionEpochLedger(store: store),
    connectionCoordinator: RelayHostRouteConnectionCoordinator(store: store),
    socketFactory: GatedSocketFactory(socket: socket),
    clock: TestClock(),
    random: TestRandom()
  )
  let starting = Task { try await supervisor.start() }
  await socket.waitForStart()
  try RelayConnectionEpochLedger.beginRevocation(for: credential, store: store)
  await socket.resumeStart()

  await #expect(throws: RelayOwnerError.unavailable) { try await starting.value }
  #expect(await socket.closed)
  #expect(await socket.sends == 0)
}

@Test func offlineTransportCompletesOnlyStrictSixFlightOrderWithoutConnecting() async throws {
  let socket = RecordingSocket(); let clock = TestClock(); let random = TestRandom(); let agreement = TestAgreement()
  let transport = try RelayHostTransport(credential: route(), agreement: agreement, socket: socket, clock: clock, random: random, expectedConnectionEpoch: 1, commitConnectionEpoch: {}, flightTimeoutNanoseconds: 10)
  try await transport.processSimulatedInbound(flight("hello"))
  let first = await socket.snapshot().0
  #expect(first.count == 1)
  #expect(try RelayFlightCodec.decode(first[0]).kind == .welcome)
  #expect(agreement.peers == [deviceAgreement, deviceAgreement])
  let hello = try RelayFlightCodec.decode(flight("hello"))
  try await transport.processSimulatedInbound(try await encryptedDeviceFlight(type: "ready", text: "dsh-remote/v3/ready", hello: hello, welcome: try RelayFlightCodec.decode(first[0])))
  let second = await socket.snapshot().0
  #expect(second.count == 2)
  #expect(try RelayFlightCodec.decode(second[1]).kind == .finish)
  let welcome = try RelayFlightCodec.decode(first[0])
  try await transport.processSimulatedInbound(try await encryptedDeviceFlight(type: "ack", text: "dsh-remote/v3/ack", hello: hello, welcome: welcome))
  let committed = await socket.snapshot().0
  #expect(committed.count == 3)
  #expect(try RelayFlightCodec.decode(committed[2]).kind == .commit)
  try await transport.processSimulatedInbound(try await encryptedDeviceFlight(type: "confirm", text: "dsh-remote/v3/confirm", hello: hello, welcome: welcome))
  #expect(try RelayFlightCodec.decode((await socket.snapshot().0)[3]).kind == .receipt)
  #expect(await transport.currentState() == .established)
  #expect(!(await socket.snapshot().1))
  await transport.stop()
  #expect(!(await transport.hasSecretMaterialForTest()))
}

@Test func hostRendezvousDelayedPhoneCompletesAuthenticatedTranscript() async throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  let socket = CoordinatedStartableSocket(); let clock = ControlledHostClock()
  defer { clock.advance(to: UInt64.max) }
  let supervisor = RelayHostSocketSupervisor(credential: credential, agreement: TestAgreement(), epochLedger: RelayConnectionEpochLedger(store: store), connectionCoordinator: RelayHostRouteConnectionCoordinator(store: store), socketFactory: CoordinatedSocketFactory(socket: socket), clock: clock, random: TestRandom())
  let started = Task { try await supervisor.start() }
  await socket.waitForReceive(count: 1)
  clock.advance(to: 119_000_000_000)
  #expect(await supervisor.state() == .waitingForPhone)
  #expect(store.epochs[credential.routeId]?.lastCommittedEpoch == 0)
  let helloBytes = flight("hello")
  await socket.enqueue(helloBytes)
  await socket.waitForReceive(count: 2)
  let hello = try RelayFlightCodec.decode(helloBytes)
  let welcome = try RelayFlightCodec.decode((await socket.sent)[0])
  // The expired rendezvous timer cannot retire the active cryptographic flight.
  clock.advance(to: 121_000_000_000)
  await socket.enqueue(try await encryptedDeviceFlight(type: "ready", text: "dsh-remote/v3/ready", hello: hello, welcome: welcome))
  await socket.waitForReceive(count: 3)
  await socket.enqueue(try await encryptedDeviceFlight(type: "ack", text: "dsh-remote/v3/ack", hello: hello, welcome: welcome))
  await socket.waitForReceive(count: 4)
  #expect(store.epochs[credential.routeId]?.lastCommittedEpoch == 0)
  await socket.enqueue(try await encryptedDeviceFlight(type: "confirm", text: "dsh-remote/v3/confirm", hello: hello, welcome: welcome))
  try await started.value
  #expect(await supervisor.state() == .established)
  #expect(store.epochs[credential.routeId]?.lastCommittedEpoch == 1)
  #expect(store.epochs[credential.routeId]?.pendingEpoch == nil)
  #expect(try await supervisor.establishedConnectionEpoch() == 1)
  #expect(try (await socket.sent).map { try RelayFlightCodec.decode($0).kind } == [.welcome, .finish, .commit, .receipt])
  await supervisor.stop()
}

@Test func hostRendezvousTimeoutHasDistinctPhaseAndRetainsUncommittedEpoch() async throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  let socket = CoordinatedStartableSocket(); let clock = ControlledHostClock()
  defer { clock.advance(to: UInt64.max) }
  let ledger = RelayConnectionEpochLedger(store: store)
  let supervisor = RelayHostSocketSupervisor(credential: credential, agreement: TestAgreement(), epochLedger: ledger, connectionCoordinator: RelayHostRouteConnectionCoordinator(store: store), socketFactory: CoordinatedSocketFactory(socket: socket), clock: clock, random: TestRandom())
  let started = Task { try await supervisor.start() }
  await socket.waitForReceive(count: 1)
  clock.advance(to: 120_000_000_000)
  await #expect(throws: RelayHostConnectionTimeout(phase: .waitingForPhone)) { try await started.value }
  #expect(await socket.closed)
  #expect((await socket.sent).isEmpty)
  #expect(store.epochs[credential.routeId]?.lastCommittedEpoch == 0)
  #expect(store.epochs[credential.routeId]?.pendingEpoch == 1)
  let retry = try ledger.reserveExpectedEpoch(for: credential)
  #expect(retry.epoch == 1)
  ledger.release(retry)
}

@Test func hostRendezvousPreservesEveryPostHelloTenSecondDeadline() async throws {
  for (inboundCount, phase) in [(2, RelayHostConnectionTimeout.Phase.ready), (3, .ack), (4, .confirm)] {
    let credential = try route(); let store = MemoryStore(); store.active = credential
    store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
    let socket = CoordinatedStartableSocket(); let clock = ControlledHostClock()
    defer { clock.advance(to: UInt64.max) }
    let supervisor = RelayHostSocketSupervisor(credential: credential, agreement: TestAgreement(), epochLedger: RelayConnectionEpochLedger(store: store), connectionCoordinator: RelayHostRouteConnectionCoordinator(store: store), socketFactory: CoordinatedSocketFactory(socket: socket), clock: clock, random: TestRandom())
    let started = Task { try await supervisor.start() }
    await socket.waitForReceive(count: 1)
    clock.advance(to: 119_000_000_000)
    let helloBytes = flight("hello")
    await socket.enqueue(helloBytes)
    await socket.waitForReceive(count: 2)
    let hello = try RelayFlightCodec.decode(helloBytes)
    let welcome = try RelayFlightCodec.decode((await socket.sent)[0])
    if inboundCount >= 3 {
      await socket.enqueue(try await encryptedDeviceFlight(type: "ready", text: "dsh-remote/v3/ready", hello: hello, welcome: welcome))
      await socket.waitForReceive(count: 3)
    }
    if inboundCount == 4 {
      await socket.enqueue(try await encryptedDeviceFlight(type: "ack", text: "dsh-remote/v3/ack", hello: hello, welcome: welcome))
      await socket.waitForReceive(count: 4)
    }
    clock.advance(to: 129_000_000_000)
    await #expect(throws: RelayHostConnectionTimeout(phase: phase)) { try await started.value }
    #expect(await socket.closed)
    #expect(store.epochs[credential.routeId]?.lastCommittedEpoch == 0)
  }
}

@Test func hostRendezvousRejectsMalformedAndRevokedFirstFrames() async throws {
  for revoked in [false, true] {
    let credential = try route(); let store = MemoryStore(); store.active = credential
    store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
    let socket = CoordinatedStartableSocket(); let clock = ControlledHostClock()
    defer { clock.advance(to: UInt64.max) }
    let supervisor = RelayHostSocketSupervisor(credential: credential, agreement: TestAgreement(), epochLedger: RelayConnectionEpochLedger(store: store), connectionCoordinator: RelayHostRouteConnectionCoordinator(store: store), socketFactory: CoordinatedSocketFactory(socket: socket), clock: clock, random: TestRandom())
    let started = Task { try await supervisor.start() }
    await socket.waitForReceive(count: 1)
    if revoked { try RelayConnectionEpochLedger.beginRevocation(for: credential, store: store) }
    await socket.enqueue(revoked ? flight("hello") : Data("{}".utf8))
    await #expect(throws: (any Error).self) { try await started.value }
    #expect((await socket.sent).isEmpty)
    #expect(await socket.closed)
    #expect(store.epochs[credential.routeId]?.lastCommittedEpoch == 0)
  }
}

@Test func hostRendezvousStopFencesLateReadAndReleasesExclusiveOwner() async throws {
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  let socket = CoordinatedStartableSocket(); let clock = ControlledHostClock()
  defer { clock.advance(to: UInt64.max) }
  await socket.keepPendingReadAfterClose()
  let coordinator = RelayHostRouteConnectionCoordinator(store: store)
  let supervisor = RelayHostSocketSupervisor(credential: credential, agreement: TestAgreement(), epochLedger: RelayConnectionEpochLedger(store: store), connectionCoordinator: coordinator, socketFactory: CoordinatedSocketFactory(socket: socket), clock: clock, random: TestRandom())
  let started = Task { try await supervisor.start() }
  await socket.waitForReceive(count: 1)
  let replacementSocket = CoordinatedStartableSocket()
  let replacement = RelayHostSocketSupervisor(credential: credential, agreement: TestAgreement(), epochLedger: RelayConnectionEpochLedger(store: store), connectionCoordinator: coordinator, socketFactory: CoordinatedSocketFactory(socket: replacementSocket), clock: clock, random: TestRandom())
  await #expect(throws: (any Error).self) { try await replacement.start() }
  #expect(!(await replacementSocket.started))
  await supervisor.stop()
  await #expect(throws: (any Error).self) { try await started.value }
  await socket.enqueue(flight("hello"))
  #expect(await supervisor.state() == .stopped)
  #expect((await socket.sent).isEmpty)
  let ledger = RelayConnectionEpochLedger(store: store)
  let retry = try ledger.reserveExpectedEpoch(for: credential)
  #expect(retry.epoch == 1)
  ledger.release(retry)
}

@Test func hostRendezvousCancellationBeforeContinuationInstallationSettles() async throws {
  let race = RelayDeadlineRace<Data>()
  race.fail(RelayOwnerError.unavailable)
  await #expect(throws: RelayOwnerError.unavailable) {
    let _: Data = try await withCheckedThrowingContinuation { continuation in
      #expect(!race.install(continuation))
    }
  }
}

@Test func handshakePinsHelloEpochAndRejectsLaterEpochSubstitution() async throws {
  let socket = RecordingSocket(); let transport = try RelayHostTransport(credential: route(), agreement: TestAgreement(), socket: socket, clock: TestClock(), random: TestRandom(), expectedConnectionEpoch: 1, commitConnectionEpoch: {})
  try await transport.processSimulatedInbound(flight("hello"))
  var substituted = try JSONSerialization.jsonObject(with: flight("ready")) as! [String: Any]
  substituted["connectionEpoch"] = 2
  let bytes = try JSONSerialization.data(withJSONObject: substituted)
  await #expect(throws: RelayOwnerError.invalidCredential) { try await transport.processSimulatedInbound(bytes) }
  #expect(await transport.currentState() == .stopped)
}

@Test func handshakeRejectsHelloThatDoesNotMatchTheReservedEpoch() async throws {
  let socket = RecordingSocket()
  let transport = try RelayHostTransport(credential: route(), agreement: TestAgreement(), socket: socket, clock: TestClock(), random: TestRandom(), expectedConnectionEpoch: 2, commitConnectionEpoch: {})
  await #expect(throws: RelayOwnerError.invalidCredential) { try await transport.processSimulatedInbound(flight("hello")) }
  #expect((await socket.snapshot().0).isEmpty)
  #expect(await socket.snapshot().1)
}

@Test func offlineTransportFailsClosedOnDeadlineAndClosesFakeSocket() async throws {
  let socket = RecordingSocket(); let clock = TestClock()
  let transport = try RelayHostTransport(credential: route(), agreement: TestAgreement(), socket: socket, clock: clock, random: TestRandom(), expectedConnectionEpoch: 1, commitConnectionEpoch: {}, flightTimeoutNanoseconds: 1)
  clock.value = 102
  await #expect(throws: RelayOwnerError.deadlineExceeded) { try await transport.processSimulatedInbound(flight("hello")) }
  #expect(await transport.currentState() == .stopped)
  #expect(await socket.snapshot().1)
}

@Test func inboundWaitRacesItsInjectedDeadlineAndTearsDown() async throws {
  let socket = BlockingSocket()
  let transport = try RelayHostTransport(credential: route(), agreement: TestAgreement(), socket: socket, clock: ImmediateDeadlineClock(), random: TestRandom(), expectedConnectionEpoch: 1, commitConnectionEpoch: {})
  await #expect(throws: RelayOwnerError.deadlineExceeded) { try await transport.processOneInbound() }
  #expect(await transport.currentState() == .stopped)
  #expect(await socket.closed)
}

@Test func timeoutFencePreventsDelayedSocketFromLateEmittingWelcome() async throws {
  let socket = DelayedFenceSocket()
  let transport = try RelayHostTransport(credential: route(), agreement: TestAgreement(), socket: socket, clock: ImmediateDeadlineClock(), random: TestRandom(), expectedConnectionEpoch: 1, commitConnectionEpoch: {})
  await #expect(throws: RelayOwnerError.deadlineExceeded) { try await transport.processSimulatedInbound(flight("hello")) }
  try? await Task.sleep(nanoseconds: 40_000_000)
  #expect((await socket.sent).isEmpty)
  #expect(await socket.closed)
}

private func assertReceiveExpiryFencesPriorWrite(_ mode: RendezvousDeadlineClock.Mode) async throws {
  let socket = ControlledFenceSocket(); let clock = RendezvousDeadlineClock(mode)
  let transport = try RelayHostTransport(credential: route(), agreement: TestAgreement(), socket: socket, clock: clock, random: TestRandom(), expectedConnectionEpoch: 1, commitConnectionEpoch: {})
  let outbound = Task { try await transport.processSimulatedInbound(flight("hello")) }
  await socket.waitForSendStart(); await clock.waitForFirstSleep()
  await #expect(throws: RelayOwnerError.deadlineExceeded) { try await transport.processOneInbound() }
  await socket.waitForClose(); clock.releaseFirstSleep(); await socket.release(); _ = await outbound.result
  #expect((await socket.sent).isEmpty)
  #expect(!(await socket.closedWhileFenceOpen))
}

@Test func receiveTimerExpiryInvalidatesFenceForAlreadySuspendedOutboundWrite() async throws {
  try await assertReceiveExpiryFencesPriorWrite(.expiry)
}

@Test func receiveClockThrowInvalidatesFenceForAlreadySuspendedOutboundWrite() async throws {
  try await assertReceiveExpiryFencesPriorWrite(.thrown)
}

@Test func offlineTransportRejectsUnauthenticatedAckAndClosesFakeSocket() async throws {
  let socket = RecordingSocket(); let transport = try RelayHostTransport(credential: route(), agreement: TestAgreement(), socket: socket, clock: TestClock(), random: TestRandom(), expectedConnectionEpoch: 1, commitConnectionEpoch: {})
  try await transport.processSimulatedInbound(flight("hello"))
  let hello = try RelayFlightCodec.decode(flight("hello")); let welcome = try RelayFlightCodec.decode((await socket.snapshot().0)[0])
  try await transport.processSimulatedInbound(try await encryptedDeviceFlight(type: "ready", text: "dsh-remote/v3/ready", hello: hello, welcome: welcome))
  await #expect(throws: XChaChaError.failed) { try await transport.processSimulatedInbound(flight("ack")) }
  #expect(await transport.currentState() == .stopped)
  #expect(await socket.snapshot().1)
}

@Test func unstartedURLSessionFactoryPinsWssRequestAndNeverResumes() throws {
  let task = try RelayUnstartedURLSessionTaskFactory.make(credential: route())
  #expect(task.state == .suspended)
  #expect(task.maximumMessageSize == RelayURLSessionHostSocket.maximumMessageBytes)
  #expect(task.originalRequest?.url?.absoluteString == "wss://dshrelay.rulabs.dev/v3/routes/" + identifier + "/connect")
  #expect(task.originalRequest?.value(forHTTPHeaderField: "Sec-WebSocket-Protocol") == "dsh-remote-v3, dsh-host." + hostToken)
  task.cancel()
}

@Test func host3DHMatchesCheckedInNobleV3Fixture() throws {
  let url = try #require(Bundle.module.url(forResource: "v3-3dh-noble", withExtension: "json"))
  let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
  let hello = fixture["hello"] as! [String: Any], welcome = fixture["welcome"] as! [String: Any]
  func data(_ value: String) -> Data { Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4))! }
  let device = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 3, count: 32))
  let host = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
  let ephemeral = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 1, count: 32))
  func shared(_ lhs: Curve25519.KeyAgreement.PrivateKey, _ rhs: Curve25519.KeyAgreement.PublicKey) throws -> Data { try lhs.sharedSecretFromKeyAgreement(with: rhs).withUnsafeBytes { Data($0) } }
  var material = Data(); material.append(try shared(host, device.publicKey)); material.append(try shared(ephemeral, device.publicKey)); material.append(try shared(host, try Curve25519.KeyAgreement.PublicKey(rawRepresentation: data(hello["ephemeralPublicKey"] as! String)))); material.append(try shared(ephemeral, try Curve25519.KeyAgreement.PublicKey(rawRepresentation: data(hello["ephemeralPublicKey"] as! String))))
  let context = data(fixture["context"] as! String)
  let output = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: material), salt: context, info: Data("dsh-remote/v3/3dh".utf8), outputByteCount: 64)
  let derived = output.withUnsafeBytes { Data($0) }
  #expect(b64url(Data(derived.prefix(32))) == fixture["clientToHost"] as! String)
  #expect(b64url(Data(derived.suffix(32))) == fixture["hostToClient"] as! String)
  #expect((welcome["ephemeralPublicKey"] as! String) == b64url(ephemeral.publicKey.rawRepresentation))
}

@Test func actualHostHandshakeMatchesFullNobleTranscriptByteForByte() async throws {
  let url = try #require(Bundle.module.url(forResource: "v3-3dh-noble", withExtension: "json"))
  let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
  func wire(_ field: String) throws -> Data { try JSONSerialization.data(withJSONObject: try #require(fixture[field]), options: [.sortedKeys]) }
  let socket = RecordingSocket()
  let transport = try RelayHostTransport(credential: route(), agreement: TestAgreement(), socket: socket, clock: TestClock(), random: TestRandom(), expectedConnectionEpoch: 1, commitConnectionEpoch: {})
  try await transport.processSimulatedInbound(wire("hello"))
  var sent = await socket.snapshot().0
  #expect(try RelayFlightCodec.decode(sent[0]) == RelayFlightCodec.decode(wire("welcome")))
  try await transport.processSimulatedInbound(wire("ready"))
  sent = await socket.snapshot().0
  #expect(try RelayFlightCodec.decode(sent[1]) == RelayFlightCodec.decode(wire("finish")))
  try await transport.processSimulatedInbound(wire("ack"))
  sent = await socket.snapshot().0
  #expect(try RelayFlightCodec.decode(sent[2]) == RelayFlightCodec.decode(wire("commit")))
  #expect(await transport.currentState() == .awaitingConfirm)
}

@Test func postCommitCiphertextFramesAuthenticateSequenceAndStopOnReplay() async throws {
  let socket = QueueSocket()
  let transport = try RelayHostTransport(credential: route(), agreement: TestAgreement(), socket: socket, clock: TestClock(), random: TestRandom(), expectedConnectionEpoch: 1, commitConnectionEpoch: {})
  let helloBytes = flight("hello")
  try await transport.processSimulatedInbound(helloBytes)
  let hello = try RelayFlightCodec.decode(helloBytes)
  let welcome = try RelayFlightCodec.decode((await socket.sent)[0])
  try await transport.processSimulatedInbound(try await encryptedDeviceFlight(type: "ready", text: "dsh-remote/v3/ready", hello: hello, welcome: welcome))
  try await transport.processSimulatedInbound(try await encryptedDeviceFlight(type: "ack", text: "dsh-remote/v3/ack", hello: hello, welcome: welcome))
  try await transport.processSimulatedInbound(try await encryptedDeviceFlight(type: "confirm", text: "dsh-remote/v3/confirm", hello: hello, welcome: welcome))
  try await transport.sendCiphertext(Data("host payload".utf8))
  let outbound = try RelayFlightCodec.decode((await socket.sent)[4])
  #expect(outbound.kind == .ciphertext)
  #expect(outbound.sequence == 1)
  var hostKey = try deviceDirectionKey(hello: hello, welcome: welcome, hostToClient: true)
  defer { XChaCha.zeroize(&hostKey) }
  let nonce = try XChaChaNonce(try b64urlData(try #require(outbound.nonce)))
  let ciphertext = try b64urlData(try #require(outbound.ciphertext))
  #expect(try XChaCha.open(ciphertext, aad: try JSONSerialization.data(withJSONObject: ["ciphertext", identifier, 1, 1, hostIdentifier, enrollment, deviceIdentifier, enrollment, 1], options: []), key: try XChaChaKey(hostKey), nonce: nonce) == Data("host payload".utf8))
  let incoming = try encryptedDeviceCiphertext(sequence: 1, plaintext: Data("device payload".utf8), hello: hello, welcome: welcome)
  await socket.enqueue(incoming)
  #expect(try await transport.receiveCiphertext() == Data("device payload".utf8))
  await socket.enqueue(incoming)
  await #expect(throws: RelayOwnerError.invalidCredential) { try await transport.receiveCiphertext() }
  #expect(await transport.currentState() == .stopped)
  #expect(await socket.closed)
}

@Test func postCommitTransportFencesRevocationAfterApplicationIO() async throws {
  let inboundSocket = QueueSocket(); let inboundGate = AdmissionCounter(allowedChecks: 5)
  let (inboundTransport, hello, welcome) = try await establishedTransport(socket: inboundSocket, admission: inboundGate)
  await inboundSocket.enqueue(try encryptedDeviceCiphertext(sequence: 1, plaintext: Data("device payload".utf8), hello: hello, welcome: welcome))
  await #expect(throws: RelayOwnerError.unavailable) { _ = try await inboundTransport.receiveCiphertext() }
  #expect(await inboundTransport.currentState() == .stopped)
  #expect(await inboundSocket.closed)

  let outboundSocket = QueueSocket(); let outboundGate = AdmissionCounter(allowedChecks: 5)
  let (outboundTransport, _, _) = try await establishedTransport(socket: outboundSocket, admission: outboundGate)
  await #expect(throws: RelayOwnerError.unavailable) { try await outboundTransport.sendCiphertext(Data("host payload".utf8)) }
  #expect(await outboundTransport.currentState() == .stopped)
  #expect(await outboundSocket.closed)
}

@Test func supervisorClearsEstablishedStateWhenPostCommitSendFails() async throws {
  let socket = CoordinatedStartableSocket()
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  let coordinator = RelayHostRouteConnectionCoordinator(store: store)
  let supervisor = RelayHostSocketSupervisor(credential: credential, agreement: TestAgreement(), epochLedger: RelayConnectionEpochLedger(store: store), connectionCoordinator: coordinator, socketFactory: CoordinatedSocketFactory(socket: socket), clock: TestClock(), random: TestRandom())
  let helloBytes = flight("hello")
  await socket.enqueue(helloBytes)
  let started = Task { try await supervisor.start() }
  await socket.waitForSent(count: 1)
  let hello = try RelayFlightCodec.decode(helloBytes)
  let welcome = try RelayFlightCodec.decode((await socket.sent)[0])
  await socket.enqueue(try await encryptedDeviceFlight(type: "ready", text: "dsh-remote/v3/ready", hello: hello, welcome: welcome))
  await socket.waitForSent(count: 2)
  await socket.enqueue(try await encryptedDeviceFlight(type: "ack", text: "dsh-remote/v3/ack", hello: hello, welcome: welcome))
  await socket.waitForSent(count: 3)
  await socket.enqueue(try await encryptedDeviceFlight(type: "confirm", text: "dsh-remote/v3/confirm", hello: hello, welcome: welcome))
  try await started.value
  #expect(await supervisor.state() == .established)
  #expect(store.epochs[credential.routeId]?.lastCommittedEpoch == 1)
  #expect(store.epochs[credential.routeId]?.pendingEpoch == nil)
  await socket.setRejectWrites()
  await #expect(throws: RelayOwnerError.unavailable) { try await supervisor.sendCiphertext(Data("fails".utf8)) }
  #expect(await supervisor.state() == .stopped)
  #expect(await socket.closed)
}

@Test func supervisorClearsEstablishedStateWhenPostCommitReceiveFails() async throws {
  let socket = CoordinatedStartableSocket()
  let credential = try route(); let store = MemoryStore(); store.active = credential
  store.epochs[credential.routeId] = try RelayConnectionEpochState.initial(routeId: credential.routeId)
  let coordinator = RelayHostRouteConnectionCoordinator(store: store)
  let supervisor = RelayHostSocketSupervisor(credential: credential, agreement: TestAgreement(), epochLedger: RelayConnectionEpochLedger(store: store), connectionCoordinator: coordinator, socketFactory: CoordinatedSocketFactory(socket: socket), clock: TestClock(), random: TestRandom())
  let helloBytes = flight("hello")
  await socket.enqueue(helloBytes)
  let started = Task { try await supervisor.start() }
  await socket.waitForSent(count: 1)
  let hello = try RelayFlightCodec.decode(helloBytes)
  let welcome = try RelayFlightCodec.decode((await socket.sent)[0])
  await socket.enqueue(try await encryptedDeviceFlight(type: "ready", text: "dsh-remote/v3/ready", hello: hello, welcome: welcome))
  await socket.waitForSent(count: 2)
  await socket.enqueue(try await encryptedDeviceFlight(type: "ack", text: "dsh-remote/v3/ack", hello: hello, welcome: welcome))
  await socket.waitForSent(count: 3)
  await socket.enqueue(try await encryptedDeviceFlight(type: "confirm", text: "dsh-remote/v3/confirm", hello: hello, welcome: welcome))
  try await started.value
  #expect(store.epochs[credential.routeId]?.lastCommittedEpoch == 1)
  #expect(store.epochs[credential.routeId]?.pendingEpoch == nil)
  await socket.enqueue(Data("not-a-v3-frame".utf8))
  await #expect(throws: RelayOwnerError.invalidCredential) { _ = try await supervisor.receiveCiphertext() }
  #expect(await supervisor.state() == .stopped)
  #expect(await socket.closed)
}
