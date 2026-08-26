import Darwin
import Foundation

/**
 The opaque FD199 private journal: one state file inside an exclusively owned
 directory, reached only through a verified directory descriptor with
 O_NOFOLLOW relative operations. Node never learns the path; the authority
 itself enforces owner, mode, and atomic replace-on-transition.
 */
public final class Fd199Journal: @unchecked Sendable {
  /// Fixed state file name relative to the journal directory.
  public static let stateFilename = "fd199-state.json"
  static let maximumStateBytes = 2 * 1024 * 1024
  static let idPattern = "^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$"
  static let instantPattern = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$"

  private let lock = NSLock()
  private let directoryDescriptor: Int32
  private let identity: Fd199SigningIdentity

  /**
   Opens and validates the journal directory. The directory must exist, be
   owned by the effective user, and allow no group or other access.
   - Parameters:
     - root: Absolute journal directory path (never caller-controlled at runtime).
     - identity: The signing identity whose proofs the journal revalidates.
   */
  public init(root: String, identity: Fd199SigningIdentity) throws {
    guard root.hasPrefix("/"), !root.hasSuffix("/") || root == "/" else { throw Fd199Error.journal }
    let descriptor = open(root, O_EVTONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else {
      // ELOOP here means the root itself is a symlink: refused, not followed.
      throw Fd199Error.journal
    }
    var status = stat()
    guard fstat(descriptor, &status) == 0 else {
      close(descriptor)
      throw Fd199Error.journal
    }
    guard status.st_uid == geteuid(), status.st_mode & 0o077 == 0 else {
      close(descriptor)
      throw Fd199Error.journal
    }
    self.directoryDescriptor = descriptor
    self.identity = identity
  }

  deinit {
    close(directoryDescriptor)
  }

  /**
   Serializes one mutation (or verified read) against every other journal
   instance in every process sharing this directory: the instance lock orders
   our own fibers while an advisory `flock` on the directory inode excludes
   sibling processes for the whole read-and-replace interval, not just the
   final rename.
   */
  private func performExclusively<T>(_ body: () throws -> T) throws -> T {
    lock.lock()
    defer { lock.unlock() }
    guard flock(directoryDescriptor, LOCK_EX) == 0 else { throw Fd199Error.journal }
    defer { flock(directoryDescriptor, LOCK_UN) }
    return try body()
  }

  /**
   Reads and fully revalidates the durable record, or returns `nil` when no
   journal exists yet. A record whose proofs or manifest digest disagree with
   its own content throws instead of being reported.
   */
  public func recoverVerified() throws -> Fd199JournalRecord? {
    try performExclusively {
      guard let data = try readState() else { return nil }
      return try verify(Fd199Journal.decode(data))
    }
  }

  /// Validates every durable proof before exposing or promoting a record.
  /// Callers already hold the journal's exclusive lock when invoking this.
  private func verify(_ record: Fd199JournalRecord) throws -> Fd199JournalRecord {
    try Fd199Proofs.verifyExport(
      record.exportProof,
      identity: identity,
      exportId: record.exportId,
      stoppedAt: record.stoppedAt,
      manifest: record.manifest
    )
    guard Fd199Proofs.manifestDigest(record.manifest) == record.manifestDigest else { throw Fd199Error.proof }
    if record.status == .activated {
      guard let activationProof = record.activationProof else { throw Fd199Error.journal }
      try Fd199Proofs.verifyActivation(
        activationProof,
        identity: identity,
        exportId: record.exportId,
        manifestDigest: record.manifestDigest,
        generation: record.generation
      )
    } else if record.activationProof != nil {
        throw Fd199Error.journal
    }
    return record
  }

  /**
   Atomically stages the prepared record. The caller has already verified the
   export and signed the proof; this write is the durable staging point.
   */
  public func stageExported(_ record: Fd199JournalRecord) throws {
    try performExclusively {
      guard record.status == .exported, record.activationProof == nil else { throw Fd199Error.journal }
      try writeState(Fd199Journal.encode(record))
    }
  }

  /// Test/legacy journal fixture seam. Production ownership transfer stages
  /// `exported` and promotes only after a real child reap.
  public func stagePrepared(_ record: Fd199JournalRecord) throws {
    try performExclusively {
      guard record.status == .prepared, record.activationProof == nil else { throw Fd199Error.journal }
      try writeState(Fd199Journal.encode(record))
    }
  }

  /** Promotes only the exact exported record after the child confirms release is beginning. */
  public func transitionExportedToReleasing(_ expected: Fd199JournalRecord) throws -> Fd199JournalRecord? {
    try performExclusively {
      guard expected.status == .exported else { throw Fd199Error.journal }
      guard let current = try readState(), current == Fd199Journal.encode(expected) else { return nil }
      let next = Fd199JournalRecord(version: expected.version, exportId: expected.exportId, stoppedAt: expected.stoppedAt, generation: expected.generation, status: .releasing, exportProof: expected.exportProof, activationProof: nil, manifest: expected.manifest, manifestDigest: expected.manifestDigest)
      try writeState(Fd199Journal.encode(next))
      return next
    }
  }

  /** Makes a reaped former owner's durable export adoptable, and only then. */
  public func promoteReleasingToPrepared() throws -> Fd199JournalRecord? {
    try performExclusively {
      guard let data = try readState() else { return nil }
      let current = try verify(Fd199Journal.decode(data))
      guard current.status == .releasing else { return nil }
      let next = Fd199JournalRecord(version: current.version, exportId: current.exportId, stoppedAt: current.stoppedAt, generation: current.generation, status: .prepared, exportProof: current.exportProof, activationProof: nil, manifest: current.manifest, manifestDigest: current.manifestDigest)
      try writeState(Fd199Journal.encode(next))
      return next
    }
  }

  /**
   Atomically consumes the prepared record into the activated record. The
   write only lands when the durable bytes still equal the expected prepared
   record exactly, which is the journal's compare-and-set against replayed
   or concurrent claims.
   - Returns: Whether the transition happened.
   */
  public func transitionPrepared(expected: Fd199JournalRecord, next: Fd199JournalRecord) throws -> Bool {
    try performExclusively {
      guard expected.status == .prepared, next.status == .activated, next.activationProof != nil else { throw Fd199Error.journal }
      let expectedBytes = Fd199Journal.encode(expected)
      guard let current = try readState(), current == expectedBytes else { return false }
      try writeState(Fd199Journal.encode(next))
      return true
    }
  }

  // MARK: - Descriptor-relative state I/O

  private func readState() throws -> Data? {
    let descriptor = openat(directoryDescriptor, Fd199Journal.stateFilename, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else {
      if errno == ENOENT { return nil }
      throw Fd199Error.journal
    }
    defer { close(descriptor) }
    var status = stat()
    guard fstat(descriptor, &status) == 0, status.st_uid == geteuid(),
          status.st_size >= 0, status.st_size <= Fd199Journal.maximumStateBytes else { throw Fd199Error.journal }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 65_536)
    while true {
      let count = read(descriptor, &buffer, buffer.count)
      if count < 0 {
        if errno == EINTR { continue }
        throw Fd199Error.journal
      }
      if count == 0 { break }
      data.append(contentsOf: buffer[0..<count])
      if data.count > Fd199Journal.maximumStateBytes { throw Fd199Error.bounds }
    }
    return data
  }

  /// Writes one complete state file through a same-directory temporary and a
  /// single rename, so a crash leaves either the old or the new record.
  private func writeState(_ data: Data) throws {
    let temporary = "fd199-state.\(getpid()).\(UInt32.random(in: 0..<UInt32.max)).tmp"
    let descriptor = openat(directoryDescriptor, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw Fd199Error.journal }
    var renamed = false
    defer {
      close(descriptor)
      if !renamed {
        unlinkat(directoryDescriptor, temporary, 0)
      }
    }
    try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      var offset = 0
      while offset < raw.count {
        let count = write(descriptor, raw.baseAddress!.advanced(by: offset), raw.count - offset)
        if count <= 0 {
          if count < 0, errno == EINTR { continue }
          throw Fd199Error.journal
        }
        offset += count
      }
      guard fsync(descriptor) == 0 else { throw Fd199Error.journal }
    }
    guard renameat(directoryDescriptor, temporary, directoryDescriptor, Fd199Journal.stateFilename) == 0 else {
      throw Fd199Error.journal
    }
    renamed = true
  }

  // MARK: - Record encoding

  static func encode(_ record: Fd199JournalRecord) -> Data {
    let manifest = record.manifest.map { entry in
      "{\"name\":\(jsonString(entry.name)),\"sha256\":\(jsonString(entry.sha256)),\"size\":\(entry.size)}"
    }.joined(separator: ",")
    let activationProofField: String
    if let activationProof = record.activationProof {
      activationProofField = jsonString(activationProof)
    } else {
      activationProofField = "null"
    }
    let text = "{\"activationProof\":\(activationProofField),\"exportId\":\(jsonString(record.exportId)),\"exportProof\":\(jsonString(record.exportProof)),\"generation\":\(record.generation),\"manifest\":[\(manifest)],\"manifestDigest\":\(jsonString(record.manifestDigest)),\"status\":\"\(fd199StatusText(record.status))\",\"stoppedAt\":\(jsonString(record.stoppedAt)),\"version\":\(record.version)}"
    return Data(text.utf8)
  }

  static func decode(_ data: Data) throws -> Fd199JournalRecord {
    let object = try fd199StrictObject(data)
    try fd199ExactKeys(object, [
      "activationProof", "exportId", "exportProof", "generation",
      "manifest", "manifestDigest", "status", "stoppedAt", "version",
    ])
    guard let version = object["version"] as? Int, version == Fd199Proofs.recordVersion else { throw Fd199Error.journal }
    let exportId = try fd199String(object["exportId"])
    guard exportId.range(of: Fd199Journal.idPattern, options: .regularExpression) != nil else { throw Fd199Error.journal }
    let stoppedAt = try fd199String(object["stoppedAt"])
    guard stoppedAt.range(of: Fd199Journal.instantPattern, options: .regularExpression) != nil else { throw Fd199Error.journal }
    let generation = try fd199Generation(object["generation"], minimum: 0)
    let status = try fd199Status(object["status"])
    let exportProof = try fd199String(object["exportProof"])
    let manifestDigest = try fd199String(object["manifestDigest"])
    guard manifestDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw Fd199Error.journal }
    guard let manifestValue = object["manifest"] as? [[String: Any]], !manifestValue.isEmpty,
          manifestValue.count <= fd199MaximumFiles else { throw Fd199Error.journal }
    var manifest = [Fd199ManifestEntry]()
    var total = 0
    for entry in manifestValue {
      try fd199ExactKeys(entry, ["name", "sha256", "size"])
      let name = try fd199String(entry["name"])
      let sha256 = try fd199String(entry["sha256"])
      let size = try fd199Generation(entry["size"], minimum: 1)
      guard name.range(of: fd199ExportNamePattern, options: .regularExpression) != nil else { throw Fd199Error.journal }
      guard sha256.range(of: fd256HexPattern, options: .regularExpression) != nil else { throw Fd199Error.journal }
      guard size <= fd199MaximumFileBytes else { throw Fd199Error.bounds }
      total += size
      guard total <= 128 * 1024 * 1024 else { throw Fd199Error.bounds }
      manifest.append(Fd199ManifestEntry(name: name, sha256: sha256, size: size))
    }
    let activationProof: String?
    if let value = object["activationProof"] as? String {
      activationProof = value
    } else if object["activationProof"] is NSNull {
      activationProof = nil
    } else {
      throw Fd199Error.journal
    }
    switch status {
    case .exported, .releasing, .prepared:
      guard activationProof == nil, generation >= 0 else { throw Fd199Error.journal }
    case .activated:
      guard activationProof != nil, generation >= 1 else { throw Fd199Error.journal }
    case .none:
      throw Fd199Error.journal
    }
    return Fd199JournalRecord(
      version: version,
      exportId: exportId,
      stoppedAt: stoppedAt,
      generation: generation,
      status: status,
      exportProof: exportProof,
      activationProof: activationProof,
      manifest: manifest,
      manifestDigest: manifestDigest
    )
  }
}
