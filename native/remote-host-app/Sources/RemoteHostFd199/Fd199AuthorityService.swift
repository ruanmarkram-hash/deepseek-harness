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
  /// Only the current digest and byte count survive each acknowledged chunk.
  struct PendingExport {
    let name: String
    var hash = SHA256()
    var size = 0
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
  private let writeFrame: (Int32, Data) -> Int
  /// Readability callbacks may arrive while the preceding chunk is still
  /// decoding. This per-service serial queue preserves the socket byte order
  /// across those callbacks; a concurrent global queue can otherwise process
  /// `prepare.complete` before its preceding `prepare.file`.
  private let consumeQueue = DispatchQueue(label: "com.deepseek.dsh.fd199-authority-consume")
  private var buffer = [UInt8]()
  /// Frames decoded but not yet dispatched; stop() drops them.
  private var pendingFrames = [Data]()
  private var reservedInputBytes = 0
  private var greeted = false
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
  private var pending = [Fd199ManifestEntry]()
  private var currentExport: PendingExport?
  private var exportNames = Set<String>()
  private var totalExportBytes = 0
  private var exportedRecord: Fd199JournalRecord?
  private var closed = false

  /**
   - Parameters:
     - identity: The protected Host signing identity for proofs.
     - hostAppPath: The absolute path of this signed Host application.
     - journal: The opened private journal.
     - channel: The authority-side FileHandle of the accepted socketpair.
   */
  public convenience init(identity: Fd199SigningIdentity, hostAppPath: String, journal: Fd199Journal, channel: FileHandle) {
    self.init(identity: identity, hostAppPath: hostAppPath, journal: journal, channel: channel, writeFrame: { descriptor, frame in
      frame.withUnsafeBytes { bytes in
        Darwin.send(descriptor, bytes.baseAddress, bytes.count, MSG_DONTWAIT)
      }
    })
  }

  /// Internal syscall seam for short-write and socket-pressure tests.
  init(identity: Fd199SigningIdentity, hostAppPath: String, journal: Fd199Journal, channel: FileHandle, writeFrame: @escaping (Int32, Data) -> Int) {
    self.identity = identity
    self.hostAppPath = hostAppPath
    self.journal = journal
    self.channel = channel
    self.writeFrame = writeFrame
    _ = setsockopt(channel.fileDescriptor, SOL_SOCKET, SO_NOSIGPIPE, [1], socklen_t(MemoryLayout<Int32>.size))
  }

  /**
   Starts serving the protocol until the peer misbehaves, closes, or `stop()`
   runs. Returns immediately; work continues on a background queue.
   */
  public func serve() {
    channel.readabilityHandler = { [weak self] handle in
      guard let self else { handle.readabilityHandler = nil; return }
      self.readAvailable(handle)
    }
  }

  private func readAvailable(_ handle: FileHandle) {
    lock.lock()
    guard !closed else { lock.unlock(); return }
    var bytes = [UInt8](repeating: 0, count: 65_536)
    let count = recv(handle.fileDescriptor, &bytes, bytes.count, MSG_DONTWAIT)
    if count < 0, errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR {
      lock.unlock()
      return
    }
    guard count > 0, count <= fd199MaximumBodyBytes + 4 - reservedInputBytes else {
      lock.unlock()
      stop()
      return
    }
    reservedInputBytes += count
    let data = Data(bytes.prefix(count))
    consumeQueue.async { self.consume(data) }
    lock.unlock()
  }

  /// Stops serving and releases the channel.
  public func stop() {
    lock.lock()
    let alreadyClosed = closed
    closed = true
    buffer.removeAll(keepingCapacity: false)
    pendingFrames.removeAll(keepingCapacity: false)
    reservedInputBytes = 0
    currentExport = nil
    pending.removeAll(keepingCapacity: false)
    exportNames.removeAll(keepingCapacity: false)
    totalExportBytes = 0
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
    guard !closed else { throw Fd199Error.invalidState }
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
      if frames.count + pendingFrames.count > 16 {
        lock.unlock()
        stop()
        return
      }
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
        lock.lock()
        if !closed { reservedInputBytes -= frame.count + 4 }
        lock.unlock()
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
    if message != .hello, !greeted { throw Fd199Error.invalidState }
    switch message {
    case .hello:
      guard phase == .idle, !greeted else { throw Fd199Error.invalidState }
      greeted = true
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
    case let .prepareFileBegin(name):
      // Streaming only ever answers an Host-issued prepare instruction.
      guard expectedInstruction == .prepare else { throw Fd199Error.invalidState }
      // A new transition generation may start after a settled recovery.
      guard phase == .streamingFiles || phase == .idle || phase == .finished,
            currentExport == nil, pending.count < fd199MaximumFiles,
            exportNames.insert(name).inserted else { throw Fd199Error.invalidState }
      phase = .streamingFiles
      currentExport = PendingExport(name: name)
      try sendLocked(.prepareFileAck(name: name, offset: 0, complete: false))
    case let .prepareFileChunk(offset, bytesBase64):
      guard expectedInstruction == .prepare, phase == .streamingFiles,
            var current = currentExport, current.size == offset else { throw Fd199Error.invalidState }
      guard let bytes = Data(base64Encoded: fd199PaddedBase64url(bytesBase64)),
            bytes.count <= fd199MaximumExportBytes - totalExportBytes else { throw Fd199Error.bounds }
      current.hash.update(data: bytes)
      current.size += bytes.count
      totalExportBytes += bytes.count
      currentExport = current
      try sendLocked(.prepareFileAck(name: current.name, offset: current.size, complete: false))
    case let .prepareFileEnd(size, sha256):
      guard expectedInstruction == .prepare, phase == .streamingFiles,
            let current = currentExport, size == current.size else { throw Fd199Error.invalidState }
      guard Data(current.hash.finalize()).hexString == sha256 else { throw Fd199Error.proof }
      pending.append(Fd199ManifestEntry(name: current.name, sha256: sha256, size: size))
      currentExport = nil
      try sendLocked(.prepareFileAck(name: current.name, offset: size, complete: true))
    case .prepareComplete:
      guard expectedInstruction == .prepare, phase == .streamingFiles, !pending.isEmpty, currentExport == nil else { throw Fd199Error.invalidState }
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
        generation: nextGeneration,
        version: record.version
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

  /** Called only after the owning child PID has exited and been reaped. */
  public func promoteReapedReleaseToPrepared() throws {
    guard try journal.promoteReleasingToPrepared() != nil else { throw Fd199Error.invalidState }
  }

  /// Signs the completed manifest after every byte has been independently hashed.
  private func stageExportedLocked() throws {
    let manifest = pending
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
    let written = writeFrame(channel.fileDescriptor, frame)
    guard written == frame.count else { throw Fd199Error.invalidState }
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
