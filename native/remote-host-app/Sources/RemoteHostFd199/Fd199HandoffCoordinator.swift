import Foundation
import RemoteHostWire

/** The only public effects the hosted child can request from its Host owner. */
public enum Fd199HostedChildOutput: Equatable, Sendable {
  /** The hosted child has bound its relay and signalled `runtime.ready`. */
  case ready
  /** Write one opaque application frame to the connection named by UTF-8 metadata. */
  case send(metadata: Data, payload: Data)
  /** Close the connection named by UTF-8 metadata. */
  case close(metadata: Data)
  /** A public-only durable-device receipt emitted in response to `device.enroll`. */
  case deviceEnrolled(metadata: Data)
  /** Exact durable acknowledgment of a native-finalized epoch. */
  case epochSynchronized(metadata: Data, payload: Data)
}

/**
 The child-process face the handoff coordinator drives. The production
 supervisor conforms in RemoteHostRelay; tests conform with scripted peers.
 */
public protocol Fd199ChildProcessHandle: AnyObject {
  /** Registers the sink for relay-side child outputs. Call before waiting. */
  func setOutputHandler(_ handler: @escaping @Sendable (Fd199HostedChildOutput) -> Void)
  /** Sends one bounded public record into the child's relay wire. */
  func sendPublicRecord(_ record: RemoteWireRecord) throws
  /** Resolves once the post-activation child has signalled V3 `runtime.ready`. */
  func waitUntilReady() throws
  /** Resolves only after the operating-system child has actually exited and been reaped. */
  func waitUntilExited(timeoutMilliseconds: Int32) throws
  /** True once the child's channels have closed (it exited or was stopped). */
  var isClosed: Bool { get }
  /** Stops the child if it is still running. */
  func stop()
}

/**
 Drives the FD199 ownership choreography across child generations:

 1. First spawn: the child recovers an empty journal and admits desktop work.
 2. `activatePhoneSessions()` instructs prepare; the child fences desktop,
    streams a digest-verified export through the native release barrier,
    releases store ownership, and exits.
 3. The coordinator observes the closed channels, respawns an adopter, waits
    for its prepared snapshot to settle, then arms activation; the consuming
    child binds descriptor 198 itself and signals ready.

 Every step fails closed: any supervisor or authority error stops the current
 child and surfaces as a thrown `Fd199HandoffCoordinatorError`.
 */
public final class Fd199HandoffCoordinator: @unchecked Sendable {
  public enum Phase: Equatable, Sendable {
    case idle
    case desktopAdmitted
    case transferringOwnership
    case servingPhoneSessions
  }

  public enum CoordinatorError: Error, Equatable, Sendable {
    case invalidState
    case unavailable
  }

  private let lock = NSLock()
  private let identity: Fd199SigningIdentity
  private let hostAppPath: String
  private let journalDirectory: String
  private let journalFactory: (String, Fd199SigningIdentity) throws -> Fd199Journal
  private let spawn: () throws -> Fd199ChildProcessHandle
  private var authorityService: Fd199AuthorityService?
  private var child: Fd199ChildProcessHandle?
  private var childOutput: (@Sendable (Fd199HostedChildOutput) -> Void)?
  private var phaseValue: Phase = .idle

  public init(
    identity: Fd199SigningIdentity,
    hostAppPath: String,
    journalDirectory: String,
    journalFactory: @escaping (String, Fd199SigningIdentity) throws -> Fd199Journal = { root, identity in
      try Fd199Journal(root: root, identity: identity)
    },
    spawn: @escaping () throws -> Fd199ChildProcessHandle
  ) {
    self.identity = identity
    self.hostAppPath = hostAppPath
    self.journalDirectory = journalDirectory
    self.journalFactory = journalFactory
    self.spawn = spawn
  }

  public private(set) var phase: Phase {
    get { lock.lock(); defer { lock.unlock() }; return phaseValue }
    set { lock.lock(); phaseValue = newValue; lock.unlock() }
  }

  /** A seeded owner is reusable only while its adopted child channels remain open. */
  public var hasLiveChild: Bool {
    let current = lock.withLock { (phaseValue, child) }
    return current.0 == .servingPhoneSessions && current.1?.isClosed == false
  }

  /**
   Installs the one Host-owned receiver for fixed child effects. The receiver
   is retained across the release/relaunch cycle and is never a generic IPC
   endpoint: it can observe only `runtime.ready`, `connection.send`, and
   `connection.close`.
   */
  public func setChildOutputHandler(_ handler: @escaping @Sendable (Fd199HostedChildOutput) -> Void) {
    lock.lock()
    childOutput = handler
    let child = self.child
    lock.unlock()
    child?.setOutputHandler(handler)
  }

  /**
   Writes one bounded public Remote Wire record to the currently owned hosted
   child. The caller must already have completed the FD199 activation gate.
   */
  public func sendPublicRecord(_ record: RemoteWireRecord) throws {
    lock.lock()
    let child = self.child
    let phase = phaseValue
    lock.unlock()
    guard phase == .servingPhoneSessions, let child, !child.isClosed else {
      throw CoordinatorError.invalidState
    }
    try child.sendPublicRecord(record)
  }

  /** Spawns a child; the first owner additionally proves its full desktop Web readiness. */
  public func start(waitForDesktopReady: Bool = true) throws {
    lock.lock()
    // phaseValue read directly: the computed `phase` re-locks this NSLock.
    guard authorityService == nil, phaseValue == .idle || phaseValue == .transferringOwnership else {
      lock.unlock()
      throw CoordinatorError.invalidState
    }
    lock.unlock()

    let child = try spawn()
    let authorityChannel = Fd199AuthorityChannelReader.extractAuthorityChannel(from: child)
    guard let authorityChannel else {
      child.stop()
      throw CoordinatorError.unavailable
    }
    let journal = try journalFactory(journalDirectory, identity)
    let service = Fd199AuthorityService(
      identity: identity,
      hostAppPath: hostAppPath,
      journal: journal,
      channel: authorityChannel
    )
    lock.lock()
    let output = childOutput
    self.child = child
    lock.unlock()
    child.setOutputHandler(output ?? { _ in })
    service.serve()
    lock.lock()
    authorityService = service
    lock.unlock()
    do {
      try waitFor({ service.hasRecovered && (!waitForDesktopReady || service.hasDesktopReady) }, timeoutSeconds: 30)
    } catch {
      service.stop()
      child.stop()
      lock.lock()
      authorityService = nil
      self.child = nil
      lock.unlock()
      throw CoordinatorError.unavailable
    }
    if phase == .idle {
      if waitForDesktopReady, service.recoveredOwnershipStatus == .activated {
        // A restart over an active journal must have restored both its FD198
        // V3 receive loop and its local Web registry before native returns a
        // serving state. This stays distinct from post-transfer readiness.
        do {
          try child.waitUntilReady()
        } catch {
          service.stop()
          child.stop()
          lock.lock()
          authorityService = nil
          self.child = nil
          lock.unlock()
          throw CoordinatorError.unavailable
        }
        phase = .servingPhoneSessions
      } else {
        phase = .desktopAdmitted
      }
    }
  }

  /**
   Runs one complete ownership transfer: prepare, reap the settled child,
   relaunch an adopter over the same journal, then consume activation and wait
   for its V3 relay readiness.
   */
  public func activatePhoneSessions() throws {
    lock.lock()
    guard authorityService != nil, phaseValue == .desktopAdmitted else {
      lock.unlock()
      throw CoordinatorError.invalidState
    }
    let service = authorityService
    let firstChild = child
    lock.unlock()
    guard let service, let firstChild else { throw CoordinatorError.invalidState }

    phase = .transferringOwnership
    do {
      try service.instruct(.prepare)
      // This budget includes draining and streaming, not only process reap.
      // Ordinary readiness retains its separate, shorter deadline.
      try firstChild.waitUntilExited(timeoutMilliseconds: 120_000)
      try service.promoteReapedReleaseToPrepared()
    } catch {
      service.stop()
      firstChild.stop()
      // Leave the coordinator fenced; an ambiguous release cannot admit work.
      throw CoordinatorError.unavailable
    }
    service.stop()
    lock.lock()
    authorityService = nil
    child = nil
    lock.unlock()

    // Relaunch an adopter over the staged journal; it boots fenced on the
    // prepared snapshot and binds nothing until activation consumes.
    try start(waitForDesktopReady: false)

    guard let adopterService = currentAuthority() else { throw CoordinatorError.invalidState }
    try adopterService.instruct(.activate)
    phase = .servingPhoneSessions
    guard let adopter = currentChild() else { throw CoordinatorError.invalidState }
    do {
      try adopter.waitUntilReady()
    } catch {
      stop()
      throw CoordinatorError.unavailable
    }
  }

  /** Stops the current child and its authority service. */
  public func stop() {
    lock.lock()
    let service = authorityService
    let child = self.child
    authorityService = nil
    self.child = nil
    lock.unlock()
    service?.stop()
    child?.stop()
    phase = .idle
  }

  private func currentAuthority() -> Fd199AuthorityService? {
    lock.lock()
    defer { lock.unlock() }
    return authorityService
  }

  private func currentChild() -> Fd199ChildProcessHandle? {
    lock.lock()
    defer { lock.unlock() }
    return child
  }

  private func waitFor(_ condition: () -> Bool, timeoutSeconds: Double) throws {
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
      if condition() { return }
      usleep(5_000)
    }
    throw CoordinatorError.unavailable
  }
}

/**
 Extraction seam: production handles expose their authority end through
 `Fd199HostedChildSupervisor.takeAuthorityChannel()`; this reader keeps the
 coordinator decoupled from the concrete supervisor type.
 */
public enum Fd199AuthorityChannelReader {
  public static func extractAuthorityChannel(from child: Fd199ChildProcessHandle) -> FileHandle? {
    (child as? Fd199AuthorityChannelProviding)?.takeAuthorityChannel()
  }
}

/** A child process able to surrender its authority-channel parent end. */
public protocol Fd199AuthorityChannelProviding: Fd199ChildProcessHandle {
  func takeAuthorityChannel() -> FileHandle?
}
