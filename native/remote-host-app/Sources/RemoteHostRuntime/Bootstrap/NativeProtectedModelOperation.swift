import Foundation

/** One sealed provider/model route selected by the signed Host build. */
public struct NativeProtectedModelRoute: Equatable, Sendable {
  public let provider: String
  public let model: String

  private init(provider: String, model: String) {
    self.provider = provider
    self.model = model
  }

  /** The only shipped route until an explicitly reviewed build changes it. */
  public static let sealedDefault = NativeProtectedModelRoute(provider: "deepseek-official", model: "deepseek-v4-flash")
}

/** Text-only admitted work for the Keychain-retaining native model operation. */
public struct NativeProtectedModelTurn: Equatable, Sendable {
  public let sessionID: String
  public let text: String

  public init(sessionID: String, text: String) {
    self.sessionID = sessionID
    self.text = text
  }
}

/**
 A signed-Host-only model operation. Its implementation retains any Keychain
 credential and exposes neither credential bytes nor a generic provider,
 endpoint, or token lookup API to the Node child or FD198.
 */
public protocol NativeProtectedModelOperation: Sendable {
  func complete(_ turn: NativeProtectedModelTurn) async throws -> String
}

/**
 The native registration point for an already-provisioned protected model
 operation. This source deliberately does not install, inspect, or request a
 credential; provisioning remains an explicit signed-Host action.
 */
public protocol NativeProtectedModelOperationProvider: Sendable {
  func protectedModelOperation() throws -> any NativeProtectedModelOperation
}
