import Darwin
import Foundation
import RemoteHostRelay
import RemoteHostRuntimeBootstrap
import RemoteHostWire
import Security

private let privateRuntimeDescriptor = RemoteHostV3GatewayBootstrap.privateDescriptor
private let enrollmentService = "com.deepseek.dsh.runtime.enrollment.v1"

private struct StoredEnrollment: Codable {
  let deviceId: String
  let label: String
  let signingPublicKey: String
  let agreementPublicKey: String
  let deviceEnrollmentId: String
  let hostEnrollmentId: String
}

private func closeUnrelatedDescriptors(keeping descriptor: Int32) {
  for candidate in 0..<getdtablesize() where candidate != Int(descriptor) { close(Int32(candidate)) }
}

private func writeAll(_ data: Data, to descriptor: Int32) -> Bool {
  data.withUnsafeBytes { buffer in
    guard let baseAddress = buffer.baseAddress else { return data.isEmpty }
    var offset = 0
    while offset < data.count {
      let written = Darwin.write(descriptor, baseAddress.advanced(by: offset), data.count - offset)
      if written > 0 { offset += written; continue }
      if written == -1, errno == EINTR { continue }
      return false
    }
    return true
  }
}

private func keychainData(account: String) -> Data? {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: enrollmentService,
    kSecAttrAccount as String: account,
    kSecReturnData as String: true,
  ]
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
  return item as? Data
}

private func storeKeychainData(_ data: Data, account: String) -> Bool {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: enrollmentService,
    kSecAttrAccount as String: account,
  ]
  let attributes: [String: Any] = [kSecValueData as String: data]
  let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
  if update == errSecSuccess { return true }
  guard update == errSecItemNotFound else { return false }
  var insert = query
  insert[kSecValueData as String] = data
  return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
}

private func opaqueIdentifier() -> String? {
  var bytes = [UInt8](repeating: 0, count: 12)
  guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
  let encoded = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  guard encoded.count == 16 else { return nil }
  let first = encoded.first.map { $0.isLetter || $0.isNumber } == true ? encoded : "r" + encoded.dropFirst()
  return first
}

private func enrolledRecord(for device: RelayEnrollmentDevice) -> RemoteWireRecord? {
  let hostEnrollmentId: String
  if let data = keychainData(account: "host-enrollment"), let stored = String(data: data, encoding: .utf8), stored.count >= 16 { hostEnrollmentId = stored }
  else {
    guard let generated = opaqueIdentifier(), storeKeychainData(Data(generated.utf8), account: "host-enrollment") else { return nil }
    hostEnrollmentId = generated
  }
  let account = "device-" + device.deviceId
  let existing = keychainData(account: account).flatMap { try? JSONDecoder().decode(StoredEnrollment.self, from: $0) }
  let stored: StoredEnrollment
  if let existing,
     existing.deviceId == device.deviceId,
     existing.label == device.label,
     existing.signingPublicKey == device.signingPublicKey,
     existing.agreementPublicKey == device.agreementPublicKey {
    stored = existing
  } else {
    guard let deviceEnrollmentId = opaqueIdentifier() else { return nil }
    stored = StoredEnrollment(deviceId: device.deviceId, label: device.label, signingPublicKey: device.signingPublicKey, agreementPublicKey: device.agreementPublicKey, deviceEnrollmentId: deviceEnrollmentId, hostEnrollmentId: hostEnrollmentId)
    guard let encoded = try? JSONEncoder().encode(stored), storeKeychainData(encoded, account: account) else { return nil }
  }
  guard let metadata = try? JSONSerialization.data(withJSONObject: [
    "deviceId": stored.deviceId, "label": stored.label,
    "signingPublicKey": stored.signingPublicKey, "agreementPublicKey": stored.agreementPublicKey,
    "deviceEnrollmentId": stored.deviceEnrollmentId, "hostEnrollmentId": stored.hostEnrollmentId,
  ], options: [.sortedKeys]) else { return nil }
  return RemoteWireRecord(kind: .deviceEnrolled, metadata: metadata)
}

guard (try? RemoteHostV3GatewayBootstrap.validatePrivateRuntimeInvocation(Array(CommandLine.arguments.dropFirst()))) != nil else { exit(1) }
guard fcntl(privateRuntimeDescriptor, F_SETFD, FD_CLOEXEC) != -1 else { exit(1) }
var noSigPipe: Int32 = 1
guard setsockopt(privateRuntimeDescriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0 else { exit(1) }
closeUnrelatedDescriptors(keeping: privateRuntimeDescriptor)
let readyRecord = RemoteWireRecord(kind: .runtimeReady)
guard (try? RemoteHostV3GatewayBootstrap.validate(readyRecord, direction: .gatewayToHost)) != nil,
      let ready = try? RemoteWire.encode(readyRecord),
      writeAll(ready, to: privateRuntimeDescriptor)
else { exit(1) }

let channel = FileHandle(fileDescriptor: privateRuntimeDescriptor, closeOnDealloc: false)
var buffer = Data()
while true {
  let data = channel.availableData
  guard !data.isEmpty else { exit(0) }
  buffer.append(data)
  guard let records = try? RemoteWire.consume(&buffer) else { exit(1) }
  for record in records {
    guard (try? RemoteHostV3GatewayBootstrap.validate(record, direction: .hostToGateway)) != nil,
          let device = try? RelayEnrollmentWireCodec.enrollmentRequest(record),
          let response = enrolledRecord(for: device),
          (try? RemoteHostV3GatewayBootstrap.validate(response, direction: .gatewayToHost)) != nil,
          let encoded = try? RemoteWire.encode(response),
          writeAll(encoded, to: privateRuntimeDescriptor)
    else { exit(1) }
  }
}
