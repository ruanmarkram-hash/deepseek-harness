import CryptoKit
import Darwin
import Foundation

/**
 The signed-Host FD199 authority. It owns one end of the kernel-private
 socketpair to a hosted runtime child, verifies every exported byte, signs
 and stages the ownership journal, drives the release barrier, and consumes
 the explicit activation gate. The child never supplies paths, proof
 material, or journal bytes; it only streams verified export entries.
 */
public final class Fd199AuthorityService: @unchecked Sendable {
  /// One decoded export entry awaiting the release barrier.
  struct PendingExport {
    let name: String
    let sha256: String
    let bytes: Data
  }

  enum Phase: Equatable {
    case idle
    case streamingFiles
    case awaitingReleased
    case finished
  }

  private let lock = NSLock()
  private let identity: Fd199SigningIdentity
  private let hostAppPath: String
  private let journal: Fd199Journal
  private let channel: FileHandle
  /// Readability callbacks may arrive while the preceding chunk is still
  /// decoding. This per-service serial queue preserves the socket byte order
  /// across those callbacks; a concurrent global queue can otherwise process
  /// `prepare.complete` before its preceding `prepare.file`.
  private let consumeQueue = DispatchQueue(label: "com.deepseek.dsh.fd199-authority-consume")
  private var buffer = [UInt8]()
  /// Frames decoded but not yet dispatched; stop() drops them.
  private var pendingFrames = [Data]()
  private var phase: Phase = .idle
  /// The Host-issued instruction the child must be answering right now, if any.
  /// Frames advancing ownership without a matching armed instruction are refused.
  private var expectedInstruction: Fd199InstructionAction?
  /// Set only after the child has completed the FD199 `recover` exchange.
  /// This is deliberately distinct from V3 `runtime.ready`, which is emitted
  /// only after a prepared adopter consumes activation and binds FD198.
  private var recovered = false
  private var recoveredStatus: Fd199OwnershipStatus?
  private var desktopReady = false
  private var pending = [PendingExport]()
  private var exportedRecord: Fd199JournalRecord?
  private var closed = false

  /**
   - Parameters:
     - identity: The protected Host signing identity for proofs.
     - hostAppPath: The absolute path of this signed Host application.
     - journal: The opened private journal.
     - channel: The authority-side FileHandle of the accepted socketpair.
   */
  public init(identity: Fd199SigningIdentity, hostAppPath: String, journal: Fd199Journal, channel: FileHandle) {
    self.identity = identity
    self.hostAppPath = hostAppPath
    self.journal = journal
    self.channel = channel
  }

  /**
   Starts serving the protocol until the peer misbehaves, closes, or `stop()`
   runs. Returns immediately; work continues on a background queue.
   */
  public func serve() {
    channel.readabilityHandler = { [weak self] handle in
      guard let self else { handle.readabilityHandler = nil; return }
      let data = handle.availableData
      if data.isEmpty {
        self.stop()
        return
      }
      self.consumeQueue.async { self.consume(data) }
    }
  }

  /// Stops serving and releases the channel.
  public func stop() {
    lock.lock()
    let alreadyClosed = closed
    closed = true
    buffer.removeAll(keepingCapacity: false)
    pendingFrames.removeAll(keepingCapacity: false)
    lock.unlock()
    guard !alreadyClosed else { return }
    channel.readabilityHandler = nil
    try? channel.close()
  }

  /// Test-only liveness probe mirroring the supervisor's testing seams.
  public var isStoppedForTesting: Bool {
    lock.lock()
    defer { lock.unlock() }
    return closed
  }

  /** True once the child has completed its FD199 recovery handshake. */
  public var hasRecovered: Bool {
    lock.lock()
    defer { lock.unlock() }
    return recovered
  }
  public var hasDesktopReady: Bool { lock.lock(); defer { lock.unlock() }; return desktopReady }

  /** The native-verified ownership snapshot that completed `recover`. */
  public var recoveredOwnershipStatus: Fd199OwnershipStatus? {
    lock.lock()
    defer { lock.unlock() }
    return recoveredStatus
  }

  /// Pushes one lifecycle instruction toward the child and arms it as the
  /// only transition the child may now answer with.
  public func instruct(_ action: Fd199InstructionAction) throws {
    lock.lock()
    defer { lock.unlock() }
    try sendLocked(.instruct(action: action))
    expectedInstruction = action
  }

  // MARK: - Frame consumption

  private func consume(_ chunk: Data) {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    if buffer.count + chunk.count > fd199MaximumBodyBytes + 4 {
        lock.unlock()
        stop()
        return
    }
    // Plain arrays keep integer indexes stable; sliced Data would shift its
    // startIndex after removeFirst and corrupt every later range.
    buffer.append(contentsOf: chunk)
    var frames = [Data]()
    while buffer.count >= 4 {
      let bodyLength = Int(buffer[0]) << 24 | Int(buffer[1]) << 16 | Int(buffer[2]) << 8 | Int(buffer[3])
      if bodyLength <= 2 || bodyLength > fd199MaximumBodyBytes {
        lock.unlock()
        stop()
        return
      }
      if buffer.count < 4 + bodyLength { break }
      frames.append(Data(buffer[4..<(4 + bodyLength)]))
      buffer.removeFirst(4 + bodyLength)
    }
    pendingFrames.append(contentsOf: frames)
    lock.unlock()
    while true {
      lock.lock()
      if closed || pendingFrames.isEmpty {
        lock.unlock()
        return
      }
      let frame = pendingFrames.removeFirst()
      lock.unlock()
      do {
        let message = try fd199DecodeClientFrame(frame)
        try handle(message)
      } catch {
        stop()
        return
      }
    }
  }

  private func handle(_ message: Fd199ClientMessage) throws {
    lock.lock()
    defer { lock.unlock() }
    // A stop() between dequeue and dispatch must invalidate the frame.
    guard !closed else { throw Fd199Error.invalidState }
    switch message {
    case .hello:
      guard phase == .idle else { throw Fd199Error.invalidState }
      try sendLocked(.ready(hostAppPath: hostAppPath))
    case .recover:
      guard phase == .idle else { throw Fd199Error.invalidState }
      let record = try journal.recoverVerified()
      phase = .finished
      if let record {
        try sendLocked(.snapshot(status: record.status, generation: record.generation))
        recoveredStatus = record.status
      } else {
        try sendLocked(.snapshot(status: .none, generation: 0))
        recoveredStatus = Fd199OwnershipStatus.none
      }
      recovered = true
    case .desktopReady:
      // Fresh desktop ownership and a process restart over an activated
      // journal both prove their fully published local Web registry here.
      // Exported/releasing/prepared states remain fenced and cannot signal it.
      guard recovered, recoveredStatus == Fd199OwnershipStatus.none || recoveredStatus == .activated,
            phase == .finished, !desktopReady else { throw Fd199Error.invalidState }
      desktopReady = true
    case let .prepareFile(name, sha256, bytesBase64):
      // Streaming only ever answers an Host-issued prepare instruction.
      guard expectedInstruction == .prepare else { throw Fd199Error.invalidState }
      // A new transition generation may start after a settled recovery.
      guard phase == .streamingFiles || phase == .idle || phase == .finished, pending.count < fd199MaximumFiles else { throw Fd199Error.invalidState }
      phase = .streamingFiles
      guard let bytes = Data(base64Encoded: base64urlToBase64(bytesBase64)), !bytes.isEmpty,
            bytes.count <= fd199MaximumFileBytes else { throw Fd199Error.bounds }
      pending.append(PendingExport(name: name, sha256: sha256, bytes: bytes))
    case .prepareComplete:
      guard expectedInstruction == .prepare, phase == .streamingFiles, !pending.isEmpty else { throw Fd199Error.invalidState }
      phase = .awaitingReleased
      try stageExportedLocked()
    case .releasing:
      guard expectedInstruction == .prepare, phase == .awaitingReleased, let exportedRecord else { throw Fd199Error.invalidState }
      guard try journal.transitionExportedToReleasing(exportedRecord) != nil else { throw Fd199Error.invalidState }
      phase = .finished
      expectedInstruction = nil
      try sendLocked(.releaseAuthorized)
    case .activate:
      guard expectedInstruction == .activate, phase == .idle || phase == .finished else { throw Fd199Error.invalidState }
      let current = try journal.recoverVerified()
      guard let record = current, record.status == .prepared else { throw Fd199Error.invalidState }
      let nextGeneration = record.generation + 1
      let activationProof = try Fd199Proofs.signActivation(
        identity,
        exportId: record.exportId,
        manifestDigest: record.manifestDigest,
        generation: nextGeneration
      )
      let next = Fd199JournalRecord(
        version: record.version,
        exportId: record.exportId,
        stoppedAt: record.stoppedAt,
        generation: nextGeneration,
        status: .activated,
        exportProof: record.exportProof,
        activationProof: activationProof,
        manifest: record.manifest,
        manifestDigest: record.manifestDigest
      )
      guard try journal.transitionPrepared(expected: record, next: next) else { throw Fd199Error.invalidState }
      expectedInstruction = nil
      try sendLocked(.activated(generation: nextGeneration))
    }
  }

  /**
   Verifies every streamed entry against its claimed digest, mints the export
   identity, signs the export proof, and durably stages the prepared record.
   */
  /** Called only after the owning child PID has exited and been reaped. */
  public func promoteReapedReleaseToPrepared() throws {
    guard try journal.promoteReleasingToPrepared() != nil else { throw Fd199Error.invalidState }
  }

  private func stageExportedLocked() throws {
    var manifest = [Fd199ManifestEntry]()
    for entry in pending {
      let digest = Data(SHA256.hash(data: entry.bytes)).hexString
      guard digest == entry.sha256 else { throw Fd199Error.proof }
      manifest.append(Fd199ManifestEntry(name: entry.name, sha256: entry.sha256, size: entry.bytes.count))
    }
    // A later cycle stages its prepared record at the current activated
    // generation; the first cycle starts the ownership line at zero.
    let baselineGeneration = (try journal.recoverVerified())?.generation ?? 0
    let exportId = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").padding(toLength: 24, withPad: "0", startingAt: 0)
    let stoppedAt = canonicalNow()
    let exportProof = try Fd199Proofs.signExport(identity, exportId: exportId, stoppedAt: stoppedAt, manifest: manifest)
    let manifestDigest = Fd199Proofs.manifestDigest(manifest)
    let record = Fd199JournalRecord(
      version: Fd199Proofs.recordVersion,
      exportId: exportId,
      stoppedAt: stoppedAt,
      generation: baselineGeneration,
      status: .exported,
      exportProof: exportProof,
      activationProof: nil,
      manifest: manifest,
      manifestDigest: manifestDigest
    )
    try journal.stageExported(record)
    exportedRecord = record
    pending.removeAll(keepingCapacity: false)
  }

  // MARK: - Framed writes

  private func send(_ message: Fd199AuthorityMessage) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { throw Fd199Error.invalidState }
    try sendLocked(message)
  }

  private func sendLocked(_ message: Fd199AuthorityMessage) throws {
    let body = try fd199EncodeAuthorityMessage(message)
    var frame = Data([UInt8((body.count >> 24) & 0xff), UInt8((body.count >> 16) & 0xff), UInt8((body.count >> 8) & 0xff), UInt8(body.count & 0xff)])
    frame.append(body)
    try channel.write(contentsOf: frame)
  }

  private func canonicalNow() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: Date())
  }

  private func base64urlToBase64(_ value: String) -> String {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))
    return base64
  }

}
