import Darwin
import Foundation
import Testing
@testable import RemoteHostApp

private let repairTarget = PairingRepairTarget(deviceId: "phone", deviceEnrollmentId: "new-device", hostEnrollmentId: "new-host", signingPublicKey: "signing", agreementPublicKey: "agreement", routeId: "new-route", hostDeviceId: "host", generation: 1)

private func repairFixture(epoch: Any = 0, pending: Bool = false, key: String = "signing") throws -> (Data, Data) {
  let device: [String: Any] = ["id": "phone", "incarnation": "old-device", "label": "Paired iPhone", "signingPublicKey": key, "agreementPublicKey": "agreement", "enrolledAt": "unchanged", "otherMetadata": ["preserve": true]]
  var route: [String: Any] = ["routeId": "old-route", "deviceId": "phone", "deviceEnrollmentId": "old-device", "hostDeviceId": "host", "hostEnrollmentId": "old-host", "generation": 1, "lastConnectionEpoch": epoch, "createdAt": "unchanged"]
  if pending { route["pendingConnectionEpoch"] = 1 }
  return (
    try JSONSerialization.data(withJSONObject: ["unit": ["name": "remote_devices", "version": 1], "global": ["untouched": true], "tables": ["devices": ["phone": device]]]),
    try JSONSerialization.data(withJSONObject: ["unit": ["name": "remote_host_v3", "version": 1], "global": ["untouched": true], "tables": ["host": ["identity": ["hostEnrollmentId": "old-host"]], "routes": ["phone": route]]])
  )
}

private func withRepairFixture(_ operation: (URL, Data, Data) throws -> Void) throws {
  let home = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: home, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  defer { try? FileManager.default.removeItem(at: home) }
  let storage = home.appendingPathComponent("storages")
  try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  let (devices, host) = try repairFixture()
  for (name, data) in [("remote_devices.json", devices), ("remote_host_v3.json", host)] {
    let path = storage.appendingPathComponent(name)
    try data.write(to: path)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
  }
  try operation(home, devices, host)
}

@Test("same-phone repair preserves unrelated JSON and replaces only authoritative public coordinates")
func pairingRepairPlan() throws {
  let (devices, host) = try repairFixture()
  let plan = try PairingStateRepair.plan(devices: devices, host: host, target: repairTarget)
  let deviceJSON = try #require(JSONSerialization.jsonObject(with: plan.devices) as? [String: Any])
  let deviceTables = try #require(deviceJSON["tables"] as? [String: [String: [String: Any]]])
  #expect(deviceTables["devices"]?["phone"]?["incarnation"] as? String == "new-device")
  #expect(deviceTables["devices"]?["phone"]?["enrolledAt"] as? String == "unchanged")
  #expect((deviceTables["devices"]?["phone"]?["otherMetadata"] as? [String: Bool])?["preserve"] == true)
  #expect((deviceJSON["global"] as? [String: Bool])?["untouched"] == true)
  let hostJSON = try #require(JSONSerialization.jsonObject(with: plan.host) as? [String: Any])
  let tables = try #require(hostJSON["tables"] as? [String: [String: [String: Any]]])
  #expect(tables["routes"]?["phone"]?["routeId"] as? String == "new-route")
  #expect(tables["routes"]?["phone"]?["lastConnectionEpoch"] as? Int == 0)
  #expect(tables["routes"]?["phone"]?["createdAt"] as? String == "unchanged")
}

@Test("repair rejects used epochs, pending epochs, boolean epochs, and another phone key")
func pairingRepairRejectsAmbiguousRecords() throws {
  for fixture in [try repairFixture(epoch: 1), try repairFixture(pending: true), try repairFixture(epoch: false), try repairFixture(key: "another-key")] {
    #expect(throws: PairingRepairError.self) { try PairingStateRepair.plan(devices: fixture.0, host: fixture.1, target: repairTarget) }
  }
  let (devices, host) = try repairFixture()
  var decoded = try #require(JSONSerialization.jsonObject(with: devices) as? [String: Any])
  decoded["tables"] = ["devices": ["phone": [:], "extra": [:]]]
  #expect(throws: PairingRepairError.self) { try PairingStateRepair.plan(devices: JSONSerialization.data(withJSONObject: decoded), host: host, target: repairTarget) }
}

@Test("repair requires both incarnation mismatches and exact supported unit metadata")
func pairingRepairScope() throws {
  let (devices, host) = try repairFixture()
  var decoded = try #require(JSONSerialization.jsonObject(with: devices) as? [String: Any])
  for unit in [["name": "remote_devices", "version": true] as [String: Any], ["name": "remote_devices", "version": 2], ["name": "other", "version": 1]] {
    decoded["unit"] = unit
    #expect(throws: PairingRepairError.self) { try PairingStateRepair.plan(devices: JSONSerialization.data(withJSONObject: decoded), host: host, target: repairTarget) }
  }
  let oneMismatch = PairingRepairTarget(deviceId: "phone", deviceEnrollmentId: "old-device", hostEnrollmentId: "new-host", signingPublicKey: "signing", agreementPublicKey: "agreement", routeId: "new-route", hostDeviceId: "host", generation: 1)
  #expect(throws: PairingRepairError.self) { try PairingStateRepair.plan(devices: devices, host: host, target: oneMismatch) }
}

@Test("repair rejects serialized target growth before opening a journal")
func pairingRepairOutputLimit() throws {
  let (devices, host) = try repairFixture()
  var decoded = try #require(JSONSerialization.jsonObject(with: devices) as? [String: Any])
  decoded["padding"] = String(repeating: "/", count: 600_000)
  let boundedOriginal = try JSONSerialization.data(withJSONObject: decoded, options: [.withoutEscapingSlashes])
  #expect(boundedOriginal.count < PairingStateFileReader.maximumBytes)
  #expect(throws: PairingRepairError.self) { try PairingStateRepair.plan(devices: boundedOriginal, host: host, target: repairTarget) }
}

@Test("repair retains protected originals, atomically updates both files, and is idempotent")
func pairingRepairTransaction() throws {
  try withRepairFixture { home, devices, host in
    #expect(try PairingStateRepair.perform(home: home, target: repairTarget) == .repaired)
    let journalURL = home.appendingPathComponent("storages/.pairing-repair/journal.json")
    let journal = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: journalURL)) as? [String: Any])
    let savedDevices = try #require(journal["devices"] as? [String: Any])
    let savedHost = try #require(journal["host"] as? [String: Any])
    #expect(Data(base64Encoded: savedDevices["original"] as! String) == devices)
    #expect(Data(base64Encoded: savedHost["original"] as! String) == host)
    #expect(journal["state"] as? String == "committed")
    for path in [journalURL, home.appendingPathComponent("storages/remote_devices.json"), home.appendingPathComponent("storages/remote_host_v3.json")] {
      #expect((try FileManager.default.attributesOfItem(atPath: path.path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }
    #expect(try PairingStateRepair.perform(home: home, target: repairTarget) == .alreadyRepaired)
  }
}

@Test("a second-file failure restores the exact preimages")
func pairingRepairRollback() throws {
  try withRepairFixture { home, devices, host in
    #expect(throws: PairingRepairError.self) {
      try PairingStateRepair.perform(home: home, target: repairTarget, afterFirstWrite: { throw PairingRepairError.io })
    }
    let restoredDevices = try Data(contentsOf: home.appendingPathComponent("storages/remote_devices.json"))
    let restoredHost = try Data(contentsOf: home.appendingPathComponent("storages/remote_host_v3.json"))
    #expect(restoredDevices == devices)
    #expect(restoredHost == host)
  }
}

@Test("interrupted prepared journal recovers before another repair")
func pairingRepairCrashRecovery() throws {
  try withRepairFixture { home, devices, host in
    _ = try PairingStateRepair.perform(home: home, target: repairTarget)
    let journalURL = home.appendingPathComponent("storages/.pairing-repair/journal.json")
    var journal = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: journalURL)) as? [String: Any])
    journal["state"] = "prepared"
    try JSONSerialization.data(withJSONObject: journal).write(to: journalURL)
    try host.write(to: home.appendingPathComponent("storages/remote_host_v3.json"))
    #expect(throws: PairingRepairError.self) { try PairingStateRepair.requireSettled(home: home) }
    #expect(try PairingStateRepair.perform(home: home, target: repairTarget) == .recovered)
    #expect(try Data(contentsOf: home.appendingPathComponent("storages/remote_devices.json")) == devices)
    #expect(try Data(contentsOf: home.appendingPathComponent("storages/remote_host_v3.json")) == host)
  }
}

@Test("startup rejects corrupt and unsupported journals but allows later legitimate epoch changes")
func pairingRepairStartupAdmission() throws {
  try withRepairFixture { home, _, _ in
    try PairingStateRepair.requireSettled(home: home)
    #expect(!FileManager.default.fileExists(atPath: home.appendingPathComponent("storages/.pairing-repair").path))
    _ = try PairingStateRepair.perform(home: home, target: repairTarget)
    let hostPath = home.appendingPathComponent("storages/remote_host_v3.json")
    var current = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: hostPath)) as? [String: Any])
    current["laterMetadata"] = true
    try JSONSerialization.data(withJSONObject: current).write(to: hostPath)
    try PairingStateRepair.requireSettled(home: home)
    let journalURL = home.appendingPathComponent("storages/.pairing-repair/journal.json")
    var journal = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: journalURL)) as? [String: Any])
    journal["version"] = 2
    try JSONSerialization.data(withJSONObject: journal).write(to: journalURL)
    #expect(throws: PairingRepairError.self) { try PairingStateRepair.requireSettled(home: home) }
    try Data("invalid".utf8).write(to: journalURL)
    #expect(throws: (any Error).self) { try PairingStateRepair.requireSettled(home: home) }
  }
  let missing = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
  try PairingStateRepair.requireSettled(home: missing)
  #expect(!FileManager.default.fileExists(atPath: missing.path))
}

@Test("repair refuses to roll back a third-party change")
func pairingRepairPreservesConcurrentChange() throws {
  try withRepairFixture { home, _, _ in
    let changed = Data("{\"thirdParty\":true}".utf8)
    let hostPath = home.appendingPathComponent("storages/remote_host_v3.json")
    #expect(throws: PairingRepairError.self) {
      try PairingStateRepair.perform(home: home, target: repairTarget, afterFirstWrite: { try changed.write(to: hostPath) })
    }
    let firstObserved = try Data(contentsOf: hostPath)
    #expect(firstObserved == changed)
    #expect(throws: PairingRepairError.self) { try PairingStateRepair.perform(home: home, target: repairTarget) }
    let secondObserved = try Data(contentsOf: hostPath)
    #expect(secondObserved == changed)
  }
}

@Test("repair refuses linked storage and leaves public originals untouched")
func pairingRepairRejectsLinks() throws {
  try withRepairFixture { home, devices, _ in
    let path = home.appendingPathComponent("storages/remote_devices.json")
    let destination = home.appendingPathComponent("original.json")
    try FileManager.default.moveItem(at: path, to: destination)
    try FileManager.default.createSymbolicLink(at: path, withDestinationURL: destination)
    #expect(throws: PairingRepairError.self) { try PairingStateRepair.perform(home: home, target: repairTarget) }
    #expect(try Data(contentsOf: destination) == devices)
  }
}
