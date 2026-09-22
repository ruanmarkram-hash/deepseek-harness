import XCTest
@testable import DshDeviceIdentityPresence

final class DshPresenceSessionTests: XCTestCase {
  func testPublicProjectionReusesOnlyCurrentAuthenticatedIdentity() {
    let session = DshPresenceSession<String>()
    var protectedLoads = 0
    func descriptor() -> String {
      session.publicProjection(project: { _ in "authenticated-public-descriptor" }, load: {
        protectedLoads += 1
        return "keychain-public-descriptor"
      })
    }
    XCTAssertEqual(descriptor(), "keychain-public-descriptor")
    XCTAssertEqual(protectedLoads, 1)
    XCTAssertTrue(session.complete("protected-identity", generation: session.begin()))
    XCTAssertEqual(descriptor(), "authenticated-public-descriptor")
    XCTAssertEqual(protectedLoads, 1)
    session.clear()
    XCTAssertEqual(descriptor(), "keychain-public-descriptor")
    XCTAssertEqual(protectedLoads, 2)
    XCTAssertNil(session.current())
  }

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
