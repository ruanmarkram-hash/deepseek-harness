import CryptoKit
import Foundation
@_spi(DSHTesting) import RemoteHostXChaCha

/// Deliberately small injected socket boundary. A production adapter is not supplied
/// in this target, so constructing this transport cannot open or resume a connection.
public actor RelayHostSendFence {
  private var open = true
  public init() {}
  public func invalidate() { open = false }
  public func isOpen() -> Bool { open }
}

public protocol RelayHostSocket: Sendable {
  /// Must sample `fence.isOpen()` immediately before committing bytes. Returning
  /// false means no write committed. Implementations may not emit after a fence closes.
  func send(_ data: Data, fence: RelayHostSendFence) async throws -> Bool
  func receive() async throws -> Data
  func close() async
}

/// Does not wait for a losing task. The deadline arm closes the socket first,
/// so a non-cooperative adapter cannot keep the Host actor blocked past expiry.
final class RelayDeadlineRace<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock(); private var continuation: CheckedContinuation<Value, Error>?; private var settled = false
  private var earlyResult: Result<Value, Error>?
  @discardableResult func install(_ continuation: CheckedContinuation<Value, Error>) -> Bool {
    lock.lock()
    if let earlyResult { self.earlyResult = nil; lock.unlock(); continuation.resume(with: earlyResult); return false }
    self.continuation = continuation
    lock.unlock()
    return true
  }
  func succeed(_ value: Value) { settle(.success(value)) }
  func fail(_ error: Error) { settle(.failure(error)) }
  func claimTimeout() -> CheckedContinuation<Value, Error>? {
    lock.lock(); defer { lock.unlock() }
    guard !settled, let continuation else { return nil }
    settled = true; self.continuation = nil
    return continuation
  }
  private func settle(_ result: Result<Value, Error>) {
    lock.lock(); defer { lock.unlock() }; guard !settled else { return }; settled = true
    if let continuation { self.continuation = nil; continuation.resume(with: result) }
    else { earlyResult = result }
  }
}

/** One bounded read shared by pre-handshake rendezvous and cryptographic flights. */
func receiveRelayFrameBeforeDeadline(socket: RelayHostSocket, clock: RelayTransportClock, expiry: UInt64, fence: RelayHostSendFence, race: RelayDeadlineRace<Data> = RelayDeadlineRace()) async throws -> Data {
  try await withCheckedThrowingContinuation { continuation in
    guard race.install(continuation) else { return }
    Task { do { race.succeed(try await socket.receive()) } catch { race.fail(error) } }
    Task { do { try await clock.sleep(untilNanoseconds: expiry); if let continuation = race.claimTimeout() { await fence.invalidate(); Task { await socket.close() }; continuation.resume(throwing: RelayOwnerError.deadlineExceeded) } } catch {
      if let continuation = race.claimTimeout() { await fence.invalidate(); Task { await socket.close() }; continuation.resume(throwing: error) }
    } }
  }
}

public protocol RelayTransportClock: Sendable {
  func nowNanoseconds() -> UInt64
  func sleep(untilNanoseconds: UInt64) async throws
}

public extension RelayTransportClock {
  func sleep(untilNanoseconds: UInt64) async throws {
    let now = nowNanoseconds()
    guard now < untilNanoseconds else { throw RelayOwnerError.deadlineExceeded }
    try await Task.sleep(nanoseconds: untilNanoseconds - now)
  }
}
public protocol RelayTransportRandom: Sendable { func bytes(count: Int) throws -> Data }

public struct RelaySystemClock: RelayTransportClock {
  public init() {}
  public func nowNanoseconds() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
  public func sleep(untilNanoseconds: UInt64) async throws {
    let now = nowNanoseconds()
    guard now < untilNanoseconds else { throw RelayOwnerError.deadlineExceeded }
    try await Task.sleep(nanoseconds: untilNanoseconds - now)
  }
}

public struct RelaySystemRandom: RelayTransportRandom {
  public init() {}
  public func bytes(count: Int) throws -> Data {
    guard count > 0 && count <= 64 * 1024 else { throw RelayOwnerError.invalidCredential }
    var result = Data(count: count)
    let status = result.withUnsafeMutableBytes { bytes -> Int32 in
      guard let base = bytes.baseAddress else { return -1 }
      return SecRandomCopyBytes(kSecRandomDefault, count, base)
    }
    guard status == errSecSuccess else { throw RelayOwnerError.unavailable }
    return result
  }
}

public enum RelayHostTransportState: Equatable, Sendable { case awaitingHello, awaitingReady, awaitingAck, awaitingConfirm, established, stopped }

/// Fixed V3 Host cryptographic transport. Its caller supplies an already-owned socket;
/// this type has no `start`, URLSession construction, provisioning, pairing, FD runtime,
/// or key-store access.
public actor RelayHostTransport {
  private static let maximumCiphertextBytes = 9 * 1024 * 1024
  private static let maximumSequence = 2_147_483_647
  private let credential: RelayRouteCredential
  private let agreement: RelayProtectedAgreement
  private let socket: RelayHostSocket
  private let clock: RelayTransportClock
  private let random: RelayTransportRandom
  private let flightTimeoutNanoseconds: UInt64
  private let expectedConnectionEpoch: Int
  private let reconciliationEpoch: Int?
  private let finalizeConnectionEpoch: @Sendable (Int) throws -> Void
  /// Native Host admission fence. It is checked around every handshake read
  /// and write so a durable revoke from another signed Host stops this socket.
  private let ensureConnectionAdmitted: @Sendable () throws -> Void
  private let gate = RelayHostHandshakeState()
  private var state: RelayHostTransportState = .awaitingHello
  private var deadline: UInt64
  private var hello: RelayFlight?
  private var welcome: RelayFlight?
  private var acceptedEpoch: Int?
  private var writeFence = RelayHostSendFence()
  private var clientToHostKey: Data?
  private var sealer: XChaChaFrameSealer?
  private var nextInboundSequence = 1
  private var nextOutboundSequence = 1

  public init(credential: RelayRouteCredential, agreement: RelayProtectedAgreement, socket: RelayHostSocket, clock: RelayTransportClock, random: RelayTransportRandom, expectedConnectionEpoch: Int, reconciliationEpoch: Int? = nil, finalizeConnectionEpoch: @escaping @Sendable (Int) throws -> Void, ensureConnectionAdmitted: @escaping @Sendable () throws -> Void = {}, flightTimeoutNanoseconds: UInt64 = 10_000_000_000) throws {
    guard flightTimeoutNanoseconds > 0, expectedConnectionEpoch >= 1, expectedConnectionEpoch <= Self.maximumSequence,
          reconciliationEpoch.map({ $0 >= 1 && $0 < expectedConnectionEpoch }) ?? true
    else { throw RelayOwnerError.invalidCredential }
    self.credential = credential; self.agreement = agreement; self.socket = socket
    self.clock = clock; self.random = random; self.flightTimeoutNanoseconds = flightTimeoutNanoseconds
    self.expectedConnectionEpoch = expectedConnectionEpoch
    self.reconciliationEpoch = reconciliationEpoch
    self.finalizeConnectionEpoch = finalizeConnectionEpoch
    self.ensureConnectionAdmitted = ensureConnectionAdmitted
    let now = clock.nowNanoseconds()
    guard now <= UInt64.max - flightTimeoutNanoseconds else { throw RelayOwnerError.invalidCredential }
    deadline = now + flightTimeoutNanoseconds
  }

  /** The authenticated epoch after the four-flight handshake completes. */
  public func establishedConnectionEpoch() -> Int? {
    state == .established ? acceptedEpoch : nil
  }

  /** Test-only compatibility seam for crypto transcript fixtures without durable storage. */
  init(credential: RelayRouteCredential, agreement: RelayProtectedAgreement, socket: RelayHostSocket, clock: RelayTransportClock, random: RelayTransportRandom, expectedConnectionEpoch: Int, commitConnectionEpoch: @escaping @Sendable () throws -> Void, flightTimeoutNanoseconds: UInt64 = 10_000_000_000) throws {
    try self.init(credential: credential, agreement: agreement, socket: socket, clock: clock, random: random, expectedConnectionEpoch: expectedConnectionEpoch, finalizeConnectionEpoch: { _ in try commitConnectionEpoch() }, flightTimeoutNanoseconds: flightTimeoutNanoseconds)
  }

  public func currentState() -> RelayHostTransportState { state }
  func hasSecretMaterialForTest() async -> Bool {
    guard let sealer else { return clientToHostKey != nil }
    let sealerAlive = !(await sealer.destroyedForVerification())
    return clientToHostKey != nil || sealerAlive
  }

  /// Processes exactly one inbound flight from an injected fake/test socket.
  /// Any error closes the injected socket and zeroizes currently addressable session bytes.
  public func processOneInbound() async throws {
    do {
      try ensureConnectionAdmitted()
      try checkDeadline()
      let input = try await receiveBeforeDeadline()
      try ensureConnectionAdmitted()
      try checkDeadline()
      try await process(input)
    } catch {
      await stop()
      throw error
    }
  }

  /** Validates the exact first frame retained by the owned socket's rendezvous. */
  public func processInitialInbound(_ input: Data) async throws {
    do {
      guard state == .awaitingHello else { throw RelayOwnerError.invalidState }
      try ensureConnectionAdmitted()
      try checkDeadline()
      try await process(input)
    } catch {
      await stop()
      throw error
    }
  }

  /// Receives and authenticates exactly one post-commit application frame.
  /// An invalid, replayed, or misrouted frame stops the transport before returning.
  public func receiveCiphertext() async throws -> Data {
    guard state == .established else { throw RelayOwnerError.invalidState }
    do {
      let input = try await socket.receive()
      try ensureConnectionAdmitted()
      let flight = try RelayFlightCodec.decode(input)
      try validateRoute(flight)
      guard flight.kind == .ciphertext, flight.sequence == nextInboundSequence,
            var key = clientToHostKey,
            let nonceText = flight.nonce, let ciphertextText = flight.ciphertext,
            let nonce = base64urlDecode(nonceText), let ciphertext = base64urlDecode(ciphertextText),
            ciphertext.count >= 17 && ciphertext.count <= Self.maximumCiphertextBytes
      else { throw RelayOwnerError.invalidCredential }
      defer { XChaCha.zeroize(&key) }
      var plaintext = try XChaCha.open(ciphertext, aad: associatedData(type: "ciphertext", flight: flight), key: try XChaChaKey(key), nonce: try XChaChaNonce(nonce))
      guard plaintext.count <= Self.maximumCiphertextBytes - 16 else {
        XChaCha.zeroize(&plaintext)
        throw RelayOwnerError.invalidCredential
      }
      guard nextInboundSequence < Self.maximumSequence else {
        XChaCha.zeroize(&plaintext)
        throw RelayOwnerError.invalidState
      }
      do { try ensureConnectionAdmitted() }
      catch { XChaCha.zeroize(&plaintext); throw error }
      nextInboundSequence += 1
      return plaintext
    } catch {
      await stop()
      throw error
    }
  }

  /// Encrypts and writes exactly one post-commit application frame. The caller owns
  /// the returned plaintext buffer lifetime on receive; transport-owned key material
  /// is zeroized when `stop` is called or any operation fails.
  public func sendCiphertext(_ plaintext: Data) async throws {
    guard state == .established, plaintext.count <= Self.maximumCiphertextBytes - 16,
          nextOutboundSequence <= Self.maximumSequence,
          let sealer
    else { throw RelayOwnerError.invalidState }
    do {
      let frame = ciphertextFrame(sequence: nextOutboundSequence, nonce: "", ciphertext: "")
      let sealed = try await sealer.seal(plaintext, aad: associatedData(type: "ciphertext", flight: frame))
      var ciphertext = sealed.ciphertext
      defer { XChaCha.zeroize(&ciphertext) }
      guard ciphertext.count <= Self.maximumCiphertextBytes else { throw RelayOwnerError.invalidCredential }
      let encoded = try RelayFlightCodec.encodeCiphertext(ciphertextFrame(sequence: nextOutboundSequence, nonce: base64url(sealed.nonce.encoded), ciphertext: base64url(ciphertext)))
      try await sendEstablished(encoded)
      guard nextOutboundSequence < Self.maximumSequence else { throw RelayOwnerError.invalidState }
      nextOutboundSequence += 1
    } catch {
      await stop()
      throw error
    }
  }

  /// Test seam for deterministic hostile-input coverage. It is not a public wire listener.
  public func processSimulatedInbound(_ input: Data) async throws {
    do { try checkDeadline(); try await process(input) }
    catch { await stop(); throw error }
  }

  public func stop() async {
    guard state != .stopped else { return }
    state = .stopped; gate.stop(); hello = nil; welcome = nil; acceptedEpoch = nil
    nextInboundSequence = 0; nextOutboundSequence = 0
    await writeFence.invalidate()
    if let sealer { await sealer.destroy(); self.sealer = nil }
    XChaCha.zeroize(&clientToHostKey); clientToHostKey = nil
    await socket.close()
  }

  private func process(_ input: Data) async throws {
    let flight = try RelayFlightCodec.decode(input)
    try validateRoute(flight)
    try gate.acceptInbound(flight)
    switch (state, flight.kind) {
    case (.awaitingHello, .hello): try await receiveHello(flight)
    case (.awaitingReady, .ready): try await receiveReady(flight)
    case (.awaitingAck, .ack): try await receiveAck(flight)
    case (.awaitingConfirm, .confirm): try await receiveConfirm(flight)
    default: throw RelayOwnerError.invalidState
    }
  }

  private func receiveBeforeDeadline() async throws -> Data {
    try await receiveRelayFrameBeforeDeadline(socket: socket, clock: clock, expiry: deadline, fence: writeFence)
  }

  private func receiveHello(_ inbound: RelayFlight) async throws {
    guard inbound.connectionEpoch == expectedConnectionEpoch || inbound.connectionEpoch == reconciliationEpoch,
          let peerText = inbound.ephemeralPublicKey, let peer = base64urlDecode(peerText), peer.count == 32
    else { throw RelayOwnerError.invalidCredential }
    // This native-only call is the sole static-key agreement seam. Its private key never
    // crosses the actor boundary. The future enrolled-device static key is required before
    // this can become the deployed three-DH session derivation.
    var privateBytes = try random.bytes(count: 32)
    defer { XChaCha.zeroize(&privateBytes) }
    let ephemeral = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateBytes)
    var nonceBytes = try random.bytes(count: 12)
    defer { XChaCha.zeroize(&nonceBytes) }
    acceptedEpoch = inbound.connectionEpoch
    let outbound = RelayFlight(kind: .welcome, routeId: credential.routeId, generation: credential.generation, connectionEpoch: inbound.connectionEpoch,
      senderDeviceId: credential.hostDeviceId, senderEnrollmentId: credential.hostEnrollmentId,
      recipientDeviceId: credential.deviceId, recipientEnrollmentId: credential.deviceEnrollmentId,
      ephemeralPublicKey: base64url(ephemeral.publicKey.rawRepresentation), sequence: nil, nonce: base64url(nonceBytes), ciphertext: nil)
    let context = try RelayFlightCodec.handshakeContext(hello: inbound, welcome: outbound)
    var derived = try derive3DH(ephemeral: ephemeral, peerEphemeral: peerText, context: context)
    defer {
      XChaCha.zeroize(&derived.clientToHost)
      XChaCha.zeroize(&derived.hostToClient)
    }
    var sealerPrefix = try random.bytes(count: 4)
    defer { XChaCha.zeroize(&sealerPrefix) }
    let newSealer = try XChaChaFrameSealer(key: try XChaChaKey(derived.hostToClient), noncePrefix: sealerPrefix)
    clientToHostKey = derived.clientToHost
    sealer = newSealer
    hello = inbound; welcome = outbound
    try gate.markWelcomeSent(); try extendDeadline()
    try await sendBeforeDeadline(RelayFlightCodec.encode(outbound))
    state = .awaitingReady
  }

  private func receiveReady(_ inbound: RelayFlight) async throws {
    guard let sealer else { throw RelayOwnerError.unavailable }
    try verify(inbound, expected: "dsh-remote/v3/ready", key: clientToHostKey)
    let outbound = hostFrame(kind: .finish, epoch: inbound.connectionEpoch, nonce: "", ciphertext: "")
    let sealed = try await sealer.seal(Data("dsh-remote/v3/finish".utf8), aad: associatedData(type: "finish", flight: outbound))
    let encrypted = hostFrame(kind: .finish, epoch: inbound.connectionEpoch, nonce: base64url(sealed.nonce.encoded), ciphertext: base64url(sealed.ciphertext))
    try gate.markFinishSent(); try extendDeadline()
    try await sendBeforeDeadline(RelayFlightCodec.encode(encrypted))
    state = .awaitingAck
  }

  private func verifyAck(_ inbound: RelayFlight) throws {
    try verify(inbound, expected: "dsh-remote/v3/ack", key: clientToHostKey)
  }

  private func receiveAck(_ inbound: RelayFlight) async throws {
    try verifyAck(inbound)
    guard let sealer else { throw RelayOwnerError.invalidState }
    let frame = hostFrame(kind: .commit, epoch: inbound.connectionEpoch, nonce: "", ciphertext: "")
    let sealed = try await sealer.seal(Data("dsh-remote/v3/commit".utf8), aad: associatedData(type: "commit", flight: frame))
    let outbound = hostFrame(kind: .commit, epoch: inbound.connectionEpoch, nonce: base64url(sealed.nonce.encoded), ciphertext: base64url(sealed.ciphertext))
    try gate.markCommitSent()
    try await sendBeforeDeadline(RelayFlightCodec.encode(outbound))
    try extendDeadline()
    state = .awaitingConfirm
  }

  private func receiveConfirm(_ inbound: RelayFlight) async throws {
    try verify(inbound, expected: "dsh-remote/v3/confirm", key: clientToHostKey)
    try finalizeConnectionEpoch(inbound.connectionEpoch)
    guard let sealer else { throw RelayOwnerError.invalidState }
    let frame = hostFrame(kind: .receipt, epoch: inbound.connectionEpoch, nonce: "", ciphertext: "")
    let sealed = try await sealer.seal(Data("dsh-remote/v3/receipt".utf8), aad: associatedData(type: "receipt", flight: frame))
    let outbound = hostFrame(kind: .receipt, epoch: inbound.connectionEpoch, nonce: base64url(sealed.nonce.encoded), ciphertext: base64url(sealed.ciphertext))
    try gate.markReceiptSent()
    try await sendBeforeDeadline(RelayFlightCodec.encode(outbound))
    state = .established; deadline = 0
  }

  private func derive3DH(ephemeral: Curve25519.KeyAgreement.PrivateKey, peerEphemeral: String, context: Data) throws -> (clientToHost: Data, hostToClient: Data) {
    guard canonicalX25519(agreement.publicKey), canonicalX25519(credential.deviceAgreementPublicKey) else { throw RelayOwnerError.invalidCredential }
    var ss = try checkedSecret(agreement.deriveSharedSecret(peerPublicKey: credential.deviceAgreementPublicKey))
    var eS = try ephemeralSecret(ephemeral, credential.deviceAgreementPublicKey)
    var Se = try checkedSecret(agreement.deriveSharedSecret(peerPublicKey: peerEphemeral))
    var ee = try ephemeralSecret(ephemeral, peerEphemeral)
    var material = Data(); material.reserveCapacity(128); material.append(ss); material.append(eS); material.append(Se); material.append(ee)
    defer { XChaCha.zeroize(&ss); XChaCha.zeroize(&eS); XChaCha.zeroize(&Se); XChaCha.zeroize(&ee); XChaCha.zeroize(&material) }
    let output = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: material), salt: context, info: Data("dsh-remote/v3/3dh".utf8), outputByteCount: 64)
    var bytes = output.withUnsafeBytes { Data($0) }
    defer { XChaCha.zeroize(&bytes) }
    return (Data(bytes.prefix(32)), Data(bytes.suffix(32)))
  }

  private func checkedSecret(_ value: Data) throws -> Data {
    guard value.count == 32, value.contains(where: { $0 != 0 }) else { throw RelayOwnerError.unavailable }
    return value
  }
  private func ephemeralSecret(_ ephemeral: Curve25519.KeyAgreement.PrivateKey, _ peerText: String) throws -> Data {
    guard let raw = base64urlDecode(peerText), raw.count == 32 else { throw RelayOwnerError.invalidCredential }
    let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw)
    let secret = try ephemeral.sharedSecretFromKeyAgreement(with: peer)
    return try checkedSecret(secret.withUnsafeBytes { Data($0) })
  }
  private func hostFrame(kind: RelayFlightKind, epoch: Int, nonce: String, ciphertext: String) -> RelayFlight {
    RelayFlight(kind: kind, routeId: credential.routeId, generation: credential.generation, connectionEpoch: epoch,
      senderDeviceId: credential.hostDeviceId, senderEnrollmentId: credential.hostEnrollmentId,
      recipientDeviceId: credential.deviceId, recipientEnrollmentId: credential.deviceEnrollmentId,
      ephemeralPublicKey: nil, sequence: nil, nonce: nonce, ciphertext: ciphertext)
  }
  private func ciphertextFrame(sequence: Int, nonce: String, ciphertext: String) -> RelayFlight {
    RelayFlight(kind: .ciphertext, routeId: credential.routeId, generation: credential.generation, connectionEpoch: acceptedEpoch ?? 0,
      senderDeviceId: credential.hostDeviceId, senderEnrollmentId: credential.hostEnrollmentId,
      recipientDeviceId: credential.deviceId, recipientEnrollmentId: credential.deviceEnrollmentId,
      ephemeralPublicKey: nil, sequence: sequence, nonce: nonce, ciphertext: ciphertext)
  }
  private func associatedData(type: String, flight: RelayFlight) -> Data {
    var values: [Any] = [type, flight.routeId, flight.generation, flight.connectionEpoch, flight.senderDeviceId, flight.senderEnrollmentId, flight.recipientDeviceId, flight.recipientEnrollmentId]
    if type == "ciphertext", let sequence = flight.sequence { values.append(sequence) }
    return try! JSONSerialization.data(withJSONObject: values, options: [])
  }
  private func verify(_ flight: RelayFlight, expected: String, key: Data?) throws {
    guard var key, let nonceText = flight.nonce, let cipherText = flight.ciphertext,
      let nonce = base64urlDecode(nonceText), let cipher = base64urlDecode(cipherText), nonce.count == 12 else { throw RelayOwnerError.invalidCredential }
    defer { XChaCha.zeroize(&key) }
    var plaintext = try XChaCha.open(cipher, aad: associatedData(type: flight.kind.rawValue, flight: flight), key: try XChaChaKey(key), nonce: try XChaChaNonce(nonce))
    defer { XChaCha.zeroize(&plaintext) }
    guard plaintext == Data(expected.utf8) else { throw RelayOwnerError.rejected }
  }
  private func sendBeforeDeadline(_ data: Data) async throws {
    try ensureConnectionAdmitted()
    let expiry = deadline
    let socket = socket, clock = clock
    try await withCheckedThrowingContinuation { continuation in
      let race = RelayDeadlineRace<Void>(); race.install(continuation)
      let fence = writeFence
      Task { do { guard try await socket.send(data, fence: fence), await fence.isOpen() else { throw RelayOwnerError.deadlineExceeded }; race.succeed(()) } catch { race.fail(error) } }
      Task { do { try await clock.sleep(untilNanoseconds: expiry); if let continuation = race.claimTimeout() { await fence.invalidate(); Task { await socket.close() }; continuation.resume(throwing: RelayOwnerError.deadlineExceeded) } } catch {
        if let continuation = race.claimTimeout() { await fence.invalidate(); Task { await socket.close() }; continuation.resume(throwing: error) }
      } }
    }
    try checkDeadline()
  }

  private func sendEstablished(_ data: Data) async throws {
    try ensureConnectionAdmitted()
    guard await writeFence.isOpen(), try await socket.send(data, fence: writeFence), await writeFence.isOpen() else {
      throw RelayOwnerError.unavailable
    }
    try ensureConnectionAdmitted()
  }

  private func validateRoute(_ flight: RelayFlight) throws {
    guard flight.routeId == credential.routeId, flight.generation == credential.generation,
      (acceptedEpoch.map({ flight.connectionEpoch == $0 }) ?? (state == .awaitingHello)),
      flight.senderDeviceId == credential.deviceId, flight.senderEnrollmentId == credential.deviceEnrollmentId,
      flight.recipientDeviceId == credential.hostDeviceId, flight.recipientEnrollmentId == credential.hostEnrollmentId
    else { throw RelayOwnerError.invalidCredential }
  }

  private func checkDeadline() throws {
    guard deadline != 0, clock.nowNanoseconds() < deadline else { throw RelayOwnerError.deadlineExceeded }
  }
  private func extendDeadline() throws {
    let now = clock.nowNanoseconds(); guard now <= UInt64.max - flightTimeoutNanoseconds else { throw RelayOwnerError.deadlineExceeded }
    deadline = now + flightTimeoutNanoseconds
  }
}

/// The only URLSession construction seam. It converts the fixed HTTPS codec URL to WSS,
/// applies the exact two subprotocol values, validates them again, and intentionally leaves
/// the task suspended. Calling `resume` is outside this package's API.
public enum RelayUnstartedURLSessionTaskFactory {
  public static func make(credential: RelayRouteCredential, session: URLSession = .shared) throws -> URLSessionWebSocketTask {
    let fixed = try RelayV3WebSocketCodec.request(credential)
    guard var components = URLComponents(url: fixed.url, resolvingAgainstBaseURL: false), components.scheme == "https",
      components.host == "dshrelay.rulabs.dev", components.port == nil,
      components.path == "/v3/routes/" + credential.routeId + "/connect", fixed.protocols.count == 2,
      fixed.protocols[0] == "dsh-remote-v3", fixed.protocols[1] == "dsh-host." + credential.hostToken
    else { throw RelayOwnerError.invalidCredential }
    components.scheme = "wss"
    guard let url = components.url else { throw RelayOwnerError.invalidCredential }
    var request = URLRequest(url: url)
    request.setValue(fixed.protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
    let task = session.webSocketTask(with: request)
    task.maximumMessageSize = RelayURLSessionHostSocket.maximumMessageBytes
    return task // Deliberately not resumed.
  }
}

private func base64url(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
private func base64urlDecode(_ text: String) -> Data? {
  var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
  return Data(base64Encoded: base64)
}
