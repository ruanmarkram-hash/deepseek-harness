import Foundation
import RemoteHostWire

/** Test-only seam for the fixed private-runtime enrollment exchange. */
protocol RelayRuntimeEnrollmentExchange: Sendable {
  func enroll(_ device: RelayEnrollmentDevice) throws -> RemoteWireRecord
}

/**
 * The concrete FD198 Host-to-runtime enrollment exchange. It is constructed
 * only by the verified supervisor, which remains the sole reader and writer
 * of FD198. This type holds no descriptor and offers no generic RPC surface.
 */
public final class RelayFD198EnrollmentExchange: @unchecked Sendable, RelayRuntimeEnrollmentExchange {
  private let provider: any RelayRuntimeEnrollmentReceiptProvider

  /// Module-private supervisor construction. No raw descriptor crosses this boundary.
  init(provider: any RelayRuntimeEnrollmentReceiptProvider) {
    self.provider = provider
  }

  public func enroll(_ device: RelayEnrollmentDevice) throws -> RemoteWireRecord {
    try provider.enrollOverVerifiedRuntime(device)
  }
}

/** Internal capability implemented only by the FD198 supervisor. */
protocol RelayRuntimeEnrollmentReceiptProvider: AnyObject, Sendable {
  func enrollOverVerifiedRuntime(_ device: RelayEnrollmentDevice) throws -> RemoteWireRecord
}

/**
 * Adapts the only runtime enrollment receipt to the local enrollment directory.
 * The exchange receives exactly `device.enroll` and returns exactly
 * `device.enrolled`; it cannot expose a runtime token, private key, or RPC API.
 */
final class RelayRuntimeEnrollmentDirectory: @unchecked Sendable, RelayEnrollmentDirectory {
  private let exchange: RelayRuntimeEnrollmentExchange
  private let now: () -> Date

  init(exchange: RelayRuntimeEnrollmentExchange, now: @escaping () -> Date = Date.init) {
    self.exchange = exchange
    self.now = now
  }

  func enroll(_ device: RelayEnrollmentDevice) throws -> RelayEnrollmentDeviceRecord {
    let response = try exchange.enroll(device)
    return try RelayEnrollmentWireCodec.enrolled(response, enrolledAt: relayEnrollmentInstant(now()))
  }
}

private func relayEnrollmentInstant(_ value: Date) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: value)
}

/** The signed Host's narrow public-identity source. Private XPC operations remain outside this type. */
public protocol RelayHostPublicIdentityProvider: Sendable {
  func openHostIdentity() throws -> RelayEnrollmentHostIdentity
}

/**
 * Signed-native physical-pairing composition. Its production factory validates
 * the running signed Host before it creates the native-only provisioner. The
 * factory and its initializer perform no relay request, socket resume, or pair.
 */
public final class RelayHostPairingComposition: @unchecked Sendable {
  public let lifecycle: RelayEnrollmentLifecycle
  /// The sole route coordinator to pass to any explicitly constructed Host socket supervisor.
  public let connectionCoordinator: RelayHostRouteConnectionCoordinator

  private init(lifecycle: RelayEnrollmentLifecycle, connectionCoordinator: RelayHostRouteConnectionCoordinator) {
    self.lifecycle = lifecycle
    self.connectionCoordinator = connectionCoordinator
  }

  /**
   * Constructs the production-native composition only after strict signed-Host
   * validation and a ready verified runtime supervisor. Startup constructs this
   * inert composition but never accepts or confirms a device on its own.
   */
  public static func makeForVerifiedHost(identity: RelayHostPublicIdentityProvider, store: RelaySecretStore, supervisor: RelayPrivateRuntimeSupervisor) throws -> RelayHostPairingComposition {
    let configuration = try RelaySignedHostActivationConfiguration.validateRunningHost()
    let exchange = try supervisor.enrollmentExchange()
    // Read every recovery marker before the public-identity provider is asked
    // to create or open any durable Host identity. A failed startup therefore
    // cannot leave that provider as its only side effect.
    _ = try store.revokedCleanupRouteCredential()
    _ = try store.pendingRouteCredential()
    _ = try store.activeRouteCredential()
    let host = try identity.openHostIdentity()
    let directory = RelayRuntimeEnrollmentDirectory(exchange: exchange)
    let enrollment = RelayEnrollmentController(host: host, directory: directory)
    let provisioner: RelayRouteProvisioner = RelaySignedHostProvisioningActivation.permitsProvisioning(configuration: configuration)
      ? RelayURLSessionRouteProvisioner(configuration: configuration)
      : RelayDisabledRouteProvisioner()
    let connectionCoordinator = RelayHostRouteConnectionCoordinator(store: store)
    return try RelayHostPairingComposition(lifecycle: RelayEnrollmentLifecycle(enrollment: enrollment, store: store, provisioner: provisioner, connectionOwner: connectionCoordinator), connectionCoordinator: connectionCoordinator)
  }

  /// Internal test composition. It cannot construct the production URLSession path.
  static func makeForTest(host: RelayEnrollmentHostIdentity, store: RelaySecretStore, exchange: RelayRuntimeEnrollmentExchange, provisioner: RelayRouteProvisioner, random: RelayEnrollmentRandom, now: @escaping () -> Date) throws -> RelayHostPairingComposition {
    let directory = RelayRuntimeEnrollmentDirectory(exchange: exchange, now: now)
    let enrollment = RelayEnrollmentController(host: host, directory: directory, random: random, now: now)
    let connectionCoordinator = RelayHostRouteConnectionCoordinator(store: store)
    return try RelayHostPairingComposition(lifecycle: RelayEnrollmentLifecycle(enrollment: enrollment, store: store, provisioner: provisioner, connectionOwner: connectionCoordinator), connectionCoordinator: connectionCoordinator)
  }

  public func acceptIPhoneIdentity(_ device: RelayEnrollmentDevice) throws -> RelayEnrollmentCandidate {
    try lifecycle.acceptIPhoneIdentity(device)
  }

  /** Calling this executes only the injected provisioner; construction itself remains inert. */
  public func confirmLocally(_ candidate: RelayEnrollmentCandidate) async throws -> RelayEnrollmentInvitation {
    try await lifecycle.confirmLocally(candidate)
  }

  /** Reissues an expiring phone transfer without provisioning or rotating the active route. */
  public func reissueActiveInvitation() throws -> RelayEnrollmentInvitation {
    try lifecycle.reissueActiveInvitation()
  }

  /** Compensates a route that could not be safely transferred to its approved phone. */
  public func revokeActiveRoute() async throws {
    switch lifecycle.state {
    case .remoteRevokedPendingLocalCleanup:
      try await lifecycle.recoverRevokedCleanup()
    case .compensationPending:
      try await lifecycle.reconcilePendingCompensation()
    default:
      try await lifecycle.revoke()
    }
  }
}

/** A separately sealed opt-in is required before the Host constructs URLSession. */
private enum RelaySignedHostProvisioningActivation {
  private struct Resource: Decodable { let enabled: Bool; let requirement: String }

  static func permitsProvisioning(configuration: RelaySignedHostActivationConfiguration) -> Bool {
    _ = configuration
    guard let url = Bundle.main.url(forResource: "RelayProvisioningActivation", withExtension: "plist"),
          let data = try? Data(contentsOf: url),
          let resource = try? PropertyListDecoder().decode(Resource.self, from: data),
          resource.enabled,
          !resource.requirement.isEmpty
    else { return false }
    return configuration.matchesRunningHostRequirement(resource.requirement)
  }
}
