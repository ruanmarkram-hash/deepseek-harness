import Foundation

private let remoteHostKeychainServiceName = "com.deepseek.dsh.remote-host.keychain"

/** Fixed coordinator calls accepted only from the sealed Host app. */
@objc private protocol RemoteHostKeychainEpochXPC {
  func acquireEpochLease(forRouteId routeId: String, withReply reply: @escaping (Bool) -> Void)
  func releaseEpochLease(forRouteId routeId: String, withReply reply: @escaping () -> Void)
  func beginEpochTransaction(forRouteId routeId: String, withReply reply: @escaping (Bool) -> Void)
  func endEpochTransaction(forRouteId routeId: String, withReply reply: @escaping () -> Void)
}

private struct RemoteHostKeychainServiceRequirement: Decodable { let requirement: String }

/**
 * A long-lived, sealed XPC connection that owns route epoch admission.
 *
 * The helper ties ownership to this connection, not a pathname or a value
 * returned to the Host. An XPC invalidation therefore releases every lease
 * after a Host crash without exposing a general-purpose RPC surface.
 */
public final class RelayConnectionEpochXPCCoordinator: @unchecked Sendable, RelayConnectionEpochCoordinator {
  private let connection: NSXPCConnection
  private let lock = NSLock()
  private var released = false

  private init(requirement: String) {
    connection = NSXPCConnection(serviceName: remoteHostKeychainServiceName)
    connection.remoteObjectInterface = NSXPCInterface(with: RemoteHostKeychainEpochXPC.self)
    connection.setCodeSigningRequirement(requirement)
    connection.resume()
  }

  /** Opens the one coordinator embedded in this exact signed Host bundle. */
  public static func openSealedHostConnection() throws -> RelayConnectionEpochXPCCoordinator {
    guard let resource = Bundle.main.url(forResource: "RemoteHostKeychainServiceRequirement", withExtension: "plist"),
          let data = try? Data(contentsOf: resource),
          let value = try? PropertyListDecoder().decode(RemoteHostKeychainServiceRequirement.self, from: data),
          !value.requirement.isEmpty
    else { throw RelayOwnerError.unavailable }
    return RelayConnectionEpochXPCCoordinator(requirement: value.requirement)
  }

  public func acquireLease(routeId: String) throws -> any RelayConnectionEpochCoordinatorLease {
    let acquired = callBoolean { proxy, reply in proxy.acquireEpochLease(forRouteId: routeId, withReply: reply) }
    guard matches(routeID, routeId), acquired else {
      throw RelayOwnerError.unavailable
    }
    return Lease(owner: self, routeId: routeId)
  }

  public func withTransaction<T: Sendable>(routeId: String, _ operation: () throws -> T) throws -> T {
    let admitted = callBoolean { proxy, reply in proxy.beginEpochTransaction(forRouteId: routeId, withReply: reply) }
    guard matches(routeID, routeId), admitted else {
      throw RelayOwnerError.unavailable
    }
    defer { callVoid { proxy, reply in proxy.endEpochTransaction(forRouteId: routeId, withReply: reply) } }
    return try operation()
  }

  fileprivate func releaseLease(routeId: String) {
    callVoid { proxy, reply in proxy.releaseEpochLease(forRouteId: routeId, withReply: reply) }
  }

  private func callBoolean(_ request: (RemoteHostKeychainEpochXPC, @escaping (Bool) -> Void) -> Void) -> Bool {
    let completion = DispatchSemaphore(value: 0)
    let response = EpochBooleanResponse()
    guard !lock.withLock({ released }), let proxy = connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in self?.invalidate(); completion.signal() }) as? RemoteHostKeychainEpochXPC else { return false }
    request(proxy) { value in response.set(value); completion.signal() }
    guard completion.wait(timeout: .now() + .seconds(5)) == .success else { invalidate(); return false }
    return response.value
  }

  private func callVoid(_ request: (RemoteHostKeychainEpochXPC, @escaping () -> Void) -> Void) {
    let completion = DispatchSemaphore(value: 0)
    guard !lock.withLock({ released }), let proxy = connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in self?.invalidate(); completion.signal() }) as? RemoteHostKeychainEpochXPC else { return }
    request(proxy) { completion.signal() }
    if completion.wait(timeout: .now() + .seconds(5)) != .success { invalidate() }
  }

  private func invalidate() {
    let shouldInvalidate = lock.withLock { () -> Bool in
      guard !released else { return false }
      released = true
      return true
    }
    if shouldInvalidate { connection.invalidate() }
  }

  deinit {
    invalidate()
  }

  private final class Lease: @unchecked Sendable, RelayConnectionEpochCoordinatorLease {
    private let lock = NSLock()
    private weak var owner: RelayConnectionEpochXPCCoordinator?
    private let routeId: String
    private var released = false
    init(owner: RelayConnectionEpochXPCCoordinator, routeId: String) { self.owner = owner; self.routeId = routeId }
    func release() {
      let value: RelayConnectionEpochXPCCoordinator? = lock.withLock {
        guard !released else { return nil }
        released = true
        return owner
      }
      value?.releaseLease(routeId: routeId)
    }
    deinit { release() }
  }
}

private final class EpochBooleanResponse: @unchecked Sendable {
  private let lock = NSLock()
  private var result = false
  var value: Bool { lock.withLock { result } }
  func set(_ value: Bool) { lock.withLock { result = value } }
}

/** Process-local coordinator used only by memory-backed unit stores. */
public final class RelayConnectionEpochInMemoryCoordinator: @unchecked Sendable, RelayConnectionEpochCoordinator {
  private final class RouteState {
    let lock = NSLock()
    var owner: UUID?
  }
  private static let registryLock = NSLock()
  nonisolated(unsafe) private static var routes: [String: RouteState] = [:]
  private let scope: String
  public init(scope: String = UUID().uuidString) { self.scope = scope }
  private func state(routeId: String) -> RouteState {
    Self.registryLock.withLock {
      let key = scope + "." + routeId
      if let state = Self.routes[key] { return state }
      let state = RouteState(); Self.routes[key] = state; return state
    }
  }
  public func acquireLease(routeId: String) throws -> any RelayConnectionEpochCoordinatorLease {
    let state = state(routeId: routeId); let identifier = UUID()
    let acquired = state.lock.withLock { () -> Bool in guard state.owner == nil else { return false }; state.owner = identifier; return true }
    guard acquired else { throw RelayOwnerError.unavailable }
    return MemoryLease(state: state, identifier: identifier)
  }
  public func withTransaction<T: Sendable>(routeId: String, _ operation: () throws -> T) throws -> T {
    try state(routeId: routeId).lock.withLock(operation)
  }
  private final class MemoryLease: @unchecked Sendable, RelayConnectionEpochCoordinatorLease {
    private let lock = NSLock(); private let state: RouteState; private let identifier: UUID; private var released = false
    init(state: RouteState, identifier: UUID) { self.state = state; self.identifier = identifier }
    func release() { lock.withLock { guard !released else { return }; released = true; state.lock.withLock { if state.owner == identifier { state.owner = nil } } } }
    deinit { release() }
  }
}
