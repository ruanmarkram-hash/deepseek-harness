import AppKit
import Foundation
import RemoteHostFd199
import RemoteHostRuntimeBootstrap
import RemoteHostRelay

/**
 Production composition of the hosted FD199 runtime: the Keychain-backed
 signing identity, the signed hosted-child supervisor, and the handoff
 coordinator that drives prepare → release → relaunch → activate.

 Every artifact and signature input comes from the sealed Host bundle; this
 type adds no configuration surface of its own.
 */
enum HostedRuntimeComposition {
  /**
   Builds a started-ready coordinator. Throws when the running Host bundle or
   the embedded hosted-child artifacts fail their release validation.
   */
  static func makeCoordinator() throws -> Fd199HandoffCoordinator {
    _ = try RelaySignedHostActivationConfiguration.validateRunningHost()
    let artifacts = try RemoteHostV3HostedChildPackaging.loadAndValidateBundledArtifacts()
    try PairingStateRepair.requireSettled(home: URL(fileURLWithPath: artifacts.webConfiguration.dshHome, isDirectory: true))

    let journalRoot = HostedRuntimePaths.journalDirectory
    try FileManager.default.createDirectory(
      atPath: journalRoot,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )

    return Fd199HandoffCoordinator(
      identity: Fd199KeychainSigningIdentity(),
      hostAppPath: HostedRuntimePaths.hostAppPath,
      journalDirectory: journalRoot,
      spawn: {
        let supervisor = Fd199HostedChildSupervisor(nodeModulesPath: nil, hostedEntryRoot: nil, dshHomePath: HostedRuntimePaths.dshHome, onOutput: { output in
          // Relay-side session owners subscribe here through the bridge in
          // the full activation composition; the coordinator consumes ready.
          _ = output
        })
        try supervisor.start()
        return supervisor
      }
    )
  }
}

/**
 App-lifetime owner for the optional hosted runtime. It retains the FD199
 coordinator across user actions and keeps the relay socket strictly behind
 the journal activation gate.
 */
final class HostedRuntimeController: @unchecked Sendable {
  private let lock = NSLock()
  private let agreement: any RelayProtectedAgreement & RelayHostPublicIdentityProvider
  private let store: RelaySecretStore
  private let connectionCoordinator: RelayHostRouteConnectionCoordinator
  private var coordinator: Fd199HandoffCoordinator?
  private var relay: HostedRelaySession?
  private var starting = false

  init(agreement: any RelayProtectedAgreement & RelayHostPublicIdentityProvider, store: RelaySecretStore, connectionCoordinator: RelayHostRouteConnectionCoordinator) {
    self.agreement = agreement
    self.store = store
    self.connectionCoordinator = connectionCoordinator
  }

  /** Uses the existing authorized store but never exports or mutates its credential. */
  func checkPairingState() -> PairingStateReport {
    PairingStateDiagnostic.check(activeIdentity: {
      guard let route = try self.store.activeRouteCredential() else { return nil }
      return PairingStatePublicIdentity(
        deviceId: route.deviceId, deviceEnrollmentId: route.deviceEnrollmentId,
        hostEnrollmentId: route.hostEnrollmentId, hostDeviceId: route.hostDeviceId, signingPublicKey: route.deviceSigningPublicKey,
        agreementPublicKey: route.deviceAgreementPublicKey
      )
    }, sealedHome: {
      _ = try RelaySignedHostActivationConfiguration.validateRunningHost()
      let artifacts = try RemoteHostV3HostedChildPackaging.loadAndValidateBundledArtifacts()
      return URL(fileURLWithPath: artifacts.webConfiguration.dshHome, isDirectory: true)
    })
  }

  /** Explicit same-phone repair while all Host-owned runtime starts remain reserved off. */
  func repairMatchingPairingRecords() throws -> PairingRepairResult {
    guard reserveStart() else { throw PairingRepairError.runtimeRunning }
    defer { abandonStart() }
    _ = try RelaySignedHostActivationConfiguration.validateRunningHost()
    let artifacts = try RemoteHostV3HostedChildPackaging.loadAndValidateBundledArtifacts()
    let port = try PairingRepairPortReservation(port: artifacts.webConfiguration.port)
    return try withExtendedLifetime(port) {
      try RelayPairingRepairEligibility.withEligibleRoute(store: store, host: agreement) { route in
        let target = PairingRepairTarget(
          deviceId: route.deviceId, deviceEnrollmentId: route.deviceEnrollmentId,
          hostEnrollmentId: route.hostEnrollmentId, signingPublicKey: route.deviceSigningPublicKey,
          agreementPublicKey: route.deviceAgreementPublicKey, routeId: route.routeId,
          hostDeviceId: route.hostDeviceId, generation: route.generation
        )
        return try PairingStateRepair.perform(home: URL(fileURLWithPath: artifacts.webConfiguration.dshHome, isDirectory: true), target: target)
      }
    }
  }

  /** Starts a new desktop owner or restores the carrier for an active journal. */
  func start() async throws {
    guard reserveStart() else { throw Fd199HandoffCoordinator.CoordinatorError.invalidState }
    do {
      let coordinator = try HostedRuntimeComposition.makeCoordinator()
      try coordinator.start()
      var resumedSession: HostedRelaySession?
      if coordinator.phase == .servingPhoneSessions {
        guard let credential = try store.activeRouteCredential() else {
          coordinator.stop()
          throw Fd199HandoffCoordinator.CoordinatorError.unavailable
        }
        try RelayConnectionEpochLedger.initializeMissingState(for: credential, store: store)
        let session = HostedRelaySession(
          coordinator: coordinator,
          credential: credential,
          agreement: agreement,
          epochLedger: RelayConnectionEpochLedger(store: store),
          connectionCoordinator: connectionCoordinator
        )
        coordinator.setChildOutputHandler { [weak session] output in session?.childOutput(output) }
        do {
          try await session.resume(credential: credential)
        } catch {
          await session.stop()
          coordinator.stop()
          throw error
        }
        resumedSession = session
      }
      guard commitStart(coordinator: coordinator, relay: resumedSession) else {
        await resumedSession?.stop()
        coordinator.stop()
        throw Fd199HandoffCoordinator.CoordinatorError.invalidState
      }
    } catch {
      abandonStart()
      throw error
    }
  }

  /**
 Consumes the signed FD199 activation and only then starts the one authenticated
 V3 route socket. The active credential never leaves the native Host process.
 */
  func activatePhoneSessions() async throws {
    let artifacts = try RemoteHostV3HostedChildPackaging.loadAndValidateBundledArtifacts()
    try PairingStateRepair.requireSettled(home: URL(fileURLWithPath: artifacts.webConfiguration.dshHome, isDirectory: true))
    let coordinator = try coordinatorForActivation()
    guard let credential = try store.activeRouteCredential() else {
      throw Fd199HandoffCoordinator.CoordinatorError.unavailable
    }
    try RelayConnectionEpochLedger.initializeMissingState(for: credential, store: store)
    let session = HostedRelaySession(
      coordinator: coordinator,
      credential: credential,
      agreement: agreement,
      epochLedger: RelayConnectionEpochLedger(store: store),
      connectionCoordinator: connectionCoordinator
    )
    coordinator.setChildOutputHandler { [weak session] output in session?.childOutput(output) }
    do {
      try await session.activate(credential: credential)
    } catch {
      await session.stop()
      // A receipt mismatch means the consuming child has no trustworthy route
      // to serve. Tear down its activated FD199 generation as well, so a later
      // explicit Start action begins from a fresh, inert desktop generation.
      coordinator.stop()
      removeCoordinator(coordinator)
      throw error
    }
    guard installRelay(session) else {
      await session.stop()
      throw Fd199HandoffCoordinator.CoordinatorError.invalidState
    }
  }

  /** Stops relay delivery and both hosted-child channels. */
  func stop() async {
    let (relay, coordinator) = takeForStop()
    await relay?.stop()
    coordinator?.stop()
  }

  /** Revokes the native route, retires the child's copy, and clears all retained runtime owners. */
  @MainActor func revokePhoneSessions(_ revoke: () async throws -> Void) async throws {
    guard let credential = try store.activeRouteCredential() ?? store.revokedCleanupRouteCredential() ?? store.pendingRouteCredential() else {
      throw Fd199HandoffCoordinator.CoordinatorError.unavailable
    }
    do {
      let activeCoordinator = currentCoordinator()
      if activeCoordinator?.phase == .servingPhoneSessions {
        try activeCoordinator?.sendPublicRecord(RelayWireCodec.revoked(credential))
      }
      try await revoke()
    } catch {
      await stopRetainedRuntime()
      throw error
    }
    await stopRetainedRuntime()
  }

  /** A revoke attempt is fail-closed even when remote or local cleanup must be retried. */
  private func stopRetainedRuntime() async {
    let (relay, coordinator) = takeForStop()
    await relay?.stop()
    coordinator?.stop()
  }

  private func currentCoordinator() -> Fd199HandoffCoordinator? {
    lock.lock()
    defer { lock.unlock() }
    return coordinator
  }

  private func coordinatorForActivation() throws -> Fd199HandoffCoordinator {
    lock.lock()
    defer { lock.unlock() }
    guard let coordinator, relay == nil else { throw Fd199HandoffCoordinator.CoordinatorError.invalidState }
    return coordinator
  }

  private func installRelay(_ session: HostedRelaySession) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard relay == nil else { return false }
    relay = session
    return true
  }

  private func reserveStart() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard coordinator == nil, relay == nil, !starting else { return false }
    starting = true
    return true
  }

  private func commitStart(coordinator: Fd199HandoffCoordinator, relay: HostedRelaySession?) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard starting, self.coordinator == nil, self.relay == nil else { return false }
    starting = false
    self.coordinator = coordinator
    self.relay = relay
    return true
  }

  private func abandonStart() {
    lock.lock()
    starting = false
    lock.unlock()
  }

  private func takeForStop() -> (HostedRelaySession?, Fd199HandoffCoordinator?) {
    lock.lock()
    defer { lock.unlock() }
    let result = (relay, coordinator)
    relay = nil
    coordinator = nil
    return result
  }

  private func removeCoordinator(_ candidate: Fd199HandoffCoordinator) {
    lock.lock()
    defer { lock.unlock() }
    if coordinator === candidate { coordinator = nil }
  }
}

/** Fixed per-installation paths derived from the sealed container. */
enum HostedRuntimePaths {
  static var hostAppPath: String {
    Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS").appendingPathComponent("dsh-remote-host-app").path
  }

  static var journalDirectory: String {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("com.deepseek.dsh.remote-host/fd199-journal", isDirectory: true).path
  }

  /** Canonical desktop Web store, shared only through the FD199 release/reap handoff. */
  static var dshHome: String {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dsh", isDirectory: true).path
  }
}
