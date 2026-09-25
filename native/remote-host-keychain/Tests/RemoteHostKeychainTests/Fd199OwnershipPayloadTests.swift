import CryptoKit
import Foundation
import Testing
@testable import RemoteHostKeychain

@Test("the signing operation admits a canonical 49-history manifest above four KiB")
func ownershipManifestAboveFourKiB() throws {
  let files = (0..<49).map { index in
    "{\"name\":\"sessions/session_\(String(format: "%08d", index)).jsonl\",\"sha256\":\"\(String(repeating: "a", count: 64))\",\"size\":1}"
  }.joined(separator: ",")
  let payload = Data("{\"exportId\":\"handoff_export_0001\",\"files\":[\(files)],\"ownerState\":\"web-owner-stopped\",\"stoppedAt\":\"2026-09-24T00:00:00.000Z\",\"version\":3}".utf8)
  #expect(payload.count == 6_400)
  try validateFd199OwnershipPayload(payload)
}

private let digest = String(repeating: "b", count: 64)
private let legacyExport = "{\"exportId\":\"legacy_export_0001\",\"files\":[{\"name\":\"sessions/legacy.jsonl\",\"sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"size\":1}],\"ownerState\":\"web-owner-stopped\",\"stoppedAt\":\"2026-09-24T00:00:00Z\",\"version\":2}"
private let legacyActivation = "{\"exportId\":\"legacy_export_0001\",\"generation\":1,\"manifestDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"version\":2}"

@Test("fixed Host proof payloads retain their original version and signature bytes", arguments: [legacyExport, legacyActivation])
func ownershipGoldenPayload(_ text: String) throws {
  let key = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
  let bytes = Data(text.utf8)
  let signature = try key.signature(for: bytes)
  try validateFd199OwnershipPayload(bytes)
  #expect(key.publicKey.isValidSignature(signature, for: bytes))
  let nextVersion = Data(text.replacingOccurrences(of: "\"version\":2", with: "\"version\":3").utf8)
  try validateFd199OwnershipPayload(nextVersion)
  #expect(!key.publicKey.isValidSignature(signature, for: nextVersion))
}

private func entry(name: String = "sessions/a.jsonl", size: Int = 1) -> String {
  "{\"name\":\"\(name)\",\"sha256\":\"\(digest)\",\"size\":\(size)}"
}

private func export(_ entries: [String], version: Int = 3, stoppedAt: String = "2026-09-24T00:00:00.000Z") -> Data {
  Data("{\"exportId\":\"handoff_export_0001\",\"files\":[\(entries.joined(separator: ","))],\"ownerState\":\"web-owner-stopped\",\"stoppedAt\":\"\(stoppedAt)\",\"version\":\(version)}".utf8)
}

@Test("the maximum file count and longest names fit the signing budget")
func ownershipMaximumManifest() throws {
  let entries = (0..<8_192).map { index in
    entry(name: "sessions/" + String(repeating: "a", count: 88) + String(format: "%08d", index) + ".jsonl", size: 16_384)
  }
  let payload = export(entries)
  #expect(payload.count > 1_700_000)
  #expect(payload.count < fd199MaximumOwnershipPayloadBytes)
  try validateFd199OwnershipPayload(payload)
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(export(entries + [entry(name: "sessions/extra.jsonl")])) }
}

@Test("version-specific file sizes and aggregate accounting retain their exact limits")
func ownershipByteQuotas() throws {
  try validateFd199OwnershipPayload(export([entry(size: 128 * 1024 * 1024)]))
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(export([entry(size: 128 * 1024 * 1024 + 1)])) }
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(export([entry(size: 128 * 1024 * 1024), entry(name: "sessions/b.jsonl")])) }
  try validateFd199OwnershipPayload(export([entry(size: 8 * 1024 * 1024)], version: 2))
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(export([entry(size: 8 * 1024 * 1024 + 1)], version: 2)) }
  let legacyMaximum = (0..<16).map { entry(name: "sessions/s\($0).jsonl", size: 8 * 1024 * 1024) }
  try validateFd199OwnershipPayload(export(legacyMaximum, version: 2))
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(export(legacyMaximum + [entry()], version: 2)) }
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(export([entry(size: 0)])) }
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(export([])) }
}

@Test("unique names apply to version three without narrowing legacy version two")
func ownershipDuplicateNames() throws {
  try validateFd199OwnershipPayload(export([entry(), entry()], version: 2))
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(export([entry(), entry()])) }
  try validateFd199OwnershipPayload(export([entry(name: "attachments/" + digest)]))
}

@Test("the encoded payload limit is enforced before parsing")
func ownershipEncodedBounds() throws {
  let base = export([entry()], stoppedAt: "2026-09-24T00:00:00.0Z")
  let stoppedAt = "2026-09-24T00:00:00." + String(repeating: "0", count: fd199MaximumOwnershipPayloadBytes - base.count + 1) + "Z"
  let exact = export([entry()], stoppedAt: stoppedAt)
  #expect(exact.count == fd199MaximumOwnershipPayloadBytes)
  try validateFd199OwnershipPayload(exact)
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(exact + Data([0x20])) }
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(Data()) }
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(Data([0xff])) }
}

@Test("export signing refuses malformed or noncanonical payloads", arguments: [
  "", "[]", "null", "{}",
  legacyExport.replacingOccurrences(of: "\"version\":2", with: "\"version\":1"),
  legacyExport.replacingOccurrences(of: "\"version\":2", with: "\"version\":4"),
  legacyExport.replacingOccurrences(of: "\"version\":2", with: "\"version\":true"),
  legacyExport.replacingOccurrences(of: "\"version\":2", with: "\"version\":2.0"),
  legacyExport.replacingOccurrences(of: "\"version\":2", with: "\"version\":2e0"),
  legacyExport.replacingOccurrences(of: "\"version\":2", with: "\"version\":2,\"version\":2"),
  legacyExport.replacingOccurrences(of: "\"size\":1", with: "\"size\":true"),
  legacyExport.replacingOccurrences(of: "\"size\":1", with: "\"size\":-1"),
  legacyExport.replacingOccurrences(of: "\"size\":1", with: "\"size\":1.5"),
  legacyExport.replacingOccurrences(of: "\"size\":1", with: "\"size\":1.0"),
  legacyExport.replacingOccurrences(of: "\"size\":1", with: "\"size\":9223372036854775808"),
  legacyExport.replacingOccurrences(of: "\"size\":1", with: "\"size\":18446744073709551616"),
  legacyExport.replacingOccurrences(of: "\"size\":1", with: "\"size\":1,\"extra\":1"),
  legacyExport.replacingOccurrences(of: "\"size\":1", with: "\"size\":1,\"size\":1"),
  legacyExport.replacingOccurrences(of: "\"version\":2", with: "\"extra\":1,\"version\":2"),
  legacyExport.replacingOccurrences(of: "\"files\":[", with: "\"files\":null,\"ignored\":["),
  legacyExport.replacingOccurrences(of: "legacy_export_0001", with: "short"),
  legacyExport.replacingOccurrences(of: "legacy_export_0001", with: "legacy_export_0001\\n"),
  legacyExport.replacingOccurrences(of: "sessions/legacy.jsonl", with: "sessions/../legacy.jsonl"),
  legacyExport.replacingOccurrences(of: "sessions/legacy.jsonl", with: "sessions/legacy.jsonl\\n"),
  legacyExport.replacingOccurrences(of: "sessions/legacy.jsonl", with: "sessions\\/legacy.jsonl"),
  legacyExport.replacingOccurrences(of: "sessions/legacy.jsonl", with: "sessions/\\u006cegacy.jsonl"),
  legacyExport.replacingOccurrences(of: "web-owner-stopped", with: "web-owner-active"),
  legacyExport.replacingOccurrences(of: "2026-09-24T00:00:00Z", with: "2026-09-24T00:00:00Z\\n"),
  legacyExport.replacingOccurrences(of: "bbbb", with: "BBBB"),
  legacyExport.replacingOccurrences(of: "\"files\":", with: "\"generation\":1,\"files\":"),
  legacyExport.replacingOccurrences(of: ":2", with: ": 2"),
  legacyExport + "\n",
  "{\"exportId\":\"legacy_export_0001\",\"files\":[],\"signAnything\":\"allowed before strict validation\"}",
])
func rejectsOwnershipExport(_ text: String) {
  #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(Data(text.utf8)) }
}

@Test("activation signing admits only the exact bounded generation and digest")
func ownershipActivationBounds() throws {
  try validateFd199OwnershipPayload(Data(legacyActivation.replacingOccurrences(of: "\"generation\":1", with: "\"generation\":2147483647").utf8))
  for generation in ["0", "-1", "true", "1.0", "1e0", "1.5", "2147483648", "9223372036854775808", "null", "\"1\""] {
    let text = legacyActivation.replacingOccurrences(of: "\"generation\":1", with: "\"generation\":\(generation)")
    #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(Data(text.utf8)) }
  }
  for text in [
    legacyActivation.replacingOccurrences(of: "\"generation\":1,", with: ""),
    legacyActivation.replacingOccurrences(of: "\"generation\":1", with: "\"generation\":1,\"generation\":1"),
    legacyActivation.replacingOccurrences(of: "\"version\":2", with: "\"version\":2,\"extra\":1"),
    legacyActivation.replacingOccurrences(of: "bbbb", with: "BBBB"),
    legacyActivation.replacingOccurrences(of: "legacy_export_0001", with: "invalid"),
    "{\"version\":2,\"exportId\":\"legacy_export_0001\",\"generation\":1,\"manifestDigest\":\"\(digest)\"}",
  ] {
    #expect(throws: (any Error).self) { try validateFd199OwnershipPayload(Data(text.utf8)) }
  }
}
