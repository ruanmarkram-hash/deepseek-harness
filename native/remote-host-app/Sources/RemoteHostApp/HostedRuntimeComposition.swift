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
  private let agreement: any RelayProtectedAgreement & RelayHostPublicIdentityProvider
  private let store: RelaySecretStore
  private let connectionCoordinator: RelayHostRouteConnectionCoordinator
  private let lifecycle = HostedRuntimeLifecycle<Fd199HandoffCoordinator, AuthorizedHostedPhoneSession>()

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
    do {
      return try lifecycle.whileIdle {
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
    } catch Fd199HandoffCoordinator.CoordinatorError.invalidState {
      throw PairingRepairError.runtimeRunning
    }
  }

  /** Starts or restores only the local child; phone activation remains explicit. */
  func start() async throws {
    try lifecycle.start(makeCarrier: HostedRuntimeComposition.makeCoordinator)
  }

  /**
 Activates fresh ownership or resumes already-activated ownership before
 starting the authenticated socket. An ended phone session requires replacing
 its seeded child first. Credentials stay in the native Host.
 */
  func activatePhoneSessions() async throws {
    try await lifecycle.activate(makeCarrier: HostedRuntimeComposition.makeCoordinator) { coordinator in
      let artifacts = try RemoteHostV3HostedChildPackaging.loadAndValidateBundledArtifacts()
      try PairingStateRepair.requireSettled(home: URL(fileURLWithPath: artifacts.webConfiguration.dshHome, isDirectory: true))
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
      return AuthorizedHostedPhoneSession(session: session, credential: credential)
    }
  }

  /** Stops relay delivery and both hosted-child channels. */
  func stop() async {
    await lifecycle.stop()
  }

  /** Revokes the native route, retires the child's copy, and clears all retained runtime owners. */
  @MainActor func revokePhoneSessions(_ revoke: () async throws -> Void) async throws {
    guard let credential = try store.activeRouteCredential() ?? store.revokedCleanupRouteCredential() ?? store.pendingRouteCredential() else {
      throw Fd199HandoffCoordinator.CoordinatorError.unavailable
    }
    do {
      let activeCoordinator = lifecycle.currentCarrier
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
    await lifecycle.stop()
  }
}

/** Keeps credential-dependent activation bound to its constructed session. */
private final class AuthorizedHostedPhoneSession: HostedRuntimePhoneSession, @unchecked Sendable {
  private let session: HostedRelaySession
  private let credential: RelayRouteCredential

  init(session: HostedRelaySession, credential: RelayRouteCredential) {
    self.session = session
    self.credential = credential
  }

  func activate() async throws { try await session.activate(credential: credential) }
  var isEnded: Bool { session.isEnded }
  func resume() async throws { try await session.resume(credential: credential) }
  func stop() async { await session.stop() }
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
