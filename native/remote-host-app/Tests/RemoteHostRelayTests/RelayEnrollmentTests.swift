import Foundation
import Testing
@testable import RemoteHostRelay
@testable import RemoteHostWire
import Darwin

private let enrollmentHostId = String(repeating: "h", count: 16)
private let enrollmentHostIncarnation = String(repeating: "i", count: 16)
private let enrollmentDeviceId = String(repeating: "d", count: 16)
private let enrollmentDeviceIncarnation = String(repeating: "e", count: 16)

private func enrollmentB64(_ byte: UInt8) -> String {
  Data(repeating: byte, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

private let enrollmentSigning = enrollmentB64(9)
private let enrollmentAgreement = enrollmentB64(8)
private let enrollmentHostAgreement = enrollmentB64(7)

private final class EnrollmentRandom: @unchecked Sendable, RelayEnrollmentRandom {
  private var next: UInt8 = 1
  func bytes(count: Int) throws -> Data {
    let value = next
    next &+= 1
    return Data(repeating: value, count: count)
  }
}

private final class EnrollmentDirectory: @unchecked Sendable, RelayEnrollmentDirectory {
  var received: [RelayEnrollmentDevice] = []
  var result: RelayEnrollmentDeviceRecord
  var emitsFreshIncarnation = false
  init() {
    result = try! RelayEnrollmentDeviceRecord(deviceId: enrollmentDeviceId, enrollmentId: enrollmentDeviceIncarnation, hostEnrollmentId: enrollmentHostIncarnation, label: "Ruan’s iPhone", signingPublicKey: enrollmentSigning, agreementPublicKey: enrollmentAgreement, enrolledAt: "2026-08-21T00:00:00.000Z")
  }
  func enroll(_ device: RelayEnrollmentDevice) throws -> RelayEnrollmentDeviceRecord {
    received.append(device)
    guard emitsFreshIncarnation else { return result }
    let incarnation = String(format: "%016d", received.count)
    return try RelayEnrollmentDeviceRecord(deviceId: result.deviceId, enrollmentId: incarnation, hostEnrollmentId: result.hostEnrollmentId, label: result.label, signingPublicKey: result.signingPublicKey, agreementPublicKey: result.agreementPublicKey, enrolledAt: result.enrolledAt)
  }
}

private func localEnrollmentDevice() throws -> RelayEnrollmentDevice {
  try RelayEnrollmentDevice(deviceId: enrollmentDeviceId, label: "Ruan’s iPhone", signingPublicKey: enrollmentSigning, agreementPublicKey: enrollmentAgreement)
}

private func enrollmentController(directory: EnrollmentDirectory, random: EnrollmentRandom, now: @escaping () -> Date) throws -> RelayEnrollmentController {
  RelayEnrollmentController(host: try RelayEnrollmentHostIdentity(hostDeviceId: enrollmentHostId, agreementPublicKey: enrollmentHostAgreement), directory: directory, random: random, now: now)
}

@Test func localConfirmationMintsOnlyPhoneSafeV3Invitation() throws {
  let directory = EnrollmentDirectory()
  let controller = try enrollmentController(directory: directory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  let candidate = try controller.acceptIPhoneIdentity(localEnrollmentDevice())
  #expect(directory.received.isEmpty)
  let invitation = try controller.confirmLocally(candidate)
  #expect(directory.received == [try localEnrollmentDevice()])
  #expect(invitation.version == 3)
  #expect(invitation.routeGeneration == 1)
  #expect(invitation.connectionEpoch == 1)
  #expect(invitation.routeId.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$", options: .regularExpression) != nil)
  #expect(invitation.clientAuthToken.range(of: "^[A-Za-z0-9_-]{32,256}$", options: .regularExpression) != nil)
  #expect(invitation.hostDeviceId == enrollmentHostId)
  #expect(invitation.hostEnrollmentId == directory.result.hostEnrollmentId)
  #expect(invitation.hostStaticAgreementPublicKey == enrollmentHostAgreement)
  #expect(invitation.deviceId == enrollmentDeviceId)
  #expect(invitation.deviceEnrollmentId == enrollmentDeviceIncarnation)
  #expect(invitation.deviceSigningPublicKey == enrollmentSigning)
  #expect(invitation.deviceAgreementPublicKey == enrollmentAgreement)
  #expect(controller.pendingRouteCountForTest() == 1)
  #expect(!Mirror(reflecting: invitation).children.contains { $0.label == "hostToken" || $0.label == "provisioningCredential" })
  #expect(throws: RelayEnrollmentError.notPending) { try controller.confirmLocally(candidate) }
}

@Test func localConfirmationRejectsExpiredReceiptsBeforeEnrollment() throws {
  let directory = EnrollmentDirectory(); let random = EnrollmentRandom()
  var current = Date(timeIntervalSince1970: 1_787_011_200)
  let controller = try enrollmentController(directory: directory, random: random, now: { current })
  let candidate = try controller.acceptIPhoneIdentity(localEnrollmentDevice())
  current = current.addingTimeInterval(5 * 60)
  #expect(throws: RelayEnrollmentError.notPending) { try controller.confirmLocally(candidate) }
  #expect(directory.received.isEmpty)
}

@Test func enrollmentRejectsDirectoryIdentitySubstitutionAndMalformedPublicInput() throws {
  #expect(throws: RelayEnrollmentError.invalidInput) {
    try RelayEnrollmentDevice(deviceId: enrollmentDeviceId, label: " bad", signingPublicKey: enrollmentSigning, agreementPublicKey: enrollmentAgreement)
  }
  #expect(throws: RelayEnrollmentError.invalidInput) {
    try RelayEnrollmentDevice(deviceId: enrollmentDeviceId, label: "phone", signingPublicKey: enrollmentSigning, agreementPublicKey: enrollmentSigning)
  }
  let directory = EnrollmentDirectory()
  directory.result = try RelayEnrollmentDeviceRecord(deviceId: enrollmentDeviceId, enrollmentId: enrollmentDeviceIncarnation, hostEnrollmentId: enrollmentHostIncarnation, label: "Ruan’s iPhone", signingPublicKey: enrollmentB64(6), agreementPublicKey: enrollmentAgreement, enrolledAt: "2026-08-21T00:00:00.000Z")
  let controller = try enrollmentController(directory: directory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  #expect(throws: RelayEnrollmentError.directoryRejected) { try controller.confirmLocally(try controller.acceptIPhoneIdentity(localEnrollmentDevice())) }
  #expect(controller.pendingRouteCountForTest() == 0)
}

@Test func fullPendingRouteCapacityFailsBeforeDurableEnrollment() throws {
  let directory = EnrollmentDirectory()
  directory.emitsFreshIncarnation = true
  let controller = try enrollmentController(directory: directory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  for _ in 0..<32 {
    let candidate = try controller.acceptIPhoneIdentity(localEnrollmentDevice())
    _ = try controller.confirmLocally(candidate)
  }
  let candidate = try controller.acceptIPhoneIdentity(localEnrollmentDevice())
  #expect(throws: RelayEnrollmentError.capacityExceeded) { try controller.confirmLocally(candidate) }
  #expect(directory.received.count == 32)
  #expect(controller.pendingRouteCountForTest() == 32)
}

@Test func replayedRuntimeEnrollmentReceiptCannotMintAnotherRoute() throws {
  let directory = EnrollmentDirectory()
  let controller = try enrollmentController(directory: directory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  _ = try controller.confirmLocally(try controller.acceptIPhoneIdentity(localEnrollmentDevice()))
  #expect(throws: RelayEnrollmentError.directoryRejected) {
    try controller.confirmLocally(try controller.acceptIPhoneIdentity(localEnrollmentDevice()))
  }
  #expect(controller.pendingRouteCountForTest() == 1)
}

@Test func localOfferImportIsExactPublicOnlyAndHasStableFullFingerprint() throws {
  let device = try localEnrollmentDevice()
  let offer = try JSONSerialization.data(withJSONObject: [
    "deviceId": device.deviceId, "label": device.label,
    "signingPublicKey": device.signingPublicKey, "agreementPublicKey": device.agreementPublicKey,
  ], options: [.sortedKeys])
  #expect(try RelayEnrollmentOfferCodec.decode(offer) == device)
  let fingerprint = try RelayEnrollmentOfferCodec.fingerprint(device)
  #expect(fingerprint.count == 79)
  #expect(fingerprint.split(separator: "-").count == 16)
  let withInstruction = Data(#"{"deviceId":"\#(enrollmentDeviceId)","label":"Ruan’s iPhone","signingPublicKey":"\#(enrollmentSigning)","agreementPublicKey":"\#(enrollmentAgreement)","confirm":"now"}"#.utf8)
  #expect(throws: RelayEnrollmentError.invalidInput) { try RelayEnrollmentOfferCodec.decode(withInstruction) }
  let duplicate = Data(#"{"deviceId":"\#(enrollmentDeviceId)","\u0064eviceId":"\#(String(repeating: "x", count: 16))","label":"Ruan’s iPhone","signingPublicKey":"\#(enrollmentSigning)","agreementPublicKey":"\#(enrollmentAgreement)"}"#.utf8)
  #expect(throws: RelayEnrollmentError.invalidInput) { try RelayEnrollmentOfferCodec.decode(duplicate) }
}

@Test func swiftFingerprintMatchesThePinnedMobileOfferFixture() throws {
  let device = try RelayEnrollmentDevice(
    deviceId: String(repeating: "d", count: 16),
    label: "Ruan’s iPhone",
    signingPublicKey: Data(repeating: 9, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""),
    agreementPublicKey: Data(repeating: 8, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  )
  #expect(try RelayEnrollmentOfferCodec.fingerprint(device) == "2B5E-242C-B1C4-5D4E-6E0B-4835-55F2-3278-E16C-1148-BB04-31C6-8563-1D18-F045-51EC")
}

@Test func localOfferReviewDoesNothingUntilOneExplicitConfirmation() throws {
  let device = try localEnrollmentDevice()
  let offer = try JSONSerialization.data(withJSONObject: [
    "deviceId": device.deviceId, "label": device.label,
    "signingPublicKey": device.signingPublicKey, "agreementPublicKey": device.agreementPublicKey,
  ], options: [.sortedKeys])
  let review = try RelayLocalEnrollmentOfferReview(importedOffer: offer)
  var calls = 0
  #expect(review.preview.label == device.label)
  #expect(calls == 0) // File selection and cancel leave Host state untouched.
  try review.confirm { received in
    #expect(received == device)
    calls += 1 // This represents only the pending-candidate action, not lifecycle completion.
  }
  #expect(calls == 1)
  #expect(throws: RelayEnrollmentError.notPending) {
    try review.confirm { _ in calls += 1 }
  }
  #expect(calls == 1)
}

@Test func phoneInvitationExportHasExactPublicSafeFieldSet() async throws {
  let (lifecycle, _, _, _) = try lifecycleHarness()
  let invitation = try await lifecycle.confirmLocally(try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice()))
  let data = try RelayPhoneInvitationCodec.encode(invitation)
  let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
  #expect(Set(object.keys) == Set(["version", "routeId", "routeGeneration", "connectionEpoch", "clientAuthToken", "expiresAt", "hostDeviceId", "hostEnrollmentId", "hostStaticAgreementPublicKey", "deviceId", "deviceEnrollmentId", "deviceSigningPublicKey", "deviceAgreementPublicKey"]))
  #expect(object["hostToken"] == nil)
  #expect(object["provisioning"] == nil)
  #expect(object["privateKey"] == nil)
}

@Test func explicitConfirmationStaysPendingAndTouchesNoRuntimeOrRouteWhenProvisioningIsDisabled() async throws {
  let directory = EnrollmentDirectory()
  let controller = try enrollmentController(directory: directory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  let store = LifecycleStore()
  let lifecycle = try RelayEnrollmentLifecycle(enrollment: controller, store: store, provisioner: RelayDisabledRouteProvisioner(), connectionOwner: RelayHostRouteConnectionCoordinator(store: store))
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())
  await #expect(throws: RelayEnrollmentLifecycleError.provisioningDisabled) {
    try await lifecycle.confirmLocally(candidate)
  }
  #expect(directory.received.isEmpty)
  #expect(store.pending.isEmpty)
  #expect(store.routes.isEmpty)
  #expect(store.active == nil)
  #expect(lifecycle.state == .awaitingLocalConfirmation)
}

@Test func exactPrivateWireEnrollmentRecordsCarryOnlyPublicIdentity() throws {
  let device = try localEnrollmentDevice()
  let request = try RelayEnrollmentWireCodec.enroll(device)
  #expect(request.kind == .deviceEnroll)
  #expect(request.payload.isEmpty)
  let requestMetadata = try JSONSerialization.jsonObject(with: request.metadata) as! [String: Any]
  #expect(Set(requestMetadata.keys) == Set(["deviceId", "label", "signingPublicKey", "agreementPublicKey"]))
  let confirmation = try JSONSerialization.data(withJSONObject: [
    "deviceId": enrollmentDeviceId, "label": "Ruan’s iPhone", "signingPublicKey": enrollmentSigning,
    "agreementPublicKey": enrollmentAgreement, "deviceEnrollmentId": enrollmentDeviceIncarnation,
    "hostEnrollmentId": enrollmentHostIncarnation,
  ], options: [.sortedKeys])
  let enrolled = try RelayEnrollmentWireCodec.enrolled(RemoteWireRecord(kind: .deviceEnrolled, metadata: confirmation), enrolledAt: "2026-08-21T00:00:00.000Z")
  #expect(enrolled.deviceId == enrollmentDeviceId)
  #expect(enrolled.hostEnrollmentId == enrollmentHostIncarnation)
  #expect(throws: RelayEnrollmentError.invalidInput) {
    try RelayEnrollmentWireCodec.enrolled(RemoteWireRecord(kind: .deviceEnrolled, metadata: confirmation, payload: Data([1])), enrolledAt: "2026-08-21T00:00:00.000Z")
  }
  let substitutedDeviceId = String(repeating: "x", count: 16)
  let duplicate = Data(#"{"deviceId":"\#(enrollmentDeviceId)","deviceId":"\#(substitutedDeviceId)","label":"Ruan’s iPhone","signingPublicKey":"\#(enrollmentSigning)","agreementPublicKey":"\#(enrollmentAgreement)","deviceEnrollmentId":"\#(enrollmentDeviceIncarnation)","hostEnrollmentId":"\#(enrollmentHostIncarnation)"}"#.utf8)
  #expect(throws: RelayEnrollmentError.invalidInput) {
    try RelayEnrollmentWireCodec.enrolled(RemoteWireRecord(kind: .deviceEnrolled, metadata: duplicate), enrolledAt: "2026-08-21T00:00:00.000Z")
  }
  let escapedDuplicate = Data(#"{"deviceId":"\#(enrollmentDeviceId)","\u0064eviceId":"\#(substitutedDeviceId)","label":"Ruan’s iPhone","signingPublicKey":"\#(enrollmentSigning)","agreementPublicKey":"\#(enrollmentAgreement)","deviceEnrollmentId":"\#(enrollmentDeviceIncarnation)","hostEnrollmentId":"\#(enrollmentHostIncarnation)"}"#.utf8)
  #expect(throws: RelayEnrollmentError.invalidInput) {
    try RelayEnrollmentWireCodec.enrolled(RemoteWireRecord(kind: .deviceEnrolled, metadata: escapedDuplicate), enrolledAt: "2026-08-21T00:00:00.000Z")
  }
}

@Test func hostedChildReceiptMustMatchTheAlreadyPairedRouteLifetimeExactly() throws {
  let credential = try RelayRouteCredential(
    routeId: String(repeating: "r", count: 16),
    hostDeviceId: enrollmentHostId,
    hostEnrollmentId: enrollmentHostIncarnation,
    deviceId: enrollmentDeviceId,
    deviceEnrollmentId: enrollmentDeviceIncarnation,
    deviceSigningPublicKey: enrollmentSigning,
    deviceAgreementPublicKey: enrollmentAgreement,
    generation: 1,
    hostToken: String(repeating: "t", count: 32),
    deviceToken: String(repeating: "u", count: 32)
  )
  let matching = try JSONSerialization.data(withJSONObject: [
    "deviceId": enrollmentDeviceId, "label": "Ruan’s iPhone", "signingPublicKey": enrollmentSigning,
    "agreementPublicKey": enrollmentAgreement, "deviceEnrollmentId": enrollmentDeviceIncarnation,
    "hostEnrollmentId": enrollmentHostIncarnation,
  ], options: [.sortedKeys])
  try RelayHostedChildEnrollmentReconciliation.validate(
    RemoteWireRecord(kind: .deviceEnrolled, metadata: matching),
    credential: credential,
    expectedLabel: "Ruan’s iPhone",
    enrolledAt: "2026-08-21T00:00:00.000Z"
  )

  let childMintedHostLifetime = try JSONSerialization.data(withJSONObject: [
    "deviceId": enrollmentDeviceId, "label": "Ruan’s iPhone", "signingPublicKey": enrollmentSigning,
    "agreementPublicKey": enrollmentAgreement, "deviceEnrollmentId": enrollmentDeviceIncarnation,
    "hostEnrollmentId": String(repeating: "n", count: 16),
  ], options: [.sortedKeys])
  #expect(throws: RelayEnrollmentError.directoryRejected) {
    try RelayHostedChildEnrollmentReconciliation.validate(
      RemoteWireRecord(kind: .deviceEnrolled, metadata: childMintedHostLifetime),
      credential: credential,
      expectedLabel: "Ruan’s iPhone",
      enrolledAt: "2026-08-21T00:00:00.000Z"
    )
  }
}

@Test func fd199EnrollmentSeedHasOnlyTheExactPublicLifetimeTuple() throws {
  let metadata = try JSONSerialization.data(withJSONObject: [
    "deviceId": enrollmentDeviceId, "label": "Ruan’s iPhone", "signingPublicKey": enrollmentSigning,
    "agreementPublicKey": enrollmentAgreement, "deviceEnrollmentId": enrollmentDeviceIncarnation,
    "hostEnrollmentId": enrollmentHostIncarnation,
  ], options: [.sortedKeys])
  let record = RemoteWireRecord(kind: .enrollmentSeed, metadata: metadata)
  let decoded = try RelayEnrollmentWireCodec.enrollmentSeed(record, seededAt: "2026-08-21T00:00:00.000Z")
  #expect(decoded.deviceId == enrollmentDeviceId)
  #expect(decoded.enrollmentId == enrollmentDeviceIncarnation)
  #expect(decoded.hostEnrollmentId == enrollmentHostIncarnation)

  let withToken = try JSONSerialization.data(withJSONObject: [
    "deviceId": enrollmentDeviceId, "label": "Ruan’s iPhone", "signingPublicKey": enrollmentSigning,
    "agreementPublicKey": enrollmentAgreement, "deviceEnrollmentId": enrollmentDeviceIncarnation,
    "hostEnrollmentId": enrollmentHostIncarnation, "hostToken": String(repeating: "t", count: 32),
  ], options: [.sortedKeys])
  #expect(throws: RelayEnrollmentError.invalidInput) {
    try RelayEnrollmentWireCodec.enrollmentSeed(RemoteWireRecord(kind: .enrollmentSeed, metadata: withToken), seededAt: "2026-08-21T00:00:00.000Z")
  }
  #expect(throws: RelayEnrollmentError.invalidInput) {
    try RelayEnrollmentWireCodec.enrollmentSeed(RemoteWireRecord(kind: .enrollmentSeed, metadata: metadata, payload: Data([1])), seededAt: "2026-08-21T00:00:00.000Z")
  }
  #expect(throws: RelayEnrollmentError.invalidInput) {
    try RelayEnrollmentWireCodec.enrollmentSeed(RemoteWireRecord(kind: .deviceEnrolled, metadata: metadata), seededAt: "2026-08-21T00:00:00.000Z")
  }
}

private enum LifecycleFailure: Error { case rejected, unavailable }

private final class LifecycleStore: @unchecked Sendable, RelaySecretStore {
  private let epochScope = UUID().uuidString
  lazy var connectionEpochCoordinator: any RelayConnectionEpochCoordinator = RelayConnectionEpochInMemoryCoordinator(scope: epochScope)
  private let provisioning = try! RelayProvisioningCredential(String(repeating: "P", count: 32))
  var routes: [String: RelayRouteCredential] = [:]
  var active: RelayRouteCredential?
  var pending: [String: RelayRouteCredential] = [:]
  var revokedCleanup: [String: RelayRouteCredential] = [:]
  var epochs: [String: RelayConnectionEpochState] = [:]
  var failSave = false
  var failRemove = false
  var failRemovePending = false

  func provisioningCredential() throws -> RelayProvisioningCredential { provisioning }
  func routeCredential(routeId: String) throws -> RelayRouteCredential? { routes[routeId] }
  func saveRouteCredential(_ credential: RelayRouteCredential) throws {
    if failSave { throw LifecycleFailure.unavailable }
    routes[credential.routeId] = credential
  }
  func removeRouteCredential(routeId: String) throws {
    if failRemove { throw LifecycleFailure.unavailable }
    routes.removeValue(forKey: routeId)
  }
  func activeRouteCredential() throws -> RelayRouteCredential? { active }
  func saveActiveRouteCredential(_ credential: RelayRouteCredential) throws { active = credential }
  func removeActiveRouteCredential(routeId: String) throws { if active?.routeId == routeId { active = nil } }
  func pendingRouteCredential() throws -> RelayRouteCredential? { pending.values.first }
  func savePendingRouteCredential(_ credential: RelayRouteCredential) throws { pending = [credential.routeId: credential] }
  func removePendingRouteCredential(routeId: String) throws {
    if failRemovePending { throw LifecycleFailure.unavailable }
    pending.removeValue(forKey: routeId)
  }
  func revokedCleanupRouteCredential() throws -> RelayRouteCredential? { revokedCleanup.values.first }
  func saveRevokedCleanupRouteCredential(_ credential: RelayRouteCredential) throws { revokedCleanup = [credential.routeId: credential] }
  func removeRevokedCleanupRouteCredential(routeId: String) throws { revokedCleanup.removeValue(forKey: routeId) }
  func connectionEpochState(routeId: String) throws -> RelayConnectionEpochState? { epochs[routeId] }
  func saveConnectionEpochState(_ state: RelayConnectionEpochState) throws { epochs[state.routeId] = state }
  func removeConnectionEpochState(routeId: String) throws { epochs.removeValue(forKey: routeId) }
}

private final class LifecycleProvisioner: @unchecked Sendable, RelayRouteProvisioner {
  var provisioned: [RelayRouteCredential] = []
  var revoked: [RelayRouteCredential] = []
  var provisionError: Error?
  var revokeError: Error?

  func provision(_ credential: RelayRouteCredential, provisioning: RelayProvisioningCredential) async throws {
    if let provisionError { throw provisionError }
    provisioned.append(credential)
  }

  func revoke(_ credential: RelayRouteCredential) async throws {
    if let revokeError { throw revokeError }
    revoked.append(credential)
  }
}

private actor RecordingConnectionOwner: RelayActiveRouteConnectionOwner {
  private var stopped: [RelayRouteCredential] = []
  func beginRevocation(for credential: RelayRouteCredential) async { stopped.append(credential) }
  func finishRevocation(for credential: RelayRouteCredential) async {}
  func stopConnection(for credential: RelayRouteCredential) async { stopped.append(credential) }
  func snapshot() -> [RelayRouteCredential] { stopped }
}

private func lifecycleHarness(store: LifecycleStore = LifecycleStore(), provisioner: LifecycleProvisioner = LifecycleProvisioner(), connectionOwner: RelayActiveRouteConnectionOwner? = nil, directory: EnrollmentDirectory = EnrollmentDirectory()) throws -> (RelayEnrollmentLifecycle, EnrollmentDirectory, LifecycleStore, LifecycleProvisioner) {
  let controller = try enrollmentController(directory: directory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  return (try RelayEnrollmentLifecycle(enrollment: controller, store: store, provisioner: provisioner, connectionOwner: connectionOwner ?? RelayHostRouteConnectionCoordinator(store: store)), directory, store, provisioner)
}

@Test func lifecyclePersistsOnlyAfterRuntimeReceiptAndProvisionThenPublishesInvitation() async throws {
  let (lifecycle, directory, store, provisioner) = try lifecycleHarness()
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())
  #expect(lifecycle.state == .awaitingLocalConfirmation)
  #expect(directory.received.isEmpty)

  let invitation = try await lifecycle.confirmLocally(candidate)
  #expect(directory.received == [try localEnrollmentDevice()])
  #expect(provisioner.provisioned.count == 1)
  #expect(provisioner.revoked.isEmpty)
  #expect(try store.routeCredential(routeId: invitation.routeId) == provisioner.provisioned[0])
  let initialEpoch = try RelayConnectionEpochState(routeId: invitation.routeId, lastCommittedEpoch: 0, pendingEpoch: nil)
  #expect(try store.connectionEpochState(routeId: invitation.routeId) == initialEpoch)
  #expect(lifecycle.state == .invitationReady(invitation))
  #expect(!Mirror(reflecting: invitation).children.contains { $0.label == "hostToken" || $0.label == "provisioningCredential" })

  try await lifecycle.revoke()
  #expect(provisioner.revoked == provisioner.provisioned)
  #expect(try store.routeCredential(routeId: invitation.routeId) == nil)
  #expect(try store.connectionEpochState(routeId: invitation.routeId) == nil)
  #expect(lifecycle.state == .revoked)
}

@Test func reissuedInvitationUsesTheDurablePendingOrExactNextConnectionEpoch() async throws {
  let (lifecycle, _, store, _) = try lifecycleHarness()
  let invitation = try await lifecycle.confirmLocally(try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice()))
  try store.saveConnectionEpochState(try RelayConnectionEpochState(routeId: invitation.routeId, lastCommittedEpoch: 4, pendingEpoch: 5))
  #expect(try lifecycle.reissueActiveInvitation().connectionEpoch == 5)

  try store.saveConnectionEpochState(try RelayConnectionEpochState(routeId: invitation.routeId, lastCommittedEpoch: 5, pendingEpoch: nil))
  #expect(try lifecycle.reissueActiveInvitation().connectionEpoch == 6)
}

@Test func lifecycleFencesTheActiveRouteConnectionBeforeRevocation() async throws {
  let connectionOwner = RecordingConnectionOwner()
  let (lifecycle, _, _, provisioner) = try lifecycleHarness(connectionOwner: connectionOwner)
  let invitation = try await lifecycle.confirmLocally(try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice()))
  try await lifecycle.revoke()
  #expect(await connectionOwner.snapshot() == provisioner.provisioned)
  #expect(provisioner.provisioned[0].routeId == invitation.routeId)
}

@Test func lifecycleProvisionFailureNeverStoresOrPublishesRoute() async throws {
  let provisioner = LifecycleProvisioner(); provisioner.provisionError = LifecycleFailure.rejected
  let (lifecycle, directory, store, recorded) = try lifecycleHarness(provisioner: provisioner)
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())

  await #expect(throws: LifecycleFailure.self) { try await lifecycle.confirmLocally(candidate) }
  #expect(directory.received == [try localEnrollmentDevice()])
  #expect(recorded.provisioned.isEmpty)
  #expect(recorded.revoked.count == 1)
  #expect(store.routes.isEmpty)
  #expect(store.pending.isEmpty)
  #expect(lifecycle.state == .failed)
}

@Test func lifecycleCompensatesProvisionWhenKeychainStoreFails() async throws {
  let store = LifecycleStore(); store.failSave = true
  let (lifecycle, _, recordedStore, provisioner) = try lifecycleHarness(store: store)
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())

  await #expect(throws: LifecycleFailure.self) { try await lifecycle.confirmLocally(candidate) }
  #expect(provisioner.provisioned.count == 1)
  #expect(provisioner.revoked == provisioner.provisioned)
  #expect(recordedStore.routes.isEmpty)
  #expect(recordedStore.pending.isEmpty)
  #expect(lifecycle.state == .failed)
}

@Test func lifecycleKeepsUncertainProvisionCredentialUntilCompensationSucceeds() async throws {
  let provisioner = LifecycleProvisioner(); provisioner.provisionError = LifecycleFailure.unavailable; provisioner.revokeError = LifecycleFailure.unavailable
  let (lifecycle, _, store, recorded) = try lifecycleHarness(provisioner: provisioner)
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())

  await #expect(throws: LifecycleFailure.self) { try await lifecycle.confirmLocally(candidate) }
  #expect(recorded.provisioned.isEmpty)
  #expect(recorded.revoked.isEmpty)
  #expect(store.pending.count == 1)
  #expect(lifecycle.state == .compensationPending)

  provisioner.revokeError = nil
  try await lifecycle.reconcilePendingCompensation()
  #expect(recorded.revoked.count == 1)
  #expect(store.pending.isEmpty)
  #expect(lifecycle.state == .failed)
}

@Test func lifecycleReloadsDurablePendingCompensationAfterHostRestart() async throws {
  let provisioner = LifecycleProvisioner(); provisioner.provisionError = LifecycleFailure.unavailable; provisioner.revokeError = LifecycleFailure.unavailable
  let (lifecycle, _, store, _) = try lifecycleHarness(provisioner: provisioner)
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())
  await #expect(throws: LifecycleFailure.self) { try await lifecycle.confirmLocally(candidate) }
  #expect(store.pending.count == 1)

  let freshDirectory = EnrollmentDirectory()
  let freshController = try enrollmentController(directory: freshDirectory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  let restarted = try RelayEnrollmentLifecycle(enrollment: freshController, store: store, provisioner: provisioner, connectionOwner: RelayHostRouteConnectionCoordinator(store: store))
  #expect(restarted.state == .compensationPending)
  provisioner.revokeError = nil
  try await restarted.reconcilePendingCompensation()
  #expect(store.pending.isEmpty)
  #expect(restarted.state == .failed)
}

@Test func lifecycleCompensatesActiveCredentialWhenPendingCleanupFails() async throws {
  let store = LifecycleStore(); store.failRemovePending = true
  let (lifecycle, _, recordedStore, provisioner) = try lifecycleHarness(store: store)
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())

  await #expect(throws: LifecycleFailure.self) { try await lifecycle.confirmLocally(candidate) }
  #expect(provisioner.provisioned.count == 1)
  #expect(provisioner.revoked.count == 1)
  #expect(recordedStore.routes.isEmpty)
  #expect(recordedStore.pending.count == 1)
  #expect(lifecycle.state == .compensationPending)

  recordedStore.failRemovePending = false
  try await lifecycle.reconcilePendingCompensation()
  #expect(provisioner.revoked.count == 2)
  #expect(recordedStore.routes.isEmpty)
  #expect(recordedStore.pending.isEmpty)
  #expect(lifecycle.state == .failed)
}

@Test func lifecycleNeverRestoresInvitationAfterRemoteRevokeWhenKeychainCleanupFails() async throws {
  let store = LifecycleStore()
  let (lifecycle, _, recordedStore, provisioner) = try lifecycleHarness(store: store)
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())
  let invitation = try await lifecycle.confirmLocally(candidate)
  recordedStore.failRemove = true

  await #expect(throws: LifecycleFailure.self) { try await lifecycle.revoke() }
  #expect(provisioner.revoked.count == 1)
  #expect(lifecycle.state == .remoteRevokedPendingLocalCleanup)
  #expect(try recordedStore.routeCredential(routeId: invitation.routeId) != nil)

  recordedStore.failRemove = false
  try await lifecycle.recoverRevokedCleanup()
  #expect(provisioner.revoked.count == 2)
  #expect(try recordedStore.routeCredential(routeId: invitation.routeId) == nil)
  #expect(lifecycle.state == .revoked)
}

@Test func lifecycleReloadsRevokedCleanupAfterHostRestart() async throws {
  let store = LifecycleStore()
  let (lifecycle, _, recordedStore, provisioner) = try lifecycleHarness(store: store)
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())
  let invitation = try await lifecycle.confirmLocally(candidate)
  recordedStore.failRemove = true
  await #expect(throws: LifecycleFailure.self) { try await lifecycle.revoke() }
  #expect(recordedStore.revokedCleanup.count == 1)

  let freshDirectory = EnrollmentDirectory()
  let freshController = try enrollmentController(directory: freshDirectory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  let restarted = try RelayEnrollmentLifecycle(enrollment: freshController, store: store, provisioner: provisioner, connectionOwner: RelayHostRouteConnectionCoordinator(store: store))
  #expect(restarted.state == .remoteRevokedPendingLocalCleanup)
  recordedStore.failRemove = false
  try await restarted.recoverRevokedCleanup()
  #expect(provisioner.revoked.count == 2)
  #expect(try recordedStore.routeCredential(routeId: invitation.routeId) == nil)
  #expect(recordedStore.revokedCleanup.isEmpty)
  #expect(restarted.state == .revoked)
}

@Test func lifecycleReloadsAHealthyActiveRouteAfterHostRestartForRevocation() async throws {
  let store = LifecycleStore()
  let (lifecycle, _, recordedStore, provisioner) = try lifecycleHarness(store: store)
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())
  let invitation = try await lifecycle.confirmLocally(candidate)
  #expect(recordedStore.active?.routeId == invitation.routeId)

  let freshDirectory = EnrollmentDirectory()
  let freshController = try enrollmentController(directory: freshDirectory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  let restarted = try RelayEnrollmentLifecycle(enrollment: freshController, store: store, provisioner: provisioner, connectionOwner: RelayHostRouteConnectionCoordinator(store: store))
  #expect(restarted.state == .activeRouteRecovery)
  try await restarted.revoke()
  #expect(provisioner.revoked.count == 1)
  #expect(try recordedStore.routeCredential(routeId: invitation.routeId) == nil)
  #expect(recordedStore.active == nil)
  #expect(restarted.state == .revoked)
}

@Test func lifecycleAllowsFreshPairingAfterACompleteRevoke() async throws {
  let directory = EnrollmentDirectory()
  directory.emitsFreshIncarnation = true
  let (lifecycle, _, store, provisioner) = try lifecycleHarness(directory: directory)
  let first = try await lifecycle.confirmLocally(try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice()))
  try await lifecycle.revoke()
  let second = try await lifecycle.confirmLocally(try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice()))

  #expect(first.routeId != second.routeId)
  #expect(store.active?.routeId == second.routeId)
  #expect(provisioner.provisioned.count == 2)
  #expect(provisioner.revoked.count == 1)
}

@Test func lifecycleRecoveryRetriesDeleteAfterCrashImmediatelyFollowingDurableRevokeIntent() async throws {
  let store = LifecycleStore()
  let (lifecycle, _, recordedStore, provisioner) = try lifecycleHarness(store: store)
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())
  let invitation = try await lifecycle.confirmLocally(candidate)
  let active = try #require(recordedStore.routes[invitation.routeId])
  try recordedStore.saveRevokedCleanupRouteCredential(active)

  let freshDirectory = EnrollmentDirectory()
  let freshController = try enrollmentController(directory: freshDirectory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  let restarted = try RelayEnrollmentLifecycle(enrollment: freshController, store: store, provisioner: provisioner, connectionOwner: RelayHostRouteConnectionCoordinator(store: store))
  #expect(restarted.state == .remoteRevokedPendingLocalCleanup)
  try await restarted.recoverRevokedCleanup()
  #expect(provisioner.revoked.count == 1)
  #expect(try recordedStore.routeCredential(routeId: invitation.routeId) == nil)
  #expect(recordedStore.revokedCleanup.isEmpty)
  #expect(restarted.state == .revoked)
}

@Test func lifecycleRetainsRevokeIntentAfterAmbiguousDeleteFailureUntilRestartRecovery() async throws {
  let store = LifecycleStore()
  let provisioner = LifecycleProvisioner(); provisioner.revokeError = LifecycleFailure.unavailable
  let (lifecycle, _, recordedStore, _) = try lifecycleHarness(store: store, provisioner: provisioner)
  let candidate = try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice())
  let invitation = try await lifecycle.confirmLocally(candidate)
  await #expect(throws: LifecycleFailure.self) { try await lifecycle.revoke() }
  #expect(lifecycle.state == .remoteRevokedPendingLocalCleanup)
  #expect(recordedStore.revokedCleanup.count == 1)

  let freshDirectory = EnrollmentDirectory()
  let freshController = try enrollmentController(directory: freshDirectory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  let restarted = try RelayEnrollmentLifecycle(enrollment: freshController, store: store, provisioner: provisioner, connectionOwner: RelayHostRouteConnectionCoordinator(store: store))
  provisioner.revokeError = nil
  try await restarted.recoverRevokedCleanup()
  #expect(provisioner.revoked.count == 1)
  #expect(try recordedStore.routeCredential(routeId: invitation.routeId) == nil)
  #expect(recordedStore.revokedCleanup.isEmpty)
  #expect(restarted.state == .revoked)
}

@Test func lifecycleRecoveryCompletesAfterCrashFollowingActivePointerRemoval() async throws {
  let store = LifecycleStore(); let provisioner = LifecycleProvisioner()
  let (lifecycle, _, recordedStore, _) = try lifecycleHarness(store: store, provisioner: provisioner)
  let invitation = try await lifecycle.confirmLocally(try lifecycle.acceptIPhoneIdentity(localEnrollmentDevice()))
  let storedActive = try recordedStore.activeRouteCredential()
  let active = try #require(storedActive)
  try recordedStore.saveRevokedCleanupRouteCredential(active)
  try recordedStore.removeActiveRouteCredential(routeId: active.routeId)

  let freshDirectory = EnrollmentDirectory()
  let freshController = try enrollmentController(directory: freshDirectory, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  let restarted = try RelayEnrollmentLifecycle(enrollment: freshController, store: store, provisioner: provisioner, connectionOwner: RelayHostRouteConnectionCoordinator(store: store))
  try await restarted.recoverRevokedCleanup()

  #expect(provisioner.revoked == [active])
  #expect(try recordedStore.routeCredential(routeId: invitation.routeId) == nil)
  #expect(recordedStore.epochs[active.routeId] == nil)
  #expect(recordedStore.revokedCleanup.isEmpty)
  #expect(restarted.state == .revoked)
}

@Test func productionProvisionerRequiresExplicitSignedHostActivationProof() throws {
  #expect(throws: RelayOwnerError.unavailable) {
    _ = try RelaySignedHostActivationConfiguration.validateRunningHost()
  }
}

@Test func activationProofRejectsASealedRequirementFromAnotherAppleSignedHost() {
  let expected = "identifier \"com.deepseek.dsh.remote-host\" and anchor apple generic and certificate leaf[subject.OU] = \"TEAM-A\""
  let substituted = "identifier \"com.deepseek.dsh.remote-host\" and anchor apple generic and certificate leaf[subject.OU] = \"TEAM-B\""
  #expect(RelaySignedHostActivationConfiguration.matchesPackagedDesignatedRequirement(expected, designated: expected))
  #expect(!RelaySignedHostActivationConfiguration.matchesPackagedDesignatedRequirement(expected, designated: substituted))
}

@Test func productionProvisionerRejectsCrossOriginRedirectBeforeResendingCredentials() async throws {
  let session = URLSession(configuration: .ephemeral)
  let task = session.dataTask(with: URL(string: "https://dshrelay.rulabs.dev/v3/routes/route")!)
  let response = try #require(HTTPURLResponse(url: URL(string: "https://dshrelay.rulabs.dev/v3/routes/route")!, statusCode: 307, httpVersion: "HTTP/1.1", headerFields: ["location": "https://attacker.invalid/"]))
  let redirected = URLRequest(url: URL(string: "https://attacker.invalid/")!)
  let resultingRequest: URLRequest? = await withCheckedContinuation { continuation in
    RelayRejectRedirects().urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: redirected) { value in
      continuation.resume(returning: value)
    }
  }
  #expect(resultingRequest == nil)
  task.cancel(); session.invalidateAndCancel()
}

private final class RuntimeEnrollmentExchange: @unchecked Sendable, RelayRuntimeEnrollmentExchange {
  var received: [RelayEnrollmentDevice] = []
  let response: RemoteWireRecord

  init() {
    let metadata = try! JSONSerialization.data(withJSONObject: [
      "deviceId": enrollmentDeviceId, "label": "Ruan’s iPhone", "signingPublicKey": enrollmentSigning,
      "agreementPublicKey": enrollmentAgreement, "deviceEnrollmentId": enrollmentDeviceIncarnation,
      "hostEnrollmentId": enrollmentHostIncarnation,
    ], options: [.sortedKeys])
    response = RemoteWireRecord(kind: .deviceEnrolled, metadata: metadata)
  }

  func enroll(_ device: RelayEnrollmentDevice) throws -> RemoteWireRecord {
    received.append(device)
    return response
  }
}

private final class BlockingRuntimeEnrollmentExchange: @unchecked Sendable, RelayRuntimeEnrollmentExchange {
  private let started = DispatchSemaphore(value: 0)
  private let release = DispatchSemaphore(value: 0)
  private let response = RuntimeEnrollmentExchange().response

  func enroll(_ device: RelayEnrollmentDevice) throws -> RemoteWireRecord {
    started.signal()
    _ = release.wait(timeout: .now() + 1)
    return response
  }

  func waitForRequest() -> Bool { started.wait(timeout: .now() + 1) == .success }
  func allowReceipt() { release.signal() }
}

@Test func signedHostPairingCompositionUsesOnlyFixedRuntimeReceiptAndStaysInertUntilConfirmation() async throws {
  let store = LifecycleStore(); let provisioner = LifecycleProvisioner(); let exchange = RuntimeEnrollmentExchange()
  let host = try RelayEnrollmentHostIdentity(hostDeviceId: enrollmentHostId, agreementPublicKey: enrollmentHostAgreement)
  let composition = try RelayHostPairingComposition.makeForTest(host: host, store: store, exchange: exchange, provisioner: provisioner, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  let candidate = try composition.acceptIPhoneIdentity(localEnrollmentDevice())
  #expect(exchange.received.isEmpty)
  #expect(provisioner.provisioned.isEmpty)

  let invitation = try await composition.confirmLocally(candidate)
  #expect(exchange.received.count == 1)
  #expect(exchange.received == [try localEnrollmentDevice()])
  #expect(provisioner.provisioned.count == 1)
  #expect(try store.routeCredential(routeId: invitation.routeId) == provisioner.provisioned[0])
  #expect(!Mirror(reflecting: invitation).children.contains { $0.label == "hostToken" || $0.label == "provisioningCredential" })
}

@Test func productionPairingFactoryExposesOnlyConcreteFD198RuntimeProvenance() {
  // The public factory takes only the opaque supervisor. Its raw descriptor,
  // typed exchange creation, and the forgeable test receipt seam are internal.
  let factory: (any RelayHostPublicIdentityProvider, any RelaySecretStore, RelayPrivateRuntimeSupervisor) throws -> RelayHostPairingComposition = RelayHostPairingComposition.makeForVerifiedHost
  _ = factory
}

@Test func supervisorSpawnsPrivateRuntimeWithNoAmbientEnvironment() {
  #expect(RelayPrivateRuntimeSupervisor.privateRuntimeEnvironment.isEmpty)
}

@Test func compositionPublishesPreparingStateWhileRuntimeReceiptIsPending() async throws {
  let store = LifecycleStore(); let provisioner = LifecycleProvisioner(); let exchange = BlockingRuntimeEnrollmentExchange()
  let host = try RelayEnrollmentHostIdentity(hostDeviceId: enrollmentHostId, agreementPublicKey: enrollmentHostAgreement)
  let composition = try RelayHostPairingComposition.makeForTest(host: host, store: store, exchange: exchange, provisioner: provisioner, random: EnrollmentRandom(), now: { Date(timeIntervalSince1970: 1_787_011_200) })
  let candidate = try composition.acceptIPhoneIdentity(localEnrollmentDevice())
  let confirmation = Task { try await composition.confirmLocally(candidate) }
  #expect(exchange.waitForRequest())
  #expect(composition.lifecycle.state == .preparingRuntimeReceipt)
  exchange.allowReceipt()
  _ = try await confirmation.value
}

private func fd198SocketPair() throws -> (FileHandle, FileHandle) {
  var descriptors: [Int32] = [0, 0]
  guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw RelayEnrollmentError.unavailable }
  var noSigPipe: Int32 = 1
  guard setsockopt(descriptors[1], SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
    close(descriptors[0]); close(descriptors[1])
    throw RelayEnrollmentError.unavailable
  }
  return (FileHandle(fileDescriptor: descriptors[0], closeOnDealloc: true), FileHandle(fileDescriptor: descriptors[1], closeOnDealloc: true))
}

private func testSupervisor(_ host: FileHandle, runtime: FileHandle, timeout: Int32 = 100) throws -> RelayPrivateRuntimeSupervisor {
  let supervisor = RelayPrivateRuntimeSupervisor(testChannel: host, waitMilliseconds: timeout)
  try runtime.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .runtimeReady)))
  let deadline = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
  while !supervisor.isReadyForTesting, DispatchTime.now().uptimeNanoseconds < deadline { usleep(1_000) }
  guard supervisor.isReadyForTesting else { throw RelayEnrollmentError.unavailable }
  return supervisor
}

private func runtimeRequest(_ runtime: FileHandle) throws -> RemoteWireRecord {
  var buffer = runtime.availableData
  let records = try RemoteWire.consume(&buffer)
  guard records.count == 1, buffer.isEmpty else { throw RelayEnrollmentError.unavailable }
  return records[0]
}

private final class EnrollmentResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var result: Result<RemoteWireRecord, Error>?
  func set(_ value: Result<RemoteWireRecord, Error>) { lock.lock(); result = value; lock.unlock() }
  func get() -> Result<RemoteWireRecord, Error>? { lock.lock(); defer { lock.unlock() }; return result }
}

@Test func supervisorDemuxesFragmentedReceiptThroughItsOnlyFDReader() throws {
  let (host, runtime) = try fd198SocketPair()
  defer { host.closeFile(); runtime.closeFile() }
  let supervisor = try testSupervisor(host, runtime: runtime)
  let exchange = try supervisor.enrollmentExchange()
  let expected = RuntimeEnrollmentExchange().response
  let completed = DispatchSemaphore(value: 0)
  let result = EnrollmentResultBox()
  DispatchQueue.global().async {
    result.set(Result { try exchange.enroll(try localEnrollmentDevice()) })
    completed.signal()
  }
  let request = try runtimeRequest(runtime)
  #expect(request.kind == .deviceEnroll)
  let bytes = try RemoteWire.encode(expected)
  try runtime.write(contentsOf: bytes.prefix(3))
  usleep(1_000)
  try runtime.write(contentsOf: bytes.dropFirst(3))
  #expect(completed.wait(timeout: .now() + 1) == .success)
  #expect(try result.get()?.get() == expected)
  #expect(!supervisor.isStoppedForTesting)
}

@Test func supervisorStopsOnUnexpectedRuntimeFrame() throws {
  let (host, runtime) = try fd198SocketPair()
  defer { host.closeFile(); runtime.closeFile() }
  let supervisor = try testSupervisor(host, runtime: runtime)
  try runtime.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .epochBegun)))
  let deadline = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
  while !supervisor.isStoppedForTesting, DispatchTime.now().uptimeNanoseconds < deadline { usleep(1_000) }
  #expect(supervisor.isStoppedForTesting)
  #expect(throws: RelayEnrollmentError.unavailable) { try supervisor.enrollmentExchange() }
}

@Test func supervisorRejectsPreloadedPartialReceiptBeforeAnyEnrollmentRequest() throws {
  let (host, runtime) = try fd198SocketPair()
  defer { host.closeFile(); runtime.closeFile() }
  let supervisor = try testSupervisor(host, runtime: runtime)
  try runtime.write(contentsOf: Data([0, 0, 0]))
  let deadline = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
  while !supervisor.isStoppedForTesting, DispatchTime.now().uptimeNanoseconds < deadline { usleep(1_000) }
  #expect(supervisor.isStoppedForTesting)
}

@Test func supervisorRejectsMalformedReceiptAndStopsBeforeDirectoryConsumesIt() throws {
  let (host, runtime) = try fd198SocketPair()
  defer { host.closeFile(); runtime.closeFile() }
  let supervisor = try testSupervisor(host, runtime: runtime)
  let exchange = try supervisor.enrollmentExchange()
  let completed = DispatchSemaphore(value: 0)
  let result = EnrollmentResultBox()
  DispatchQueue.global().async {
    result.set(Result { try exchange.enroll(try localEnrollmentDevice()) })
    completed.signal()
  }
  _ = try runtimeRequest(runtime)
  try runtime.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .deviceEnrolled, metadata: Data("{}".utf8))))
  #expect(completed.wait(timeout: .now() + 1) == .success)
  guard let completedResult = result.get() else { throw RelayEnrollmentError.unavailable }
  #expect(throws: RelayEnrollmentError.unavailable) { try completedResult.get() }
  #expect(supervisor.isStoppedForTesting)
}

@Test func supervisorRejectsReceiptWhosePublicIdentityDoesNotMatchItsRequest() throws {
  let (host, runtime) = try fd198SocketPair()
  defer { host.closeFile(); runtime.closeFile() }
  let supervisor = try testSupervisor(host, runtime: runtime)
  let exchange = try supervisor.enrollmentExchange()
  let completed = DispatchSemaphore(value: 0)
  let result = EnrollmentResultBox()
  DispatchQueue.global().async {
    result.set(Result { try exchange.enroll(try localEnrollmentDevice()) })
    completed.signal()
  }
  _ = try runtimeRequest(runtime)
  let forged = try JSONSerialization.data(withJSONObject: [
    "deviceId": String(repeating: "x", count: 16), "label": "Ruan’s iPhone",
    "signingPublicKey": enrollmentSigning, "agreementPublicKey": enrollmentAgreement,
    "deviceEnrollmentId": enrollmentDeviceIncarnation, "hostEnrollmentId": enrollmentHostIncarnation,
  ], options: [.sortedKeys])
  try runtime.write(contentsOf: RemoteWire.encode(RemoteWireRecord(kind: .deviceEnrolled, metadata: forged)))
  #expect(completed.wait(timeout: .now() + 1) == .success)
  guard let completedResult = result.get() else { throw RelayEnrollmentError.unavailable }
  #expect(throws: RelayEnrollmentError.unavailable) { try completedResult.get() }
  #expect(supervisor.isStoppedForTesting)
}

@Test func supervisorRejectsReceiptDeliveredAfterItsMonotonicDeadline() throws {
  let (host, runtime) = try fd198SocketPair()
  defer { host.closeFile(); runtime.closeFile() }
  let supervisor = try testSupervisor(host, runtime: runtime, timeout: 2)
  let exchange = try supervisor.enrollmentExchange()
  let completed = DispatchSemaphore(value: 0)
  let result = EnrollmentResultBox()
  DispatchQueue.global().async {
    result.set(Result { try exchange.enroll(try localEnrollmentDevice()) })
    completed.signal()
  }
  _ = try runtimeRequest(runtime)
  usleep(10_000)
  try? runtime.write(contentsOf: RemoteWire.encode(RuntimeEnrollmentExchange().response))
  #expect(completed.wait(timeout: .now() + 1) == .success)
  guard let completedResult = result.get() else { throw RelayEnrollmentError.unavailable }
  #expect(throws: RelayEnrollmentError.unavailable) { try completedResult.get() }
  #expect(supervisor.isStoppedForTesting)
}

@Test func supervisorRejectsConcurrentEnrollmentInsteadOfCreatingSecondFDReader() throws {
  let (host, runtime) = try fd198SocketPair()
  defer { host.closeFile(); runtime.closeFile() }
  let supervisor = try testSupervisor(host, runtime: runtime)
  let exchange = try supervisor.enrollmentExchange()
  let completed = DispatchSemaphore(value: 0)
  let result = EnrollmentResultBox()
  DispatchQueue.global().async {
    result.set(Result { try exchange.enroll(try localEnrollmentDevice()) })
    completed.signal()
  }
  let request = try runtimeRequest(runtime)
  #expect(request.kind == .deviceEnroll)
  #expect(throws: RelayEnrollmentError.unavailable) { try exchange.enroll(try localEnrollmentDevice()) }
  try runtime.write(contentsOf: RemoteWire.encode(RuntimeEnrollmentExchange().response))
  #expect(completed.wait(timeout: .now() + 1) == .success)
  guard let completedResult = result.get() else { throw RelayEnrollmentError.unavailable }
  _ = try completedResult.get()
  #expect(!supervisor.isStoppedForTesting)
}

@Test func supervisorRejectsReceiptWithTrailingPartialFrame() throws {
  let (host, runtime) = try fd198SocketPair()
  defer { host.closeFile(); runtime.closeFile() }
  let supervisor = try testSupervisor(host, runtime: runtime)
  let response = RuntimeEnrollmentExchange().response
  let responseBytes = try RemoteWire.encode(response) + Data([0, 0, 0])
  DispatchQueue.global().async {
    _ = runtime.availableData
    try? runtime.write(contentsOf: responseBytes)
  }
  let exchange = try supervisor.enrollmentExchange()
  #expect(throws: RelayEnrollmentError.unavailable) { try exchange.enroll(try localEnrollmentDevice()) }
  #expect(supervisor.isStoppedForTesting)
}

@Test func supervisorFailsClosedWhenRuntimeDoesNotReplyBeforeDeadline() throws {
  let (host, runtime) = try fd198SocketPair()
  defer { host.closeFile(); runtime.closeFile() }
  let supervisor = try testSupervisor(host, runtime: runtime, timeout: 1)
  let exchange = try supervisor.enrollmentExchange()
  #expect(throws: RelayEnrollmentError.unavailable) { try exchange.enroll(try localEnrollmentDevice()) }
  #expect(supervisor.isStoppedForTesting)
}

@Test func supervisorUsesOneDeadlineAcrossDripFedPartialBytes() throws {
  let (host, runtime) = try fd198SocketPair()
  defer { host.closeFile(); runtime.closeFile() }
  let supervisor = try testSupervisor(host, runtime: runtime, timeout: 10)
  let runtimeDescriptor = runtime.fileDescriptor
  let partialSent = DispatchSemaphore(value: 0)
  DispatchQueue.global().async {
    // Capture the raw descriptor before dispatch. The test's defer can close
    // its FileHandle after the assertion, so an asynchronous fixture must not
    // touch FileHandle state while that teardown races.
    var readiness = pollfd(fd: runtimeDescriptor, events: Int16(POLLIN), revents: 0)
    guard poll(&readiness, 1, 1_000) > 0 else { return }
    var request = [UInt8](repeating: 0, count: 64)
    _ = read(runtimeDescriptor, &request, request.count)
    let partial: [UInt8] = [0, 0, 0]
    _ = partial.withUnsafeBytes { send(runtimeDescriptor, $0.baseAddress, partial.count, 0) }
    partialSent.signal()
    usleep(100_000)
  }
  let exchange = try supervisor.enrollmentExchange()
  let started = DispatchTime.now().uptimeNanoseconds
  #expect(throws: RelayEnrollmentError.unavailable) { try exchange.enroll(try localEnrollmentDevice()) }
  let elapsed = DispatchTime.now().uptimeNanoseconds - started
  #expect(elapsed < 50_000_000)
  #expect(partialSent.wait(timeout: .now() + 1) == .success)
}
