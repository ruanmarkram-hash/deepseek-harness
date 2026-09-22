import CryptoKit
import Darwin
import Foundation

/** Public projection of an already authorized native route. No token or private key is stored here. */
struct PairingRepairTarget: Codable, Equatable, Sendable {
  let deviceId: String
  let deviceEnrollmentId: String
  let hostEnrollmentId: String
  let signingPublicKey: String
  let agreementPublicKey: String
  let routeId: String
  let hostDeviceId: String
  let generation: Int
}

enum PairingRepairError: Error { case ineligible, unsafePath, changed, io, recoveryRequired, runtimeRunning, noJournal }
enum PairingRepairResult: String, Sendable {
  case repaired = "Matching public pairing records repaired. Native credentials and epochs were not changed. Recoverable originals are retained locally."
  case recovered = "An interrupted repair was rolled back to its exact originals. Review pairing state before trying again."
  case alreadyRepaired = "This repair is already complete. No records were changed."
}

/** Strictly scoped two-file transaction. Interrupted work is rolled back, never silently rolled forward. */
enum PairingStateRepair {
  struct Plan {
    let devices: Data
    let host: Data
  }

  static func plan(devices originalDevices: Data, host originalHost: Data, target: PairingRepairTarget) throws -> Plan {
    guard var deviceRoot = try JSONSerialization.jsonObject(with: originalDevices) as? [String: Any],
          var hostRoot = try JSONSerialization.jsonObject(with: originalHost) as? [String: Any],
          let deviceUnit = deviceRoot["unit"] as? [String: Any], deviceUnit["name"] as? String == "remote_devices", exactInteger(deviceUnit["version"]) == 1,
          let hostUnit = hostRoot["unit"] as? [String: Any], hostUnit["name"] as? String == "remote_host_v3", exactInteger(hostUnit["version"]) == 1,
          var deviceTables = deviceRoot["tables"] as? [String: Any], Set(deviceTables.keys) == ["devices"],
          var devices = deviceTables["devices"] as? [String: Any], devices.count == 1,
          var device = devices[target.deviceId] as? [String: Any],
          device["id"] as? String == target.deviceId,
          device["label"] as? String == "Paired iPhone",
          device["signingPublicKey"] as? String == target.signingPublicKey,
          device["agreementPublicKey"] as? String == target.agreementPublicKey,
          let oldDeviceEnrollment = device["incarnation"] as? String,
          var hostTables = hostRoot["tables"] as? [String: Any], Set(hostTables.keys) == ["host", "routes"],
          var hosts = hostTables["host"] as? [String: Any], hosts.count == 1,
          var identity = hosts["identity"] as? [String: Any],
          let oldHostEnrollment = identity["hostEnrollmentId"] as? String,
          var routes = hostTables["routes"] as? [String: Any], routes.count == 1,
          var route = routes[target.deviceId] as? [String: Any],
          route["deviceId"] as? String == target.deviceId,
          route["deviceEnrollmentId"] as? String == oldDeviceEnrollment,
          route["hostEnrollmentId"] as? String == oldHostEnrollment,
          let oldHostDeviceId = route["hostDeviceId"] as? String,
          oldHostDeviceId.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$", options: .regularExpression) != nil,
          let oldRoute = route["routeId"] as? String, !oldRoute.isEmpty,
          exactInteger(route["generation"]).map({ $0 > 0 }) == true,
          exactInteger(route["lastConnectionEpoch"]) == 0,
          route["pendingConnectionEpoch"] == nil,
          device["revoked"] == nil, route["revoked"] == nil,
          target.generation > 0, !oldDeviceEnrollment.isEmpty, !oldHostEnrollment.isEmpty,
          oldDeviceEnrollment != target.deviceEnrollmentId, oldHostEnrollment != target.hostEnrollmentId
    else { throw PairingRepairError.ineligible }
    device["incarnation"] = target.deviceEnrollmentId
    identity["hostEnrollmentId"] = target.hostEnrollmentId
    route["routeId"] = target.routeId
    route["hostDeviceId"] = target.hostDeviceId
    route["deviceEnrollmentId"] = target.deviceEnrollmentId
    route["hostEnrollmentId"] = target.hostEnrollmentId
    route["generation"] = target.generation
    devices[target.deviceId] = device
    hosts["identity"] = identity
    routes[target.deviceId] = route
    deviceTables["devices"] = devices
    hostTables["host"] = hosts
    hostTables["routes"] = routes
    deviceRoot["tables"] = deviceTables
    hostRoot["tables"] = hostTables
    let updatedDevices = try JSONSerialization.data(withJSONObject: deviceRoot, options: [.sortedKeys])
    let updatedHost = try JSONSerialization.data(withJSONObject: hostRoot, options: [.sortedKeys])
    guard updatedDevices.count <= PairingStateFileReader.maximumBytes,
          updatedHost.count <= PairingStateFileReader.maximumBytes else { throw PairingRepairError.ineligible }
    return Plan(devices: updatedDevices, host: updatedHost)
  }

  private static func exactInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue == Double(number.intValue) else { return nil }
    return number.intValue
  }

  /** Startup and activation must not serve partially replaced or unverified public records. */
  static func requireSettled(home: URL) throws {
    let files: RepairFiles
    do { files = try RepairFiles(home: home, create: false) }
    catch PairingRepairError.noJournal { return }
    defer { files.close() }
    guard let journal = try files.journal() else { return }
    guard journal.state != .prepared else { throw PairingRepairError.recoveryRequired }
  }

  /** Caller holds native route admission and a stopped-runtime reservation throughout this operation. */
  static func perform(home: URL, target: PairingRepairTarget, afterFirstWrite: () throws -> Void = {}) throws -> PairingRepairResult {
    let files = try RepairFiles(home: home)
    defer { files.close() }
    if let journal = try files.journal() {
      guard journal.target == target else { throw PairingRepairError.recoveryRequired }
      if journal.state == .committed {
        guard try files.matches(journal, target: true) else { throw PairingRepairError.changed }
        return .alreadyRepaired
      }
      if journal.state == .prepared {
        try files.rollback(journal)
        return .recovered
      }
      // A rolled-back journal is retained as the backup for this same repair.
      guard try files.matches(journal, target: false) else { throw PairingRepairError.changed }
    }
    let originals = try files.originals()
    let plan = try plan(devices: originals.0.data, host: originals.1.data, target: target)
    var journal = Journal(version: 1, target: target, state: .prepared,
      devices: Entry(original: originals.0.data, updated: plan.devices, mode: originals.0.mode),
      host: Entry(original: originals.1.data, updated: plan.host, mode: originals.1.mode))
    try files.save(journal)
    do {
      guard try files.matches(journal, target: false) else { throw PairingRepairError.changed }
      try files.replace(.devices, expected: journal.devices.original, new: journal.devices.updated, mode: journal.devices.mode)
      try afterFirstWrite()
      try files.replace(.host, expected: journal.host.original, new: journal.host.updated, mode: journal.host.mode)
      journal.state = .committed
      try files.save(journal)
      return .repaired
    } catch {
      do { try files.rollback(journal) }
      catch { throw PairingRepairError.recoveryRequired }
      throw PairingRepairError.io
    }
  }

  fileprivate struct Entry: Codable {
    let original: Data
    let updated: Data
    let mode: mode_t
    let originalHash: String
    let updatedHash: String
    init(original: Data, updated: Data, mode: mode_t) {
      self.original = original; self.updated = updated; self.mode = mode
      originalHash = digest(original); updatedHash = digest(updated)
    }
    var valid: Bool {
      mode & 0o077 == 0 && mode & 0o600 == 0o600 &&
      original.count <= PairingStateFileReader.maximumBytes && updated.count <= PairingStateFileReader.maximumBytes &&
      digest(original) == originalHash && digest(updated) == updatedHash
    }
  }
  fileprivate struct Journal: Codable {
    enum State: String, Codable { case prepared, committed, rolledBack }
    let version: Int
    let target: PairingRepairTarget
    var state: State
    let devices: Entry
    let host: Entry
  }
  fileprivate static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}

/** Private local files only, opened relative to held descriptors; no symlinks, ACLs, or hard links. */
private final class RepairFiles {
  private var root: Int32 = -1
  private var storage: Int32 = -1
  private var backup: Int32 = -1
  private var lockFile: Int32 = -1
  private static let directory = ".pairing-repair"
  private static let journalName = "journal.json"

  init(home: URL, create: Bool = true) throws {
    do {
      guard home.isFileURL, home.standardizedFileURL.path == home.path,
            home.resolvingSymlinksInPath().path == home.path else { throw PairingRepairError.unsafePath }
      root = open(home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      if root < 0, !create, errno == ENOENT { throw PairingRepairError.noJournal }
      try validate(root, directory: true)
      storage = openat(root, "storages", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      if storage < 0, !create, errno == ENOENT { throw PairingRepairError.noJournal }
      try validate(storage, directory: true)
      if create {
        guard mkdirat(storage, Self.directory, 0o700) == 0 || errno == EEXIST else { throw PairingRepairError.io }
      }
      backup = openat(storage, Self.directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      if backup < 0, !create, errno == ENOENT { throw PairingRepairError.noJournal }
      try validate(backup, directory: true)
      lockFile = openat(backup, "lock", O_RDWR | (create ? O_CREAT : 0) | O_NOFOLLOW | O_CLOEXEC, 0o600)
      try validate(lockFile, directory: false)
      guard flock(lockFile, LOCK_EX | LOCK_NB) == 0 else { throw PairingRepairError.recoveryRequired }
      if create { guard fsync(storage) == 0 else { throw PairingRepairError.io } }
    } catch { close(); throw error }
  }

  func close() {
    for fd in [lockFile, backup, storage, root] where fd >= 0 { Darwin.close(fd) }
    lockFile = -1; backup = -1; storage = -1; root = -1
  }

  private func validate(_ fd: Int32, directory: Bool) throws {
    var info = stat()
    guard fd >= 0, fstat(fd, &info) == 0, info.st_uid == getuid(),
          info.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG),
          info.st_mode & 0o077 == 0,
          directory || (info.st_nlink == 1 && info.st_mode & 0o600 == 0o600)
    else { throw PairingRepairError.unsafePath }
    if let acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED) {
      defer { acl_free(UnsafeMutableRawPointer(acl)) }
      var entry: acl_entry_t?
      guard acl_get_entry(acl, Int32(ACL_FIRST_ENTRY.rawValue), &entry) == -1 else { throw PairingRepairError.unsafePath }
    } else if errno != ENOENT { throw PairingRepairError.unsafePath }
  }

  private func read(_ directory: Int32, _ name: String, limit: Int) throws -> (data: Data, mode: mode_t) {
    let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw PairingRepairError.io }
    defer { Darwin.close(fd) }
    try validate(fd, directory: false)
    var info = stat()
    guard fstat(fd, &info) == 0 else { throw PairingRepairError.io }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    let data = try handle.read(upToCount: limit + 1) ?? Data()
    guard data.count <= limit else { throw PairingRepairError.unsafePath }
    return (data, info.st_mode & 0o777)
  }

  func originals() throws -> ((data: Data, mode: mode_t), (data: Data, mode: mode_t)) {
    (try read(storage, PairingStateFile.devices.rawValue, limit: PairingStateFileReader.maximumBytes),
     try read(storage, PairingStateFile.host.rawValue, limit: PairingStateFileReader.maximumBytes))
  }

  func journal() throws -> PairingStateRepair.Journal? {
    var info = stat()
    if fstatat(backup, Self.journalName, &info, AT_SYMLINK_NOFOLLOW) != 0 {
      guard errno == ENOENT else { throw PairingRepairError.io }
      return nil
    }
    let data = try read(backup, Self.journalName, limit: 6 * PairingStateFileReader.maximumBytes).data
    let journal = try JSONDecoder().decode(PairingStateRepair.Journal.self, from: data)
    guard journal.version == 1, journal.devices.valid, journal.host.valid else { throw PairingRepairError.recoveryRequired }
    let expected = try PairingStateRepair.plan(devices: journal.devices.original, host: journal.host.original, target: journal.target)
    guard expected.devices == journal.devices.updated, expected.host == journal.host.updated else { throw PairingRepairError.recoveryRequired }
    return journal
  }

  func save(_ journal: PairingStateRepair.Journal) throws {
    try atomicWrite(backup, Self.journalName, data: JSONEncoder().encode(journal), mode: 0o600)
  }

  func matches(_ journal: PairingStateRepair.Journal, target: Bool) throws -> Bool {
    let current = try originals()
    return current.0.data == (target ? journal.devices.updated : journal.devices.original) &&
      current.1.data == (target ? journal.host.updated : journal.host.original) &&
      current.0.mode == journal.devices.mode && current.1.mode == journal.host.mode
  }

  func replace(_ file: PairingStateFile, expected: Data, new: Data, mode: mode_t) throws {
    let current = try read(storage, file.rawValue, limit: PairingStateFileReader.maximumBytes)
    guard current.data == expected, current.mode == mode else { throw PairingRepairError.changed }
    try atomicWrite(storage, file.rawValue, data: new, mode: mode)
  }

  func rollback(_ journal: PairingStateRepair.Journal) throws {
    let current = try originals()
    guard [journal.devices.original, journal.devices.updated].contains(current.0.data),
          [journal.host.original, journal.host.updated].contains(current.1.data),
          current.0.mode == journal.devices.mode, current.1.mode == journal.host.mode
    else { throw PairingRepairError.changed }
    if current.0.data != journal.devices.original { try replace(.devices, expected: current.0.data, new: journal.devices.original, mode: journal.devices.mode) }
    if current.1.data != journal.host.original { try replace(.host, expected: current.1.data, new: journal.host.original, mode: journal.host.mode) }
    var completed = journal; completed.state = .rolledBack
    try save(completed)
  }

  private func atomicWrite(_ directory: Int32, _ name: String, data: Data, mode: mode_t) throws {
    let temporary = ".repair-" + UUID().uuidString
    let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
    guard fd >= 0 else { throw PairingRepairError.io }
    defer { Darwin.close(fd); unlinkat(directory, temporary, 0) }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    try handle.write(contentsOf: data)
    guard fchmod(fd, mode) == 0, fsync(fd) == 0,
          renameat(directory, temporary, directory, name) == 0, fsync(directory) == 0
    else { throw PairingRepairError.io }
  }
}

/** Prevents any loopback Web listener from taking the configured port during the offline repair. */
final class PairingRepairPortReservation {
  private let descriptor: Int32
  init(port: Int) throws {
    guard (1...65_535).contains(port) else { throw PairingRepairError.ineligible }
    descriptor = socket(AF_INET, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw PairingRepairError.runtimeRunning }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = UInt16(port).bigEndian
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard result == 0 else { Darwin.close(descriptor); throw PairingRepairError.runtimeRunning }
  }
  deinit { Darwin.close(descriptor) }
}
