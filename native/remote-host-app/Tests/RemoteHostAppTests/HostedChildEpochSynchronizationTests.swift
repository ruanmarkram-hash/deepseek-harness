import Foundation
import Testing
import RemoteHostWire
@testable import RemoteHostApp

private func epochRequest(_ epoch: Int = 1) throws -> RemoteWireRecord {
  RemoteWireRecord(kind: .epochSynchronize, metadata: try JSONSerialization.data(withJSONObject: [
    "routeId": "route_00000000001", "deviceId": "device_000000001", "deviceEnrollmentId": "device_enroll001",
    "hostDeviceId": "host_00000000001", "hostEnrollmentId": "host_enroll00001", "generation": 1, "connectionEpoch": epoch,
  ], options: [.sortedKeys]))
}

@Test("native epoch synchronization opens only after the exact encoded durable acknowledgment")
func epochReceiptOrdersOpen() throws {
  let gate = HostedChildEpochSynchronization()
  let request = try epochRequest()
  var events: [String] = ["native-finalized"]
  try gate.synchronizeThenOpen(request: request, send: { sent in
    events.append("synchronize")
    let decoded = try RemoteWire.decode(RemoteWire.encode(sent))
    #expect(decoded == request)
    events.append("child-persisted")
    gate.receive(try RemoteWire.decode(RemoteWire.encode(RemoteWireRecord(kind: .epochSynchronized, metadata: decoded.metadata))))
  }, open: { events.append("connection-open") })
  #expect(events == ["native-finalized", "synchronize", "child-persisted", "connection-open"])
}

@Test("missing, malformed, wrong-direction and wrong-route receipts never open")
func epochReceiptRejectsInvalid() throws {
  let request = try epochRequest()
  let object = try #require(JSONSerialization.jsonObject(with: request.metadata) as? [String: Any])
  var receipts = [
    RemoteWireRecord(kind: .epochCommitted, metadata: request.metadata),
    RemoteWireRecord(kind: .epochSynchronized, metadata: request.metadata, payload: Data([1])),
    RemoteWireRecord(kind: .epochSynchronized, metadata: Data("{}".utf8)),
    RemoteWireRecord(kind: .epochSynchronized, metadata: Data("{\"connectionEpoch\":1,\"connectionEpoch\":1}".utf8)),
  ]
  for key in object.keys {
    var changed = object
    changed[key] = key == "connectionEpoch" || key == "generation" ? 2 : "wrong_identity0001"
    receipts.append(RemoteWireRecord(kind: .epochSynchronized, metadata: try JSONSerialization.data(withJSONObject: changed)))
  }
  for key in ["generation", "connectionEpoch"] {
    var boolean = object
    boolean[key] = true
    receipts.append(RemoteWireRecord(kind: .epochSynchronized, metadata: try JSONSerialization.data(withJSONObject: boolean)))
  }
  for receipt in receipts {
    let gate = HostedChildEpochSynchronization()
    var opened = false
    #expect(throws: (any Error).self) {
      try gate.synchronizeThenOpen(request: request, send: { _ in gate.receive(receipt) }, open: { opened = true })
    }
    #expect(!opened)
  }
  let timeout = HostedChildEpochSynchronization()
  #expect(throws: (any Error).self) { try timeout.synchronizeThenOpen(request: request, timeout: 0.001, send: { _ in }, open: { Issue.record("Opened without receipt") }) }
}

@Test("cancellation and unsolicited acknowledgments cannot admit a connection")
func epochReceiptStopFailsClosed() throws {
  let request = try epochRequest()
  for earlyReceipt in [false, true] {
    let gate = HostedChildEpochSynchronization()
    if earlyReceipt { gate.receive(RemoteWireRecord(kind: .epochSynchronized, metadata: request.metadata)) }
    else { gate.stop() }
    #expect(throws: (any Error).self) { try gate.synchronizeThenOpen(request: request, send: { _ in Issue.record("Sent after stop") }, open: { Issue.record("Opened after stop") }) }
  }
  let afterReceipt = HostedChildEpochSynchronization()
  #expect(throws: (any Error).self) {
    try afterReceipt.synchronizeThenOpen(request: request, send: { _ in
      afterReceipt.receive(RemoteWireRecord(kind: .epochSynchronized, metadata: request.metadata))
      afterReceipt.stop()
    }, open: { Issue.record("Opened after receipt was canceled") })
  }
}
