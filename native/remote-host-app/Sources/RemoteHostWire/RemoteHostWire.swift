import Foundation

/** Fixed record kinds for the private Host/runtime Remote Wire. */
public enum RemoteWireKind: UInt8, CaseIterable, Sendable {
  case runtimeReady = 1
  case routeUpsert = 2
  case routeRevoked = 3
  case epochBegin = 4
  case epochBegun = 5
  case epochCommit = 6
  case epochCommitted = 7
  case connectionOpen = 8
  case connectionFrame = 9
  case connectionClosed = 10
  case connectionSend = 11
  case connectionClose = 12
  case hostStopping = 13
  case deviceEnroll = 14
  case deviceEnrolled = 15
  /// FD199-gated public identity lifetime seed from the signed Host to its child.
  case enrollmentSeed = 16
  /// FD199-gated projection of a native-finalized epoch, followed by its durable receipt.
  case epochSynchronize = 17
  case epochSynchronized = 18
}

/** A length-prefixed Remote Wire record with bounded UTF-8 metadata and opaque payload. */
public struct RemoteWireRecord: Equatable, Sendable {
  public let kind: RemoteWireKind
  public let metadata: Data
  public let payload: Data

  public init(kind: RemoteWireKind, metadata: Data = Data(), payload: Data = Data()) {
    self.kind = kind
    self.metadata = metadata
    self.payload = payload
  }
}

public enum RemoteWireError: Error, Equatable, Sendable {
  case malformed
  case oversized
}

/**
 Remote Wire is deliberately not an RPC format. A frame is
 `[u32 body length][u8 kind][u16 metadata length][metadata UTF-8][payload]`.
 */
public enum RemoteWire {
  public static let maximumRecordBytes = 8 * 1024 * 1024
  public static let maximumMetadataBytes = 16 * 1024
  private static let headerBytes = 7
  private static let bodyHeaderBytes = 3

  public static func encode(_ record: RemoteWireRecord) throws -> Data {
    try validate(record)
    let bodyLength = bodyHeaderBytes + record.metadata.count + record.payload.count
    var length = UInt32(bodyLength).bigEndian
    var metadataLength = UInt16(record.metadata.count).bigEndian
    var result = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
    result.append(record.kind.rawValue)
    result.append(Data(bytes: &metadataLength, count: MemoryLayout<UInt16>.size))
    result.append(record.metadata)
    result.append(record.payload)
    return result
  }

  /** Removes and decodes all complete records, retaining a bounded partial record. */
  public static func consume(_ buffer: inout Data) throws -> [RemoteWireRecord] {
    var records: [RemoteWireRecord] = []
    while buffer.count >= MemoryLayout<UInt32>.size {
      let bodyLength = Int(readUInt32(buffer.prefix(MemoryLayout<UInt32>.size)))
      guard bodyLength >= bodyHeaderBytes else { throw RemoteWireError.malformed }
      guard bodyLength <= maximumRecordBytes else { throw RemoteWireError.oversized }
      let frameLength = MemoryLayout<UInt32>.size + bodyLength
      guard buffer.count >= frameLength else { return records }
      let frame = buffer.prefix(frameLength)
      buffer.removeFirst(frameLength)
      records.append(try decode(Data(frame)))
    }
    guard buffer.count < headerBytes else { throw RemoteWireError.oversized }
    return records
  }

  public static func decode(_ frame: Data) throws -> RemoteWireRecord {
    guard frame.count >= headerBytes else { throw RemoteWireError.malformed }
    let bodyLength = Int(readUInt32(frame.prefix(MemoryLayout<UInt32>.size)))
    guard bodyLength >= bodyHeaderBytes, bodyLength <= maximumRecordBytes,
          frame.count == MemoryLayout<UInt32>.size + bodyLength,
          let kind = RemoteWireKind(rawValue: frame[MemoryLayout<UInt32>.size])
    else { throw RemoteWireError.malformed }
    let metadataOffset = MemoryLayout<UInt32>.size + 1
    let metadataLength = Int(readUInt16(frame[metadataOffset..<(metadataOffset + MemoryLayout<UInt16>.size)]))
    guard metadataLength <= maximumMetadataBytes else { throw RemoteWireError.oversized }
    let payloadOffset = metadataOffset + MemoryLayout<UInt16>.size + metadataLength
    guard payloadOffset <= frame.count else { throw RemoteWireError.malformed }
    let metadata = Data(frame[(metadataOffset + MemoryLayout<UInt16>.size)..<payloadOffset])
    let payload = Data(frame[payloadOffset...])
    let record = RemoteWireRecord(kind: kind, metadata: metadata, payload: payload)
    try validate(record)
    return record
  }

  private static func validate(_ record: RemoteWireRecord) throws {
    guard record.metadata.count <= maximumMetadataBytes else { throw RemoteWireError.oversized }
    guard String(data: record.metadata, encoding: .utf8) != nil else { throw RemoteWireError.malformed }
    let bodyLength = bodyHeaderBytes + record.metadata.count + record.payload.count
    guard bodyLength <= maximumRecordBytes else { throw RemoteWireError.oversized }
  }

  private static func readUInt32(_ data: Data.SubSequence) -> UInt32 {
    data.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
  }

  private static func readUInt16(_ data: Data.SubSequence) -> UInt16 {
    data.reduce(UInt16(0)) { ($0 << 8) | UInt16($1) }
  }
}
