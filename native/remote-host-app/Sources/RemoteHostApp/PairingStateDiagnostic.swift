import Darwin
import Foundation

/** Public comparison inputs only; no credential or invitation can enter a report. */
struct PairingStatePublicIdentity {
  let deviceId: String
  let deviceEnrollmentId: String
  let hostEnrollmentId: String
  let hostDeviceId: String
  let signingPublicKey: String
  let agreementPublicKey: String
}

/** Fixed presentation vocabulary. Arbitrary errors and stored values are never rendered. */
struct PairingStateReport: Equatable {
  let text: String
}

/** Reads existing enrollment facts without starting, repairing, or authorizing a connection. */
enum PairingStateDiagnostic {
  private struct Device: Decodable {
    let id: String
    let incarnation: String
    let label: String
    let signingPublicKey: String
    let agreementPublicKey: String
  }
  private struct Devices: Decodable {
    struct Tables: Decodable { let devices: [String: Device] }
    let tables: Tables
  }
  private struct Host: Decodable { let hostEnrollmentId: String }
  private struct Route: Decodable { let hostDeviceId: String }
  private struct Hosts: Decodable {
    struct Tables: Decodable {
      let host: [String: Host]
      let routes: [String: Route]?
    }
    let tables: Tables
  }

  static func check(
    activeIdentity: () throws -> PairingStatePublicIdentity?,
    sealedHome: () throws -> URL,
    read: (URL, PairingStateFile) throws -> Data = PairingStateFileReader.read
  ) -> PairingStateReport {
    let identity: PairingStatePublicIdentity
    do {
      guard let active = try activeIdentity() else {
        return report("Active pairing credential present: false")
      }
      identity = active
    } catch { return report("Active pairing credential could not be read or validated. Authorization was not changed.") }
    let home: URL
    do { home = try sealedHome() }
    catch { return report("Signed hosted-runtime configuration could not be validated.") }

    let devicesData: Data
    do { devicesData = try read(home, .devices) }
    catch { return report(readFailure(error, file: .devices)) }
    let hostData: Data
    do { hostData = try read(home, .host) }
    catch { return report(readFailure(error, file: .host)) }
    let devices: Devices
    do { devices = try JSONDecoder().decode(Devices.self, from: devicesData) }
    catch { return report("Public device directory could not be decoded.") }
    let hosts: Hosts
    do { hosts = try JSONDecoder().decode(Hosts.self, from: hostData) }
    catch { return report("Public Host directory could not be decoded.") }
    let device = devices.tables.devices[identity.deviceId]
    let host = hosts.tables.host["identity"]
    let route = hosts.tables.routes?[identity.deviceId]
    return report([
      "Active pairing credential present: true",
      "Public device record present: \(device != nil)",
      "Device ID matches: \(device?.id == identity.deviceId)",
      "Device enrollment matches: \(device?.incarnation == identity.deviceEnrollmentId)",
      "Device signing key matches: \(device?.signingPublicKey == identity.signingPublicKey)",
      "Device agreement key matches: \(device?.agreementPublicKey == identity.agreementPublicKey)",
      "Device label matches hosted runtime: \(device?.label == "Paired iPhone")",
      "Public Host record present: \(host != nil)",
      "Host enrollment matches: \(host?.hostEnrollmentId == identity.hostEnrollmentId)",
      "Public route record present: \(route != nil)",
      "Route Host device ID matches: \(route?.hostDeviceId == identity.hostDeviceId)",
    ].joined(separator: "\n"))
  }

  private static func report(_ detail: String) -> PairingStateReport {
    PairingStateReport(text: detail + "\n\nRead-only check. No pairing or runtime state was changed. Matching records do not prove a live connection.")
  }

  private static func readFailure(_ error: Error, file: PairingStateFile) -> String {
    let subject = file == .devices ? "Public device directory" : "Public Host directory"
    switch error as? PairingStateReadError {
    case .missing: return subject + " is missing."
    case .unsafePath: return subject + " has an unsupported or unsafe path."
    case .oversized: return subject + " exceeds the diagnostic size limit."
    default: return subject + " could not be read."
    }
  }
}

enum PairingStateFile: String {
  case devices = "remote_devices.json"
  case host = "remote_host_v3.json"
}

enum PairingStateReadError: Error { case missing, unsafePath, oversized, unreadable }

/** Fixed JSON-backend files under the sealed DSH home; descriptors never follow links. */
enum PairingStateFileReader {
  static let maximumBytes = 1_048_576

  static func read(home: URL, file: PairingStateFile) throws -> Data {
    guard home.isFileURL, home.path.hasPrefix("/"),
          home.standardizedFileURL.path == home.path,
          home.resolvingSymlinksInPath().path == home.path
    else { throw PairingStateReadError.unsafePath }
    let root = open(home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard root >= 0 else { throw openError() }
    defer { close(root) }
    try validate(root, directory: true)
    let storage = openat(root, "storages", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard storage >= 0 else { throw openError() }
    defer { close(storage) }
    try validate(storage, directory: true)
    let descriptor = openat(storage, file.rawValue, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard descriptor >= 0 else { throw openError() }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    try validate(descriptor, directory: false)
    let data: Data
    do { data = try handle.read(upToCount: maximumBytes + 1) ?? Data() }
    catch { throw PairingStateReadError.unreadable }
    guard data.count <= maximumBytes else { throw PairingStateReadError.oversized }
    return data
  }

  private static func validate(_ descriptor: Int32, directory: Bool) throws {
    var info = stat()
    guard fstat(descriptor, &info) == 0,
          info.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG),
          info.st_uid == getuid() || info.st_uid == 0,
          info.st_mode & 0o022 == 0
    else { throw PairingStateReadError.unsafePath }
  }

  private static func openError() -> PairingStateReadError {
    if errno == ENOENT { return .missing }
    if errno == ELOOP || errno == ENOTDIR { return .unsafePath }
    return .unreadable
  }
}
