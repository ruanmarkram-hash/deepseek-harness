import Foundation
import Testing
@testable import RemoteHostApp

private let diagnosticIdentity = PairingStatePublicIdentity(
  deviceId: "private-device-id", deviceEnrollmentId: "private-device-enrollment",
  hostEnrollmentId: "private-host-enrollment", hostDeviceId: "private-host-id", signingPublicKey: "private-signing-key",
  agreementPublicKey: "private-agreement-key"
)
private let diagnosticHome = URL(fileURLWithPath: "/fixture")

private func diagnosticFiles(deviceEnrollment: String = "private-device-enrollment", hostEnrollment: String = "private-host-enrollment", hostDeviceId: String = "private-host-id", empty: Bool = false) throws -> [PairingStateFile: Data] {
  let device: [String: String] = [
    "id": "private-device-id", "incarnation": deviceEnrollment, "label": "Paired iPhone",
    "signingPublicKey": "private-signing-key", "agreementPublicKey": "private-agreement-key",
  ]
  return [
    .devices: try JSONSerialization.data(withJSONObject: ["tables": ["devices": empty ? [:] : ["private-device-id": device]]]),
    .host: try JSONSerialization.data(withJSONObject: ["tables": ["host": empty ? [:] : ["identity": ["hostEnrollmentId": hostEnrollment]], "routes": empty ? [:] : ["private-device-id": ["hostDeviceId": hostDeviceId]]]]),
  ]
}

@Test("pairing diagnostic renders a value-free exact-match transcript")
func pairingDiagnosticMatchingSnapshot() throws {
  let files = try diagnosticFiles()
  let result = PairingStateDiagnostic.check(activeIdentity: { diagnosticIdentity }, sealedHome: { diagnosticHome }, read: { _, file in files[file]! })
  #expect(result.text == """
  Active pairing credential present: true
  Public device record present: true
  Device ID matches: true
  Device enrollment matches: true
  Device signing key matches: true
  Device agreement key matches: true
  Device label matches hosted runtime: true
  Public Host record present: true
  Host enrollment matches: true
  Public route record present: true
  Route Host device ID matches: true

  Read-only check. No pairing or runtime state was changed. Matching records do not prove a live connection.
  """)
  #expect(!result.text.contains("private-"))
}

@Test("pairing diagnostic distinguishes enrollment conflicts without disclosing identifiers")
func pairingDiagnosticConflicts() throws {
  let files = try diagnosticFiles(deviceEnrollment: "different-device", hostEnrollment: "different-host")
  let result = PairingStateDiagnostic.check(activeIdentity: { diagnosticIdentity }, sealedHome: { diagnosticHome }, read: { _, file in files[file]! })
  #expect(result.text.contains("Device enrollment matches: false"))
  #expect(result.text.contains("Host enrollment matches: false"))
  #expect(result.text.contains("Device signing key matches: true"))
  #expect(!result.text.contains("different-"))
}

@Test("pairing diagnostic reports absent records independently of matching fields")
func pairingDiagnosticMissingRecords() throws {
  let files = try diagnosticFiles(empty: true)
  let result = PairingStateDiagnostic.check(activeIdentity: { diagnosticIdentity }, sealedHome: { diagnosticHome }, read: { _, file in files[file]! })
  #expect(result.text.contains("Public device record present: false"))
  #expect(result.text.contains("Public Host record present: false"))
  #expect(result.text.contains("Public route record present: false"))
  #expect(result.text.contains("Route Host device ID matches: false"))
}

@Test("diagnostic distinguishes a route Host identity mismatch without exposing either identifier")
func pairingDiagnosticRouteHostMismatch() throws {
  let files = try diagnosticFiles(hostDeviceId: "different-private-host-id")
  let result = PairingStateDiagnostic.check(activeIdentity: { diagnosticIdentity }, sealedHome: { diagnosticHome }, read: { _, file in files[file]! })
  #expect(result.text.contains("Public route record present: true"))
  #expect(result.text.contains("Route Host device ID matches: false"))
  #expect(result.text.contains("Host enrollment matches: true"))
  #expect(!result.text.contains("private-"))
}

@Test("missing pairing never reads configuration or public files")
func pairingDiagnosticNoCredential() {
  var called = false
  let result = PairingStateDiagnostic.check(activeIdentity: { nil }, sealedHome: { called = true; return diagnosticHome }, read: { _, _ in called = true; return Data() })
  #expect(!called)
  #expect(result.text.hasPrefix("Active pairing credential present: false"))
}

private struct SensitiveDiagnosticError: Error, CustomStringConvertible {
  var description: String { "TOKEN_VALUE_NEVER_RENDER" }
}

@Test("credential and sealed-configuration failures suppress arbitrary error descriptions")
func pairingDiagnosticSanitizedErrors() {
  let credentialFailure = PairingStateDiagnostic.check(activeIdentity: { throw SensitiveDiagnosticError() }, sealedHome: { diagnosticHome })
  #expect(credentialFailure.text.hasPrefix("Active pairing credential could not be read or validated."))
  let configurationFailure = PairingStateDiagnostic.check(activeIdentity: { diagnosticIdentity }, sealedHome: { throw SensitiveDiagnosticError() })
  #expect(configurationFailure.text.hasPrefix("Signed hosted-runtime configuration could not be validated."))
  #expect(!credentialFailure.text.contains("TOKEN_VALUE"))
  #expect(!configurationFailure.text.contains("TOKEN_VALUE"))
}

@Test("directory read and decode failures identify only the affected public file")
func pairingDiagnosticDirectoryFailures() throws {
  let files = try diagnosticFiles()
  let missing = PairingStateDiagnostic.check(activeIdentity: { diagnosticIdentity }, sealedHome: { diagnosticHome }, read: { _, _ in throw PairingStateReadError.missing })
  #expect(missing.text.hasPrefix("Public device directory is missing."))
  let invalidHost = PairingStateDiagnostic.check(activeIdentity: { diagnosticIdentity }, sealedHome: { diagnosticHome }, read: { _, file in file == .devices ? files[file]! : Data("TOKEN_VALUE_NEVER_RENDER".utf8) })
  #expect(invalidHost.text.hasPrefix("Public Host directory could not be decoded."))
  #expect(!invalidHost.text.contains("TOKEN_VALUE"))
  let unsafe = PairingStateDiagnostic.check(activeIdentity: { diagnosticIdentity }, sealedHome: { diagnosticHome }, read: { _, _ in throw PairingStateReadError.unsafePath })
  #expect(unsafe.text.contains("unsupported or unsafe path"))
  let oversized = PairingStateDiagnostic.check(activeIdentity: { diagnosticIdentity }, sealedHome: { diagnosticHome }, read: { _, _ in throw PairingStateReadError.oversized })
  #expect(oversized.text.contains("size limit"))
}

private func withDiagnosticHome(_ operation: (URL, URL) throws -> Void) throws {
  let home = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString, isDirectory: true)
  try FileManager.default.createDirectory(at: home.appendingPathComponent("storages"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  defer { try? FileManager.default.removeItem(at: home) }
  try operation(home, home.appendingPathComponent("storages/remote_devices.json"))
}

@Test("diagnostic file reader reads without modifying the bounded public file")
func pairingDiagnosticReader() throws {
  try withDiagnosticHome { home, file in
    let bytes = Data("{}".utf8)
    try bytes.write(to: file)
    let before = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
    #expect(try PairingStateFileReader.read(home: home, file: .devices) == bytes)
    #expect(try Data(contentsOf: file) == bytes)
    #expect(try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date == before)
  }
}

@Test("diagnostic reader rejects oversized files, symlinks and writable-by-others files")
func pairingDiagnosticReaderRejectsUnsafeFiles() throws {
  try withDiagnosticHome { home, file in
    try Data(repeating: 1, count: PairingStateFileReader.maximumBytes + 1).write(to: file)
    #expect(throws: PairingStateReadError.self) { try PairingStateFileReader.read(home: home, file: .devices) }
    try FileManager.default.removeItem(at: file)
    let target = home.appendingPathComponent("target.json")
    try Data("{}".utf8).write(to: target)
    try FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
    #expect(throws: PairingStateReadError.self) { try PairingStateFileReader.read(home: home, file: .devices) }
    try FileManager.default.removeItem(at: file)
    try Data("{}".utf8).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: file.path)
    #expect(throws: PairingStateReadError.self) { try PairingStateFileReader.read(home: home, file: .devices) }
  }
}
