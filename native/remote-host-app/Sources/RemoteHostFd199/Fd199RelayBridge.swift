import Foundation
import RemoteHostWire

/**
 Bidirectional pump between one phone-session owner and the hosted child's
 descriptor-198 relay wire.

 The session owner speaks four callbacks (a phone connection opened, one
 frame arrived, a connection closed, and enrollment/route/epoch facts); the
 bridge encodes them as bounded Remote Wire records into the child while
 forwarding child-originated `connection.send` / `connection.close` effects
 back out. It holds no credentials and never opens a socket.
 */
public final class Fd199RelayBridge: @unchecked Sendable {
  /** The session-owner face the Host's relay composition implements. */
  public protocol SessionOwner: AnyObject {
    /** The child accepted this authenticated connection. */
    func hostedChildDidOpen(metadata: Data)
    /** One decrypted application frame arrived from the hosted child. */
    func hostedChildDidSend(metadata: Data, payload: Data)
    /** The hosted child closed this connection. */
    func hostedChildDidClose(metadata: Data)
  }

  private let lock = NSLock()
  private let encodeRecord: (RemoteWireRecord) throws -> Void
  private var owner: SessionOwner?

  /**
   - Parameters:
     - sendIntoChild: Encodes one record into the child's descriptor 198.
       Failures close the bridge rather than queueing unbounded frames.
     - owner: Receives child-originated connection effects.
   */
  public init(sendIntoChild: @escaping (RemoteWireRecord) throws -> Void, owner: SessionOwner?) {
    self.encodeRecord = sendIntoChild
    self.owner = owner
  }

  // MARK: - Session-owner inbound

  public func connectionOpened(metadata: Data) throws {
    try send(RemoteWireRecord(kind: .connectionOpen, metadata: metadata))
  }

  public func frameArrived(metadata: Data, payload: Data) throws {
    try send(RemoteWireRecord(kind: .connectionFrame, metadata: metadata, payload: payload))
  }

  public func connectionClosed(metadata: Data) throws {
    try send(RemoteWireRecord(kind: .connectionClosed, metadata: metadata))
  }

  public func deviceEnroll(deviceId: String, label: String, signingPublicKey: String, agreementPublicKey: String) throws {
    try send(RemoteWireRecord(
      kind: .deviceEnroll,
      metadata: try metadata([
        "deviceId": deviceId, "label": label,
        "signingPublicKey": signingPublicKey, "agreementPublicKey": agreementPublicKey,
      ])
    ))
  }

  /**
   Seeds the exact pre-confirmed public enrollment lifetime into the adopted
   child. The coordinator only permits this FD198 write after FD199 activation;
   route tokens, private keys, and relay capabilities are intentionally absent.
   */
  public func enrollmentSeed(
    deviceId: String, label: String, signingPublicKey: String, agreementPublicKey: String,
    deviceEnrollmentId: String, hostEnrollmentId: String
  ) throws {
    try send(RemoteWireRecord(
      kind: .enrollmentSeed,
      metadata: try metadata([
        "deviceId": deviceId, "label": label,
        "signingPublicKey": signingPublicKey, "agreementPublicKey": agreementPublicKey,
        "deviceEnrollmentId": deviceEnrollmentId, "hostEnrollmentId": hostEnrollmentId,
      ])
    ))
  }

  public func routeUpsert(
    routeId: String, deviceId: String, deviceEnrollmentId: String,
    hostDeviceId: String, hostEnrollmentId: String, generation: Int
  ) throws {
    try send(RemoteWireRecord(
      kind: .routeUpsert,
      metadata: try metadata([
        "routeId": routeId, "deviceId": deviceId, "deviceEnrollmentId": deviceEnrollmentId,
        "hostDeviceId": hostDeviceId, "hostEnrollmentId": hostEnrollmentId, "generation": generation,
      ])
    ))
  }

  public func epochBegin(deviceId: String) throws {
    try send(RemoteWireRecord(kind: .epochBegin, metadata: try metadata(["deviceId": deviceId])))
  }

  public func epochCommit(deviceId: String, epoch: Int) throws {
    try send(RemoteWireRecord(kind: .epochCommit, metadata: try metadata(["deviceId": deviceId, "connectionEpoch": epoch])))
  }

  /**
   Forwards one decrypted phone-originated application record after the Host
   transport has authenticated it. Enrollment, route, and epoch authority
   remain native-only methods above; a phone may drive only connection facts.
   */
  public func phoneRecord(_ record: RemoteWireRecord) throws {
    switch record.kind {
    case .connectionOpen, .connectionFrame, .connectionClosed:
      try send(record)
    case .runtimeReady, .routeUpsert, .routeRevoked, .epochBegin, .epochBegun,
         .epochCommit, .epochCommitted, .connectionSend, .connectionClose,
         .hostStopping, .deviceEnroll, .deviceEnrolled, .enrollmentSeed, .epochSynchronize, .epochSynchronized:
      throw Fd199BridgeError.invalidPhoneRecord
    }
  }

  // MARK: - Child-originated

  /** Feeds one decoded child record; unknown kinds are ignored. */
  public func childRecord(_ record: RemoteWireRecord) {
    lock.lock()
    let owner = self.owner
    lock.unlock()
    guard let owner else { return }
    switch record.kind {
    case .runtimeReady:
      owner.hostedChildDidOpen(metadata: Data())
    case .connectionSend:
      owner.hostedChildDidOpen(metadata: record.metadata)
      owner.hostedChildDidSend(metadata: record.metadata, payload: record.payload)
    case .connectionClose:
      owner.hostedChildDidClose(metadata: record.metadata)
    default:
      break
    }
  }

  /** Detaches the session owner; later child effects are dropped. */
  public func detachOwner() {
    lock.lock()
    owner = nil
    lock.unlock()
  }

  private func send(_ record: RemoteWireRecord) throws {
    lock.lock()
    let hasOwner = owner != nil
    lock.unlock()
    guard hasOwner else { throw Fd199BridgeError.detached }
    try encodeRecord(record)
  }

  private func metadata(_ dictionary: [String: Any]) throws -> Data {
    guard JSONSerialization.isValidJSONObject(dictionary),
          let data = try? JSONSerialization.data(withJSONObject: dictionary)
    else { throw Fd199BridgeError.invalidMetadata }
    return data
  }
}

public enum Fd199BridgeError: Error, Equatable, Sendable {
  case detached
  case invalidMetadata
  case invalidPhoneRecord
}
