import Foundation
import RemoteHostFd199
import RemoteHostRelay
import RemoteHostWire

/**
 Owns the one activated V3 relay socket and its FD198 bridge for a hosted DSH
 child. It is constructed inert and starts its network socket only after the
 signed FD199 coordinator has consumed the activation journal.
 */
final class HostedRelaySession: Fd199RelayBridge.SessionOwner, @unchecked Sendable {
  private struct StageError: Error, CustomStringConvertible {
    let stage: String
    let cause: Error
    var description: String { "\(stage): \(String(describing: cause))" }
  }

  private static let pairedPhoneLabel = "Paired iPhone"
  private let lock = NSLock()
  private let coordinator: Fd199HandoffCoordinator
  private let socket: RelayHostSocketSupervisor
  private var bridge: Fd199RelayBridge?
  private var receiveTask: Task<Void, Never>?
  private var stopped = false
  private lazy var framePump = HostedRelayFramePump(
    sendToPhone: { [socket] payload in try await socket.sendCiphertext(payload) },
    failed: { [weak self] in Task { await self?.stop() } }
  )
  private let enrollmentReceipt = HostedChildEnrollmentReceipt()
  private let epochSynchronization = HostedChildEpochSynchronization()

  init(
    coordinator: Fd199HandoffCoordinator,
    credential: RelayRouteCredential,
    agreement: RelayProtectedAgreement,
    epochLedger: RelayConnectionEpochLedger,
    connectionCoordinator: RelayHostRouteConnectionCoordinator
  ) {
    self.coordinator = coordinator
    socket = RelayHostSocketSupervisor(
      credential: credential,
      agreement: agreement,
      epochLedger: epochLedger,
      connectionCoordinator: connectionCoordinator
    )
    // The bridge's only outbound owner is this Host object. Assignment occurs
    // after stored state is initialized, not through a global callback sink.
    bridge = Fd199RelayBridge(
      sendIntoChild: { [weak coordinator] record in
        guard let coordinator else { throw Fd199BridgeError.detached }
        try coordinator.sendPublicRecord(record)
      },
      owner: self
    )
  }

  /** Completes FD199 first, then teaches the adopted child the native route and opens the authenticated socket. */
  func activate(credential: RelayRouteCredential) async throws {
    try assertNotStopped()
    try staged("ownership-transfer") { try coordinator.activatePhoneSessions() }
    try await configureActivatedRelay(credential: credential)
  }

  /** Rebuilds only the native relay carrier after an activated-journal restart. */
  func resume(credential: RelayRouteCredential) async throws {
    try assertNotStopped()
    guard coordinator.phase == .servingPhoneSessions else {
      throw Fd199HandoffCoordinator.CoordinatorError.invalidState
    }
    try await configureActivatedRelay(credential: credential)
  }

  private func configureActivatedRelay(credential: RelayRouteCredential) async throws {
    guard let bridge else { throw Fd199BridgeError.detached }
    try staged("enrollment-seed") { try bridge.enrollmentSeed(
      deviceId: credential.deviceId,
      label: Self.pairedPhoneLabel,
      signingPublicKey: credential.deviceSigningPublicKey,
      agreementPublicKey: credential.deviceAgreementPublicKey,
      deviceEnrollmentId: credential.deviceEnrollmentId,
      hostEnrollmentId: credential.hostEnrollmentId
    ) }
    try staged("device-enroll") { try bridge.deviceEnroll(
      deviceId: credential.deviceId,
      label: Self.pairedPhoneLabel,
      signingPublicKey: credential.deviceSigningPublicKey,
      agreementPublicKey: credential.deviceAgreementPublicKey
    ) }
    try staged("enrollment-receipt") { try enrollmentReceipt.wait(
      credential: credential,
      expectedLabel: Self.pairedPhoneLabel,
      timeoutMilliseconds: 5_000
    ) }
    try staged("route-upsert") { try bridge.routeUpsert(
      routeId: credential.routeId,
      deviceId: credential.deviceId,
      deviceEnrollmentId: credential.deviceEnrollmentId,
      hostDeviceId: credential.hostDeviceId,
      hostEnrollmentId: credential.hostEnrollmentId,
      generation: credential.generation
    ) }
    try await stagedAsync("relay-socket") { try await socket.start() }
    let epoch = try await stagedAsync("connection-epoch") { try await socket.establishedConnectionEpoch() }
    let metadata = try staged("connection-metadata") { try makeConnectionMetadata(
      credential: credential,
      connectionId: UUID().uuidString.lowercased(),
      epoch: epoch
    ) }
    try staged("frame-pump") { try framePump.install(metadata: metadata) }
    try staged("epoch-synchronization") {
      try epochSynchronization.synchronizeThenOpen(
        request: RelayFinalizedEpochWire.request(credential: credential, epoch: epoch),
        send: { [coordinator] record in try coordinator.sendPublicRecord(record) },
        open: { try self.assertNotStopped(); try bridge.connectionOpened(metadata: metadata) }
      )
    }
    guard installReceiveTask() else {
      await socket.stop()
      throw Fd199BridgeError.detached
    }
  }

  private func staged<T>(_ stage: String, _ operation: () throws -> T) throws -> T {
    do { return try operation() }
    catch { throw StageError(stage: stage, cause: error) }
  }

  private func stagedAsync<T>(_ stage: String, _ operation: () async throws -> T) async throws -> T {
    do { return try await operation() }
    catch { throw StageError(stage: stage, cause: error) }
  }

  /** Routes fixed child effects into the already-authenticated relay carrier. */
  func childOutput(_ output: Fd199HostedChildOutput) {
    let bridge: Fd199RelayBridge?
    lock.lock()
    bridge = stopped ? nil : self.bridge
    lock.unlock()
    guard let bridge else { return }
    switch output {
    case .ready:
      bridge.childRecord(RemoteWireRecord(kind: .runtimeReady))
    case let .send(metadata, payload):
      bridge.childRecord(RemoteWireRecord(kind: .connectionSend, metadata: metadata, payload: payload))
    case let .close(metadata):
      bridge.childRecord(RemoteWireRecord(kind: .connectionClose, metadata: metadata))
    case let .deviceEnrolled(metadata):
      enrollmentReceipt.receive(metadata)
    case let .epochSynchronized(metadata, payload):
      epochSynchronization.receive(RemoteWireRecord(kind: .epochSynchronized, metadata: metadata, payload: payload))
    }
  }

  /** Stops receiver, relay socket, and child forwarding. It is idempotent. */
  func stop() async {
    epochSynchronization.stop()
    guard let (task, bridge) = detachForStop() else { return }
    task?.cancel()
    bridge?.detachOwner()
    await socket.stop()
  }

  // MARK: - Child egress

  func hostedChildDidOpen(metadata: Data) {
    // `connection.send` carries the complete response record. There is no
    // independent network open effect after the V3 transport handshake.
    _ = metadata
  }

  func hostedChildDidSend(metadata: Data, payload: Data) {
    framePump.childPlaintext(metadata: metadata, payload: payload)
  }

  func hostedChildDidClose(metadata: Data) {
    guard framePump.isCurrentClose(metadata: metadata) else { return }
    Task { [weak self] in await self?.stop() }
  }

  // MARK: - Phone ingress

  private func receiveLoop() async {
    while !Task.isCancelled {
      do {
        let plaintext = try await socket.receiveCiphertext()
        try acceptPhonePlaintext(plaintext)
      } catch {
        await stop()
        return
      }
    }
  }

  private func assertNotStopped() throws {
    lock.lock()
    let unavailable = stopped
    lock.unlock()
    if unavailable { throw Fd199BridgeError.detached }
  }

  private func installReceiveTask() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !stopped else { return false }
    receiveTask = Task { [weak self] in await self?.receiveLoop() }
    return true
  }

  private func detachForStop() -> (Task<Void, Never>?, Fd199RelayBridge?)? {
    lock.lock()
    defer { lock.unlock() }
    guard !stopped else { return nil }
    stopped = true
    let task = receiveTask
    receiveTask = nil
    let bridge = self.bridge
    framePump.clear()
    return (task, bridge)
  }

  /** The encrypted carrier already carries one canonical JSON application envelope. */
  private func acceptPhonePlaintext(_ plaintext: Data) throws {
    let frame = try framePump.phonePlaintext(plaintext)
    let bridge: Fd199RelayBridge?
    lock.lock()
    bridge = self.bridge
    lock.unlock()
    guard let bridge else { throw Fd199BridgeError.invalidPhoneRecord }
    try bridge.frameArrived(metadata: frame.metadata, payload: frame.payload)
  }

  private func makeConnectionMetadata(credential: RelayRouteCredential, connectionId: String, epoch: Int) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
      "connectionId": connectionId, "deviceId": credential.deviceId,
      "enrollmentId": credential.deviceEnrollmentId,
      "signingPublicKey": credential.deviceSigningPublicKey,
      "agreementPublicKey": credential.deviceAgreementPublicKey,
      "routeId": credential.routeId, "generation": credential.generation,
      "connectionEpoch": epoch,
    ], options: [.sortedKeys])
  }

}

/**
 A one-shot, fail-closed bridge between the child receipt callback and the
 activation path. It deliberately has no API for replacing a credential with
 child-minted identifiers: the iPhone's invitation and relay authentication
 are already bound to the native credential.
 */
private final class HostedChildEnrollmentReceipt: @unchecked Sendable {
  private let lock = NSLock()
  private var metadata: Data?
  private var closed = false

  func receive(_ metadata: Data) {
    lock.lock()
    guard !closed, self.metadata == nil else {
      lock.unlock()
      return
    }
    self.metadata = metadata
    lock.unlock()
  }

  func wait(credential: RelayRouteCredential, expectedLabel: String, timeoutMilliseconds: Int) throws {
    precondition(timeoutMilliseconds > 0)
    let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeoutMilliseconds) * 1_000_000
    while true {
      let receipt: Data?
      lock.lock()
      receipt = metadata
      lock.unlock()
      if let receipt {
        return try RelayHostedChildEnrollmentReconciliation.validate(
          RemoteWireRecord(kind: .deviceEnrolled, metadata: receipt),
          credential: credential,
          expectedLabel: expectedLabel,
          enrolledAt: Self.validationInstant()
        )
      }
      if DispatchTime.now().uptimeNanoseconds >= deadline {
        throw RelayEnrollmentError.unavailable
      }
      usleep(1_000)
    }
  }

  private static func validationInstant() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
  }
}
