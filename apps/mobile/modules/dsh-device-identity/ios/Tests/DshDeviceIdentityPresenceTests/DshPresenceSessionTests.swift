import XCTest
@testable import DshDeviceIdentityPresence

final class DshPresenceSessionTests: XCTestCase {
  func testClearWhileBiometricEvaluationIsPendingRejectsItsLateCompletion() {
    let session = DshPresenceSession<String>()
    let pendingEvaluation = session.begin()

    session.clear()

    XCTAssertFalse(session.complete("private-key-session", generation: pendingEvaluation))
    XCTAssertNil(session.current())
  }

  func testCurrentGenerationMayInstallAndClearOneNativeIdentitySession() {
    let session = DshPresenceSession<String>()
    let currentEvaluation = session.begin()

    XCTAssertTrue(session.complete("private-key-session", generation: currentEvaluation))
    XCTAssertEqual(session.current(), "private-key-session")
    session.clear()
    XCTAssertNil(session.current())
  }
}
