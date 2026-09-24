import Foundation
import Security
import RemoteHostXChaCha

/** Closed outcomes for the signed-Host enrollment and relay provisioning lifecycle. */
public enum RelayEnrollmentLifecycleError: Error, Equatable, Sendable {
  case invalidState
  case provisioningDisabled
  case provisionRejected
}

/**
 * Proof that this exact process is the strict-validated signed DSH Host app.
 *
 * This is an explicit activation guard. Nothing constructs it during normal Host
 * startup, and a caller cannot supply an arbitrary executable, bundle, origin,
 * or route endpoint.
 */
public struct RelaySignedHostActivationConfiguration: Sendable {
  private let designatedRequirement: String
  private init(designatedRequirement: String) { self.designatedRequirement = designatedRequirement }

  private struct ExpectedRequirement: Decodable { let requirement: String }

  static func matchesPackagedDesignatedRequirement(_ packaged: String, designated: String) -> Bool {
    packaged.contains("anchor apple generic") && packaged == designated
  }

  /**
   * Validates the running signed Host before a production URLSession provisioner
   * may be constructed.
   */
  public static func validateRunningHost() throws -> RelaySignedHostActivationConfiguration {
    let expectedIdentifier = "com.deepseek.dsh.remote-host"
    let bundle = Bundle.main
    let bundleURL = bundle.bundleURL.resolvingSymlinksInPath()
    guard bundleURL.pathExtension == "app",
          bundle.executableURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
    else { throw RelayOwnerError.unavailable }
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(bundleURL as CFURL, [], &code) == errSecSuccess,
          let code,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess
    else { throw RelayOwnerError.unavailable }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let values = information as? [String: Any],
          values[kSecCodeInfoIdentifier as String] as? String == expectedIdentifier
    else { throw RelayOwnerError.unavailable }
    guard let requirementURL = bundle.url(forResource: "HostActivationRequirement", withExtension: "plist"),
          let requirementData = try? Data(contentsOf: requirementURL),
          let expected = try? PropertyListDecoder().decode(ExpectedRequirement.self, from: requirementData),
          expected.requirement.contains("anchor apple generic")
    else { throw RelayOwnerError.unavailable }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(expected.requirement as CFString, [], &requirement) == errSecSuccess,
          let requirement,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess
    else { throw RelayOwnerError.unavailable }
    var designated: SecRequirement?
    var designatedString: CFString?
    guard SecCodeCopyDesignatedRequirement(code, [], &designated) == errSecSuccess,
          let designated,
          SecRequirementCopyString(designated, [], &designatedString) == errSecSuccess,
          let designatedString,
          matchesPackagedDesignatedRequirement(expected.requirement, designated: designatedString as String)
    else { throw RelayOwnerError.unavailable }
    return RelaySignedHostActivationConfiguration(designatedRequirement: designatedString as String)
  }

  func matchesRunningHostRequirement(_ requirement: String) -> Bool {
    Self.matchesPackagedDesignatedRequirement(requirement, designated: designatedRequirement)
  }
}

/**
 * Native-only provision/revoke operation. Implementations receive opaque native
 * credentials only; this protocol is never represented on Remote Wire or FD198.
 */
public protocol RelayRouteProvisioner: Sendable {
  func provision(_ credential: RelayRouteCredential, provisioning: RelayProvisioningCredential) async throws
  func revoke(_ credential: RelayRouteCredential) async throws
}

/** Native no-network gate used until a separately sealed activation resource exists. */
final class RelayDisabledRouteProvisioner: RelayRouteProvisioner {
  func provision(_ credential: RelayRouteCredential, provisioning: RelayProvisioningCredential) async throws {
    throw RelayEnrollmentLifecycleError.provisioningDisabled
  }
  func revoke(_ credential: RelayRouteCredential) async throws {
    throw RelayEnrollmentLifecycleError.provisioningDisabled
  }
}

private protocol RelayProvisioningGate {
  var isProvisioningEnabled: Bool { get }
}

extension RelayDisabledRouteProvisioner: RelayProvisioningGate {
  var isProvisioningEnabled: Bool { false }
}

/**
 * The sole production HTTP provisioner. Its initializer requires an explicit
 * strict-signed Host proof. Constructing it sends nothing; a request occurs only
 * if the signed Host later calls the lifecycle confirmation method.
 */
final class RelayRejectRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

public final class RelayURLSessionRouteProvisioner: @unchecked Sendable, RelayRouteProvisioner {
  private let session: URLSession
  private let redirectDelegate: RelayRejectRedirects

  public convenience init(configuration: RelaySignedHostActivationConfiguration) {
    self.init(configuration: configuration, session: nil)
  }

  /** Test-only injection. Production construction uses the isolated no-redirect session above. */
  init(configuration: RelaySignedHostActivationConfiguration, session: URLSession?) {
    _ = configuration
    let redirectDelegate = RelayRejectRedirects()
    self.redirectDelegate = redirectDelegate
    if let session { self.session = session }
    else {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.httpShouldSetCookies = false
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      self.session = URLSession(configuration: configuration, delegate: redirectDelegate, delegateQueue: nil)
    }
  }

  public func provision(_ credential: RelayRouteCredential, provisioning: RelayProvisioningCredential) async throws {
    try await send(RelayV3RequestCodec.create(credential, provisioning: provisioning), acceptedStatuses: [201])
  }

  public func revoke(_ credential: RelayRouteCredential) async throws {
    try await send(RelayV3RequestCodec.revoke(credential), acceptedStatuses: [204, 404])
  }

  private func send(_ fixed: RelayHTTPRequest, acceptedStatuses: Set<Int>) async throws {
    var request = URLRequest(url: fixed.url)
    request.httpMethod = fixed.method
    request.httpBody = fixed.body
    for (field, value) in fixed.headers { request.setValue(value, forHTTPHeaderField: field) }
    let result: (Data, URLResponse)
    do { result = try await session.data(for: request) }
    catch { throw RelayOwnerError.unavailable }
    var responseBody = result.0
    defer { XChaCha.zeroize(&responseBody) }
    guard let response = result.1 as? HTTPURLResponse, acceptedStatuses.contains(response.statusCode) else {
      throw RelayEnrollmentLifecycleError.provisionRejected
    }
  }
}

/** Observable state that contains only a phone-safe invitation, never Host credentials. */
public enum RelayEnrollmentLifecycleState: Equatable, Sendable {
  case idle
  case awaitingLocalConfirmation
  case preparingRuntimeReceipt
  case provisioning
  case invitationReady(RelayEnrollmentInvitation)
  case activeRouteRecovery
  case revoking
  case remoteRevokedPendingLocalCleanup
  case compensationPending
  case revoked
  case failed
}

/**
 * Signed-Host owner that composes local confirmation, the private runtime receipt,
 * native provisioning, durable credentials, and a phone-safe invitation.
 *
 * The caller must inject a provisioner. The Host app currently injects none, so
 * assembling or launching it cannot provision, connect, or pair a relay route.
 */
public final class RelayEnrollmentLifecycle: @unchecked Sendable {
  private let lock = NSLock()
  private let enrollment: RelayEnrollmentController
  private let store: RelaySecretStore
  private let provisioner: RelayRouteProvisioner
  private let connectionOwner: RelayActiveRouteConnectionOwner
  private var current: RelayEnrollmentLifecycleState = .idle
  private var activeRoute: RelayRouteCredential?
  private var activeInvitation: RelayEnrollmentInvitation?

  public init(enrollment: RelayEnrollmentController, store: RelaySecretStore, provisioner: RelayRouteProvisioner, connectionOwner: RelayActiveRouteConnectionOwner) throws {
    self.enrollment = enrollment
    self.store = store
    self.provisioner = provisioner
    self.connectionOwner = connectionOwner
    if let cleanup = try store.revokedCleanupRouteCredential() {
      activeRoute = cleanup
      current = .remoteRevokedPendingLocalCleanup
    } else if let pending = try store.pendingRouteCredential() {
      activeRoute = pending
      current = .compensationPending
    } else if let active = try store.activeRouteCredential() {
      activeRoute = active
      current = .activeRouteRecovery
    }
  }

  public var state: RelayEnrollmentLifecycleState { lock.withLock { current } }

  /** Accepts the public phone identity and waits for an explicit local confirmation. */
  public func acceptIPhoneIdentity(_ device: RelayEnrollmentDevice) throws -> RelayEnrollmentCandidate {
    try lock.withLock {
      guard current == .idle || current == .revoked || current == .failed else { throw RelayEnrollmentLifecycleError.invalidState }
      let candidate = try enrollment.acceptIPhoneIdentity(device)
      current = .awaitingLocalConfirmation
      return candidate
    }
  }

  /** Reissues the short-lived phone-safe transfer for the already active route. */
  public func reissueActiveInvitation() throws -> RelayEnrollmentInvitation {
    let route = try lock.withLock { () throws -> RelayRouteCredential in
      guard let activeRoute else { throw RelayEnrollmentLifecycleError.invalidState }
      switch current {
      case .invitationReady, .activeRouteRecovery: return activeRoute
      default: throw RelayEnrollmentLifecycleError.invalidState
      }
    }
    let invitation = try currentInvitation(for: route)
    lock.withLock {
      activeInvitation = invitation
      current = .invitationReady(invitation)
    }
    return invitation
  }

  /**
   * Runs the only activation transition: local confirmation -> private runtime
   * receipt -> relay provision accepted -> Keychain credential -> invitation.
   */
  public func confirmLocally(_ candidate: RelayEnrollmentCandidate) async throws -> RelayEnrollmentInvitation {
    if let gate = provisioner as? any RelayProvisioningGate, !gate.isProvisioningEnabled {
      throw RelayEnrollmentLifecycleError.provisioningDisabled
    }
    let prepared: RelayEnrollmentPreparedRoute
    do {
      try lock.withLock {
        guard current == .awaitingLocalConfirmation else { throw RelayEnrollmentLifecycleError.invalidState }
        current = .preparingRuntimeReceipt
      }
      prepared = try enrollment.prepareLocally(candidate)
      lock.withLock { current = .provisioning }
    } catch {
      lock.withLock { current = .failed }
      throw error
    }

    var pendingStored = false
    var remoteAttempted = false
    do {
      try store.savePendingRouteCredential(prepared.credential)
      pendingStored = true
      let provisioning = try store.provisioningCredential()
      remoteAttempted = true
      try await provisioner.provision(prepared.credential, provisioning: provisioning)
      try store.saveRouteCredential(prepared.credential)
      try store.saveConnectionEpochState(try RelayConnectionEpochState.initial(routeId: prepared.credential.routeId))
      try store.saveActiveRouteCredential(prepared.credential)
      try store.removePendingRouteCredential(routeId: prepared.credential.routeId)
      let invitation = try currentInvitation(for: prepared.credential)
      lock.withLock {
        activeRoute = prepared.credential
        activeInvitation = invitation
        current = .invitationReady(invitation)
      }
      return invitation
    } catch {
      if remoteAttempted { await compensateUncertainProvision(prepared.credential) }
      else {
        if pendingStored { try? store.removePendingRouteCredential(routeId: prepared.credential.routeId) }
        enrollment.discardPreparedRoute(routeId: prepared.credential.routeId)
        lock.withLock {
          activeRoute = nil
          activeInvitation = nil
          current = .failed
        }
      }
      throw error
    }
  }

  /// The invitation advertises the exact epoch the Host will use next. A
  /// pending epoch is a recovery fact, not a reason to issue a fresh epoch.
  private func currentInvitation(for credential: RelayRouteCredential) throws -> RelayEnrollmentInvitation {
    guard let state = try store.connectionEpochState(routeId: credential.routeId),
          state.routeId == credential.routeId, !state.revoking
    else { throw RelayEnrollmentLifecycleError.invalidState }
    let epoch: Int
    if let pending = state.pendingEpoch {
      epoch = pending
    } else {
      guard state.lastCommittedEpoch < 2_147_483_647 else { throw RelayEnrollmentLifecycleError.invalidState }
      epoch = state.lastCommittedEpoch + 1
    }
    return try enrollment.reissueInvitation(for: credential, connectionEpoch: epoch)
  }

  /** Revokes the active route first, then removes its Keychain credential. */
  public func revoke() async throws {
    let active: (RelayRouteCredential, RelayEnrollmentInvitation?) = try lock.withLock {
      guard let activeRoute else { throw RelayEnrollmentLifecycleError.invalidState }
      switch current {
      case .invitationReady, .activeRouteRecovery: break
      default: throw RelayEnrollmentLifecycleError.invalidState
      }
      current = .revoking
      return (activeRoute, activeInvitation)
    }
    do { try RelayConnectionEpochLedger.beginRevocation(for: active.0, store: store) }
    catch {
      lock.withLock { current = restoredActiveState(active.1) }
      throw error
    }
    await connectionOwner.beginRevocation(for: active.0)
    do { try store.saveRevokedCleanupRouteCredential(active.0) }
    catch {
      lock.withLock { current = restoredActiveState(active.1) }
      throw error
    }
    do { try await provisioner.revoke(active.0) }
    catch {
      lock.withLock {
        activeRoute = active.0
        activeInvitation = nil
        current = .remoteRevokedPendingLocalCleanup
      }
      throw error
    }
    do { try store.removeRouteCredential(routeId: active.0.routeId) }
    catch {
      lock.withLock {
        activeRoute = active.0
        activeInvitation = nil
        current = .remoteRevokedPendingLocalCleanup
      }
      throw error
    }
    enrollment.discardPreparedRoute(routeId: active.0.routeId)
    do { try store.removeActiveRouteCredential(routeId: active.0.routeId) }
    catch {
      lock.withLock {
        activeRoute = active.0
        activeInvitation = nil
        current = .remoteRevokedPendingLocalCleanup
      }
      throw error
    }
    do { try store.removeConnectionEpochState(routeId: active.0.routeId) }
    catch {
      lock.withLock {
        activeRoute = active.0
        activeInvitation = nil
        current = .remoteRevokedPendingLocalCleanup
      }
      throw error
    }
    do { try store.removeRevokedCleanupRouteCredential(routeId: active.0.routeId) }
    catch {
      lock.withLock {
        activeRoute = active.0
        activeInvitation = nil
        current = .remoteRevokedPendingLocalCleanup
      }
      throw error
    }
    lock.withLock {
      activeRoute = nil
      activeInvitation = nil
      current = .revoked
    }
    await connectionOwner.finishRevocation(for: active.0)
  }

  /**
   * Restarts a durable revoke cleanup after a Host crash. Remote DELETE is
   * idempotent, so this makes the persisted intent safe even if the process
   * stopped after recording it but before receiving the first result.
   */
  public func recoverRevokedCleanup() async throws {
    let route: RelayRouteCredential = try lock.withLock {
      guard current == .remoteRevokedPendingLocalCleanup, let activeRoute else { throw RelayEnrollmentLifecycleError.invalidState }
      return activeRoute
    }
    // A crash can happen after removing the active pointer but before removing
    // the epoch and cleanup records. With no active pointer, new reservations
    // are already denied; retain the cleanup path rather than failing recovery.
    if let active = try store.activeRouteCredential() {
      guard active == route else { throw RelayOwnerError.unavailable }
      try RelayConnectionEpochLedger.beginRevocation(for: route, store: store)
    }
    await connectionOwner.beginRevocation(for: route)
    try await provisioner.revoke(route)
    try store.removeRouteCredential(routeId: route.routeId)
    try store.removeActiveRouteCredential(routeId: route.routeId)
    try store.removeConnectionEpochState(routeId: route.routeId)
    try store.removeRevokedCleanupRouteCredential(routeId: route.routeId)
    enrollment.discardPreparedRoute(routeId: route.routeId)
    lock.withLock {
      activeRoute = nil
      activeInvitation = nil
      current = .revoked
    }
    await connectionOwner.finishRevocation(for: route)
  }

  /** Attempts idempotent remote cleanup for a persisted route with an uncertain create result. */
  public func reconcilePendingCompensation() async throws {
    let route: RelayRouteCredential = try lock.withLock {
      guard current == .compensationPending, let activeRoute else { throw RelayEnrollmentLifecycleError.invalidState }
      return activeRoute
    }
    await connectionOwner.stopConnection(for: route)
    do {
      try await provisioner.revoke(route)
      try store.removeRouteCredential(routeId: route.routeId)
      try store.removeActiveRouteCredential(routeId: route.routeId)
      try store.removeConnectionEpochState(routeId: route.routeId)
      try store.removePendingRouteCredential(routeId: route.routeId)
      enrollment.discardPreparedRoute(routeId: route.routeId)
      lock.withLock {
        activeRoute = nil
        activeInvitation = nil
        current = .failed
      }
    } catch {
      throw error
    }
  }

  private func compensateUncertainProvision(_ route: RelayRouteCredential) async {
    do {
      await connectionOwner.stopConnection(for: route)
      try await provisioner.revoke(route)
      try store.removeRouteCredential(routeId: route.routeId)
      try store.removeActiveRouteCredential(routeId: route.routeId)
      try store.removeConnectionEpochState(routeId: route.routeId)
      try store.removePendingRouteCredential(routeId: route.routeId)
      enrollment.discardPreparedRoute(routeId: route.routeId)
      lock.withLock {
        activeRoute = nil
        activeInvitation = nil
        current = .failed
      }
    } catch {
      lock.withLock {
        activeRoute = route
        activeInvitation = nil
        current = .compensationPending
      }
    }
  }

  private func restoredActiveState(_ invitation: RelayEnrollmentInvitation?) -> RelayEnrollmentLifecycleState {
    invitation.map(RelayEnrollmentLifecycleState.invitationReady) ?? .activeRouteRecovery
  }
}
