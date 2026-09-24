import Foundation
import CryptoKit
import RemoteHostWire
import RemoteHostXChaCha

/** Closed failures for the local, signed-Host enrollment controller. */
public enum RelayEnrollmentError: Error, Equatable, Sendable {
  case invalidInput
  case unavailable
  case notPending
  case expired
  case capacityExceeded
  case directoryRejected
}

/** Public iPhone identity scanned or entered during a physical-local pairing flow. */
public struct RelayEnrollmentDevice: Equatable, Sendable {
  public let deviceId: String
  public let label: String
  public let signingPublicKey: String
  public let agreementPublicKey: String

  public init(deviceId: String, label: String, signingPublicKey: String, agreementPublicKey: String) throws {
    guard matches(routeID, deviceId), validLabel(label), canonicalX25519(signingPublicKey), canonicalX25519(agreementPublicKey), signingPublicKey != agreementPublicKey else {
      throw RelayEnrollmentError.invalidInput
    }
    self.deviceId = deviceId
    self.label = label
    self.signingPublicKey = signingPublicKey
    self.agreementPublicKey = agreementPublicKey
  }
}

/**
 * Strict, public-only enrollment offer imported by a person at the signed Host.
 * It has no route, token, private key, or instruction field.
 */
public enum RelayEnrollmentOfferCodec {
  private static let maximumOfferBytes = 4 * 1024

  /** Decodes exactly one bounded iPhone public enrollment offer. */
  public static func decode(_ data: Data) throws -> RelayEnrollmentDevice {
    guard !data.isEmpty, data.count <= maximumOfferBytes,
          let object = try? strictJSONObject(data),
          Set(object.keys) == Set(["deviceId", "label", "signingPublicKey", "agreementPublicKey"]),
          let deviceId = object["deviceId"] as? String,
          let label = object["label"] as? String,
          let signingPublicKey = object["signingPublicKey"] as? String,
          let agreementPublicKey = object["agreementPublicKey"] as? String
    else { throw RelayEnrollmentError.invalidInput }
    return try RelayEnrollmentDevice(deviceId: deviceId, label: label, signingPublicKey: signingPublicKey, agreementPublicKey: agreementPublicKey)
  }

  /** Full SHA-256 fingerprint of the canonical public offer for local comparison. */
  public static func fingerprint(_ device: RelayEnrollmentDevice) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: [
      "deviceId": device.deviceId,
      "label": device.label,
      "signingPublicKey": device.signingPublicKey,
      "agreementPublicKey": device.agreementPublicKey,
    ], options: [.sortedKeys])
    let hex = SHA256.hash(data: data).map { String(format: "%02X", $0) }.joined()
    return stride(from: 0, to: hex.count, by: 4).map { index in
      String(hex.dropFirst(index).prefix(4))
    }.joined(separator: "-")
  }
}

/** Exact public facts rendered before a person confirms an imported offer. */
public struct RelayEnrollmentOfferPreview: Equatable, Sendable {
  public let label: String
  public let fingerprint: String
}

/**
 * Local interaction boundary for a selected public offer. Merely constructing
 * or inspecting it has no effect. Exactly one explicit confirmation may pass
 * its public device tuple to the signed Host's pending-candidate action.
 */
public final class RelayLocalEnrollmentOfferReview {
  public let preview: RelayEnrollmentOfferPreview
  private let device: RelayEnrollmentDevice
  private var confirmed = false

  public init(importedOffer: Data) throws {
    let device = try RelayEnrollmentOfferCodec.decode(importedOffer)
    self.device = device
    preview = try RelayEnrollmentOfferPreview(label: device.label, fingerprint: RelayEnrollmentOfferCodec.fingerprint(device))
  }

  public func confirm(recordPendingCandidate: (RelayEnrollmentDevice) throws -> Void) throws {
    guard !confirmed else { throw RelayEnrollmentError.notPending }
    try recordPendingCandidate(device)
    confirmed = true
  }
}

/** Public record returned after the Host has durably accepted one device identity. */
public struct RelayEnrollmentDeviceRecord: Equatable, Sendable {
  public let deviceId: String
  public let enrollmentId: String
  public let hostEnrollmentId: String
  public let label: String
  public let signingPublicKey: String
  public let agreementPublicKey: String
  public let enrolledAt: String

  public init(deviceId: String, enrollmentId: String, hostEnrollmentId: String, label: String, signingPublicKey: String, agreementPublicKey: String, enrolledAt: String) throws {
    guard matches(routeID, deviceId), matches(routeID, enrollmentId), matches(routeID, hostEnrollmentId), validLabel(label), canonicalX25519(signingPublicKey), canonicalX25519(agreementPublicKey), signingPublicKey != agreementPublicKey, canonicalInstant(enrolledAt) != nil else {
      throw RelayEnrollmentError.invalidInput
    }
    self.deviceId = deviceId
    self.enrollmentId = enrollmentId
    self.hostEnrollmentId = hostEnrollmentId
    self.label = label
    self.signingPublicKey = signingPublicKey
    self.agreementPublicKey = agreementPublicKey
    self.enrolledAt = enrolledAt
  }
}

/** Signed-native durable public-device directory used after local confirmation. */
public protocol RelayEnrollmentDirectory: Sendable {
  /** Persists one locally confirmed public device identity and returns its Host-minted enrollment incarnation. */
  func enroll(_ device: RelayEnrollmentDevice) throws -> RelayEnrollmentDeviceRecord
}

/** Exact FD198 records for the private local device-directory confirmation handoff. */
public enum RelayEnrollmentWireCodec {
  /** Decodes the exact empty-payload Host-to-runtime enrollment request. */
  public static func enrollmentRequest(_ record: RemoteWireRecord) throws -> RelayEnrollmentDevice {
    guard record.kind == .deviceEnroll, record.payload.isEmpty,
          let object = try? strictJSONObject(record.metadata),
          Set(object.keys) == Set(["deviceId", "label", "signingPublicKey", "agreementPublicKey"]),
          let deviceId = object["deviceId"] as? String,
          let label = object["label"] as? String,
          let signingPublicKey = object["signingPublicKey"] as? String,
          let agreementPublicKey = object["agreementPublicKey"] as? String
    else { throw RelayEnrollmentError.invalidInput }
    return try RelayEnrollmentDevice(deviceId: deviceId, label: label, signingPublicKey: signingPublicKey, agreementPublicKey: agreementPublicKey)
  }

  /** Emits the empty-payload Host-to-runtime enrollment request. */
  public static func enroll(_ device: RelayEnrollmentDevice) throws -> RemoteWireRecord {
    let metadata = try JSONSerialization.data(withJSONObject: [
      "deviceId": device.deviceId, "label": device.label,
      "signingPublicKey": device.signingPublicKey, "agreementPublicKey": device.agreementPublicKey,
    ], options: [.sortedKeys])
    return RemoteWireRecord(kind: .deviceEnroll, metadata: metadata)
  }

  /** Decodes the exact empty-payload runtime confirmation after durable local enrollment. */
  public static func enrolled(_ record: RemoteWireRecord, enrolledAt: String) throws -> RelayEnrollmentDeviceRecord {
    try decodePublicLifetime(record, expectedKind: .deviceEnrolled, recordedAt: enrolledAt)
  }

  /**
   Decodes the exact FD199-gated Host-to-child seed. It has the same public
   facts as the child receipt, but never contains a route capability.
   */
  public static func enrollmentSeed(_ record: RemoteWireRecord, seededAt: String) throws -> RelayEnrollmentDeviceRecord {
    try decodePublicLifetime(record, expectedKind: .enrollmentSeed, recordedAt: seededAt)
  }

  private static func decodePublicLifetime(
    _ record: RemoteWireRecord, expectedKind: RemoteWireKind, recordedAt: String
  ) throws -> RelayEnrollmentDeviceRecord {
    guard record.kind == expectedKind, record.payload.isEmpty,
          let object = try? strictJSONObject(record.metadata),
          Set(object.keys) == Set(["deviceId", "label", "signingPublicKey", "agreementPublicKey", "deviceEnrollmentId", "hostEnrollmentId"]),
          let deviceId = object["deviceId"] as? String, let label = object["label"] as? String,
          let signingPublicKey = object["signingPublicKey"] as? String, let agreementPublicKey = object["agreementPublicKey"] as? String,
          let deviceEnrollmentId = object["deviceEnrollmentId"] as? String, let hostEnrollmentId = object["hostEnrollmentId"] as? String
    else { throw RelayEnrollmentError.invalidInput }
    return try RelayEnrollmentDeviceRecord(deviceId: deviceId, enrollmentId: deviceEnrollmentId, hostEnrollmentId: hostEnrollmentId, label: label, signingPublicKey: signingPublicKey, agreementPublicKey: agreementPublicKey, enrolledAt: recordedAt)
  }
}

/**
 Validates that a hosted child has recovered the exact enrollment lifetime
 already committed into the phone invitation and relay credential. A child is
 not permitted to substitute newly minted directory incarnations during Host
 activation: doing so would make its FD198 route disagree with the encrypted
 transport's authenticated peer claims.
 */
public enum RelayHostedChildEnrollmentReconciliation {
  public static func validate(
    _ receipt: RemoteWireRecord,
    credential: RelayRouteCredential,
    expectedLabel: String,
    enrolledAt: String
  ) throws {
    let enrolled = try RelayEnrollmentWireCodec.enrolled(receipt, enrolledAt: enrolledAt)
    guard enrolled.deviceId == credential.deviceId,
          enrolled.enrollmentId == credential.deviceEnrollmentId,
          enrolled.hostEnrollmentId == credential.hostEnrollmentId,
          enrolled.label == expectedLabel,
          enrolled.signingPublicKey == credential.deviceSigningPublicKey,
          enrolled.agreementPublicKey == credential.deviceAgreementPublicKey
    else { throw RelayEnrollmentError.directoryRejected }
  }
}

/** Public Host facts pinned by a V3 invitation. Private Host identity bytes never enter this value. */
public struct RelayEnrollmentHostIdentity: Equatable, Sendable {
  public let hostDeviceId: String
  public let agreementPublicKey: String

  public init(hostDeviceId: String, agreementPublicKey: String) throws {
    guard matches(routeID, hostDeviceId), canonicalX25519(agreementPublicKey) else { throw RelayEnrollmentError.invalidInput }
    self.hostDeviceId = hostDeviceId
    self.agreementPublicKey = agreementPublicKey
  }
}

/** Opaque local receipt. A Host UI must explicitly confirm this receipt before an invitation exists. */
public struct RelayEnrollmentCandidate: Equatable, Sendable {
  public let confirmationId: String
  public let deviceId: String
  public let label: String

  fileprivate init(confirmationId: String, deviceId: String, label: String) {
    self.confirmationId = confirmationId
    self.deviceId = deviceId
    self.label = label
  }
}

/** Phone-transferable V3 route configuration. It contains no Host capability or private key. */
public struct RelayEnrollmentInvitation: Equatable, Sendable {
  public let version: Int
  public let routeId: String
  public let routeGeneration: Int
  public let connectionEpoch: Int
  public let clientAuthToken: String
  public let expiresAt: String
  public let hostDeviceId: String
  public let hostEnrollmentId: String
  public let hostStaticAgreementPublicKey: String
  public let deviceId: String
  public let deviceEnrollmentId: String
  public let deviceSigningPublicKey: String
  public let deviceAgreementPublicKey: String
}

public enum RelayPhoneInvitationCodec {
  public static func encode(_ invitation: RelayEnrollmentInvitation) throws -> Data {
    try JSONSerialization.data(withJSONObject: ["version": invitation.version, "routeId": invitation.routeId, "routeGeneration": invitation.routeGeneration, "connectionEpoch": invitation.connectionEpoch, "clientAuthToken": invitation.clientAuthToken, "expiresAt": invitation.expiresAt, "hostDeviceId": invitation.hostDeviceId, "hostEnrollmentId": invitation.hostEnrollmentId, "hostStaticAgreementPublicKey": invitation.hostStaticAgreementPublicKey, "deviceId": invitation.deviceId, "deviceEnrollmentId": invitation.deviceEnrollmentId, "deviceSigningPublicKey": invitation.deviceSigningPublicKey, "deviceAgreementPublicKey": invitation.deviceAgreementPublicKey], options: [.sortedKeys])
  }
}

/** Issues the short-lived phone transfer from a Keychain-held active route only. */
public enum RelayActiveRouteInvitationIssuer {
  public static func issue(route: RelayRouteCredential, host: RelayEnrollmentHostIdentity, connectionEpoch: Int = 1, now: Date = Date()) throws -> RelayEnrollmentInvitation {
    guard route.hostDeviceId == host.hostDeviceId else { throw RelayEnrollmentError.invalidInput }
    return try RelayEnrollmentInvitation(route: route, connectionEpoch: connectionEpoch, expiresAt: canonicalString(now.addingTimeInterval(5 * 60)), hostAgreementPublicKey: host.agreementPublicKey)
  }
}

/** Entropy source constrained to fixed opaque local-enrollment identifiers and role tokens. */
public protocol RelayEnrollmentRandom: Sendable {
  func bytes(count: Int) throws -> Data
}

/** System entropy source for the signed Host process. */
public struct RelaySystemEnrollmentRandom: RelayEnrollmentRandom {
  private let source = RelaySystemRandom()
  public init() {}
  public func bytes(count: Int) throws -> Data { try source.bytes(count: count) }
}

/**
 * Signed-Host-only local enrollment state. It does not listen, connect, provision,
 * activate a relay route, expose route secrets, or persist a private credential.
 */
public final class RelayEnrollmentController: @unchecked Sendable {
  private struct PendingCandidate {
    let device: RelayEnrollmentDevice
    let expiresAt: Date
  }
  private struct PendingRoute {
    let credential: RelayRouteCredential
    let expiresAt: Date
  }

  private static let maximumPending = 32
  private static let lifetime: TimeInterval = 5 * 60
  private let lock = NSLock()
  private let host: RelayEnrollmentHostIdentity
  private let directory: RelayEnrollmentDirectory
  private let random: RelayEnrollmentRandom
  private let now: () -> Date
  private var candidates: [String: PendingCandidate] = [:]
  private var candidateOrder: [String] = []
  private var routes: [String: PendingRoute] = [:]
  private var routeOrder: [String] = []
  private var acceptedReceipts: [String: Date] = [:]

  /** @param host - Public identity returned by the protected signed-Host identity owner. */
  public init(host: RelayEnrollmentHostIdentity, directory: RelayEnrollmentDirectory, random: RelayEnrollmentRandom = RelaySystemEnrollmentRandom(), now: @escaping () -> Date = Date.init) {
    self.host = host
    self.directory = directory
    self.random = random
    self.now = now
  }

  /** Accepts a phone public identity without enrolling it or minting relay credentials. */
  public func acceptIPhoneIdentity(_ device: RelayEnrollmentDevice) throws -> RelayEnrollmentCandidate {
    lock.lock(); defer { lock.unlock() }
    dropExpired(at: now())
    guard candidates.count < Self.maximumPending else { throw RelayEnrollmentError.capacityExceeded }
    guard device.deviceId != host.hostDeviceId else { throw RelayEnrollmentError.invalidInput }
    let confirmationId = try newOpaqueIdentifier(excluding: Set(candidates.keys))
    let candidate = PendingCandidate(device: device, expiresAt: expiry(from: now()))
    candidates[confirmationId] = candidate
    candidateOrder.append(confirmationId)
    return RelayEnrollmentCandidate(confirmationId: confirmationId, deviceId: device.deviceId, label: device.label)
  }

  /** Internal test seam for an unprovisioned confirmation. Production callers use RelayEnrollmentLifecycle. */
  func confirmLocally(_ candidate: RelayEnrollmentCandidate) throws -> RelayEnrollmentInvitation {
    try prepareLocally(candidate).invitation
  }

  /** Reissues only the phone-safe invitation for an existing active route. */
  func reissueInvitation(for credential: RelayRouteCredential, connectionEpoch: Int = 1) throws -> RelayEnrollmentInvitation {
    lock.lock(); defer { lock.unlock() }
    return try RelayActiveRouteInvitationIssuer.issue(route: credential, host: host, connectionEpoch: connectionEpoch, now: now())
  }

  /**
   * Consumes a local confirmation and returns native-only route material for the
   * signed-Host lifecycle. The associated invitation has no Host capability.
   */
  func prepareLocally(_ candidate: RelayEnrollmentCandidate) throws -> RelayEnrollmentPreparedRoute {
    lock.lock(); defer { lock.unlock() }
    let issuedAt = now()
    dropExpired(at: issuedAt)
    guard let pending = candidates.removeValue(forKey: candidate.confirmationId), candidate.deviceId == pending.device.deviceId, candidate.label == pending.device.label else { throw RelayEnrollmentError.notPending }
    candidateOrder.removeAll { $0 == candidate.confirmationId }
    guard pending.expiresAt > issuedAt else { throw RelayEnrollmentError.expired }
    guard routes.count < Self.maximumPending else { throw RelayEnrollmentError.capacityExceeded }
    let enrolled: RelayEnrollmentDeviceRecord
    do { enrolled = try directory.enroll(pending.device) }
    catch { throw RelayEnrollmentError.directoryRejected }
    guard enrolled.deviceId == pending.device.deviceId, enrolled.label == pending.device.label,
          enrolled.signingPublicKey == pending.device.signingPublicKey, enrolled.agreementPublicKey == pending.device.agreementPublicKey,
          matches(routeID, enrolled.enrollmentId), matches(routeID, enrolled.hostEnrollmentId) else { throw RelayEnrollmentError.directoryRejected }
    let receipt = receiptKey(enrolled)
    guard acceptedReceipts[receipt] == nil else { throw RelayEnrollmentError.directoryRejected }
    let routeId = try newOpaqueIdentifier(excluding: Set(routes.keys))
    var hostToken = try random.bytes(count: 24)
    var deviceToken = try random.bytes(count: 24)
    defer { XChaCha.zeroize(&hostToken); XChaCha.zeroize(&deviceToken) }
    let credential: RelayRouteCredential
    do {
      credential = try RelayRouteCredential(routeId: routeId, hostDeviceId: host.hostDeviceId, hostEnrollmentId: enrolled.hostEnrollmentId, deviceId: enrolled.deviceId, deviceEnrollmentId: enrolled.enrollmentId, deviceSigningPublicKey: enrolled.signingPublicKey, deviceAgreementPublicKey: enrolled.agreementPublicKey, generation: 1, hostToken: relayBase64url(hostToken), deviceToken: relayBase64url(deviceToken))
    } catch { throw RelayEnrollmentError.unavailable }
    let expiresAt = expiry(from: issuedAt)
    routes[routeId] = PendingRoute(credential: credential, expiresAt: expiresAt)
    routeOrder.append(routeId)
    acceptedReceipts[receipt] = expiresAt
    return try RelayEnrollmentPreparedRoute(
      credential: credential,
      invitation: RelayEnrollmentInvitation(route: credential, connectionEpoch: 1, expiresAt: canonicalString(expiresAt), hostAgreementPublicKey: host.agreementPublicKey),
    )
  }

  /** Removes an unprovisioned route after a failed native lifecycle operation. */
  func discardPreparedRoute(routeId: String) {
    lock.lock(); defer { lock.unlock() }
    routes.removeValue(forKey: routeId)
    routeOrder.removeAll { $0 == routeId }
  }

  /// Internal test/activation seam. It never returns a credential or a secret to a caller.
  func pendingRouteCountForTest() -> Int { lock.lock(); defer { lock.unlock() }; dropExpired(at: now()); return routes.count }

  private func dropExpired(at instant: Date) {
    for (id, pending) in candidates where pending.expiresAt <= instant { candidates.removeValue(forKey: id) }
    candidateOrder.removeAll { candidates[$0] == nil }
    for (id, pending) in routes where pending.expiresAt <= instant { routes.removeValue(forKey: id) }
    routeOrder.removeAll { routes[$0] == nil }
    for (receipt, expiresAt) in acceptedReceipts where expiresAt <= instant { acceptedReceipts.removeValue(forKey: receipt) }
  }

  private func expiry(from issuedAt: Date) -> Date { issuedAt.addingTimeInterval(Self.lifetime) }

  private func newOpaqueIdentifier(excluding: Set<String>) throws -> String {
    for _ in 0..<8 {
      var value = try random.bytes(count: 24)
      defer { XChaCha.zeroize(&value) }
      let identifier = relayBase64url(value)
      if matches(routeID, identifier), !excluding.contains(identifier) { return identifier }
    }
    throw RelayEnrollmentError.unavailable
  }

  private func receiptKey(_ record: RelayEnrollmentDeviceRecord) -> String {
    [record.deviceId, record.enrollmentId, record.hostEnrollmentId, record.label, record.signingPublicKey, record.agreementPublicKey].joined(separator: "\u{0}")
  }
}

/**
 * Native-only result of one confirmed runtime enrollment receipt. It must not
 * cross Remote Wire, a renderer bridge, or a phone invitation API.
 */
struct RelayEnrollmentPreparedRoute: Sendable {
  let credential: RelayRouteCredential
  let invitation: RelayEnrollmentInvitation
}

private extension RelayEnrollmentInvitation {
  init(route: RelayRouteCredential, connectionEpoch: Int, expiresAt: String, hostAgreementPublicKey: String) throws {
    guard canonicalInstant(expiresAt) != nil, canonicalX25519(hostAgreementPublicKey), connectionEpoch >= 1, connectionEpoch <= 2_147_483_647 else { throw RelayEnrollmentError.invalidInput }
    version = 3
    routeId = route.routeId
    routeGeneration = route.generation
    self.connectionEpoch = connectionEpoch
    clientAuthToken = route.deviceToken
    self.expiresAt = expiresAt
    hostDeviceId = route.hostDeviceId
    hostEnrollmentId = route.hostEnrollmentId
    hostStaticAgreementPublicKey = hostAgreementPublicKey
    deviceId = route.deviceId
    deviceEnrollmentId = route.deviceEnrollmentId
    deviceSigningPublicKey = route.deviceSigningPublicKey
    deviceAgreementPublicKey = route.deviceAgreementPublicKey
  }
}

private func validLabel(_ value: String) -> Bool {
  !value.isEmpty && value == value.trimmingCharacters(in: .whitespacesAndNewlines) && value.utf8.count <= 64 && !value.unicodeScalars.contains { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) }
}

private func canonicalInstant(_ value: String) -> Date? {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  guard let date = formatter.date(from: value) else { return nil }
  return canonicalString(date) == value ? date : nil
}

private func canonicalString(_ value: Date) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: value)
}

private func relayBase64url(_ value: Data) -> String {
  value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
