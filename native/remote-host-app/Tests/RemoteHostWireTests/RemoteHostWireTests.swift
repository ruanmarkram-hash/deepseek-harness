import Foundation
import Testing
@testable import RemoteHostWire

@Test func roundTripsAllowlistedRecord() throws {
  let input = RemoteWireRecord(kind: .connectionFrame, metadata: Data("{\"stream\":1}".utf8), payload: Data([1, 2, 3]))
  var buffer = try RemoteWire.encode(input)
  #expect(try RemoteWire.consume(&buffer) == [input])
  #expect(buffer.isEmpty)
}

@Test func roundTripsLocalEnrollmentHandoffKinds() throws {
  for kind in [RemoteWireKind.deviceEnroll, .deviceEnrolled, .enrollmentSeed] {
    let input = RemoteWireRecord(kind: kind, metadata: Data("{}".utf8))
    var buffer = try RemoteWire.encode(input)
    #expect(try RemoteWire.consume(&buffer) == [input])
  }
}

@Test func preservesPartialFrameUntilComplete() throws {
  let encoded = try RemoteWire.encode(RemoteWireRecord(kind: .runtimeReady))
  var buffer = Data(encoded.prefix(5))
  #expect(try RemoteWire.consume(&buffer).isEmpty)
  buffer.append(encoded.dropFirst(5))
  #expect(try RemoteWire.consume(&buffer).map(\.kind) == [.runtimeReady])
}

@Test func rejectsUnknownKindMalformedMetadataAndOversizedLength() throws {
  #expect(throws: RemoteWireError.malformed) {
    try RemoteWire.decode(Data([0, 0, 0, 3, 255, 0, 0]))
  }
  #expect(throws: RemoteWireError.malformed) {
    try RemoteWire.encode(RemoteWireRecord(kind: .routeUpsert, metadata: Data([0xff])))
  }
  var oversized = Data([0, 128, 0, 1])
  #expect(throws: RemoteWireError.oversized) {
    try RemoteWire.consume(&oversized)
  }
}
