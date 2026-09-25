import CoreFoundation
import Foundation

enum Fd199OwnershipPayloadError: Error {
  case invalidInput
}

/// The production journal is bounded at two MiB, so no recoverable proof needs a larger payload.
let fd199MaximumOwnershipPayloadBytes = 2 * 1024 * 1024

/**
 Admits only canonical version-2/3 export or activation payloads before any
 Keychain access. Byte equality with the reconstructed fixed-key-order JSON
 rejects duplicate keys, alternate encodings, and extra fields without
 changing the bytes covered by existing version-2 signatures.
 */
func validateFd199OwnershipPayload(_ payload: Data) throws {
  guard !payload.isEmpty, payload.count <= fd199MaximumOwnershipPayloadBytes,
        let object = try JSONSerialization.jsonObject(with: payload) as? [String: Any]
  else { throw Fd199OwnershipPayloadError.invalidInput }
  let exportId = try ownershipString(object["exportId"], matching: "[A-Za-z0-9][A-Za-z0-9_-]{15,95}")
  let version = try ownershipInteger(object["version"], minimum: 2, maximum: 3)
  let canonical: String
  if object["files"] != nil {
    try ownershipKeys(object, ["exportId", "files", "ownerState", "stoppedAt", "version"])
    guard object["ownerState"] as? String == "web-owner-stopped",
          let files = object["files"] as? [[String: Any]], !files.isEmpty, files.count <= 8_192
    else { throw Fd199OwnershipPayloadError.invalidInput }
    let stoppedAt = try ownershipString(object["stoppedAt"], matching: "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z")
    let maximumExportBytes = 128 * 1024 * 1024
    var remaining = maximumExportBytes
    var names = Set<String>()
    var entries = [String]()
    for file in files {
      try ownershipKeys(file, ["name", "sha256", "size"])
      let name = try ownershipString(file["name"], matching: "(?:sessions/[A-Za-z0-9][A-Za-z0-9_-]{0,95}\\.jsonl|attachments/[a-f0-9]{64})")
      let sha256 = try ownershipString(file["sha256"], matching: "[a-f0-9]{64}")
      let size = try ownershipInteger(file["size"], minimum: 1, maximum: version == 2 ? 8 * 1024 * 1024 : maximumExportBytes)
      guard size <= remaining else { throw Fd199OwnershipPayloadError.invalidInput }
      remaining -= size
      if version == 3, !names.insert(name).inserted { throw Fd199OwnershipPayloadError.invalidInput }
      // Every string above is restricted to ASCII without JSON escapes.
      entries.append("{\"name\":\"\(name)\",\"sha256\":\"\(sha256)\",\"size\":\(size)}")
    }
    canonical = "{\"exportId\":\"\(exportId)\",\"files\":[\(entries.joined(separator: ","))],\"ownerState\":\"web-owner-stopped\",\"stoppedAt\":\"\(stoppedAt)\",\"version\":\(version)}"
  } else {
    try ownershipKeys(object, ["exportId", "generation", "manifestDigest", "version"])
    let generation = try ownershipInteger(object["generation"], minimum: 1, maximum: 2_147_483_647)
    let digest = try ownershipString(object["manifestDigest"], matching: "[a-f0-9]{64}")
    canonical = "{\"exportId\":\"\(exportId)\",\"generation\":\(generation),\"manifestDigest\":\"\(digest)\",\"version\":\(version)}"
  }
  guard payload == Data(canonical.utf8) else { throw Fd199OwnershipPayloadError.invalidInput }
}

private func ownershipKeys(_ object: [String: Any], _ keys: Set<String>) throws {
  guard Set(object.keys) == keys else { throw Fd199OwnershipPayloadError.invalidInput }
}

private func ownershipString(_ value: Any?, matching pattern: String) throws -> String {
  guard let text = value as? String,
        text.range(of: "^(?:\(pattern))$", options: .regularExpression) == text.startIndex..<text.endIndex
  else { throw Fd199OwnershipPayloadError.invalidInput }
  return text
}

private func ownershipInteger(_ value: Any?, minimum: Int, maximum: Int) throws -> Int {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
        let integer = number as? Int, integer >= minimum, integer <= maximum,
        number == NSNumber(value: integer)
  else { throw Fd199OwnershipPayloadError.invalidInput }
  return integer
}
