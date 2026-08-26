import Foundation
import RemoteHostWire

/** Direction of a fixed Remote Wire record across the signed Host/runtime pipe. */
public enum RemoteHostV3GatewayWireDirection: Sendable {
  case hostToGateway
  case gatewayToHost
}

/** Exact sealed artifacts required before the TypeScript gateway can replace the native enrollment runtime. */
public enum RemoteHostV3GatewayPackagingRequirement: CaseIterable, Equatable, Sendable {
  /// A signed embedded Node executable, validated against a fixed requirement by the Host app.
  case signedNodeExecutable
  /// A code-sealed compiled `@deepseek-ai/dsh-remote-host-v3` gateway entrypoint and dependency closure.
  case sealedGatewayEntrypoint
  /// A signed native add-on that marks FD198 close-on-exec before gateway work starts.
  case sealedFD198CloexecAddon
  /// A native launcher that supplies only FD198 and an empty environment to that exact entrypoint.
  case attestedNativeLauncher
}

/** Closed errors for the native-to-TypeScript V3 gateway bootstrap seam. */
public enum RemoteHostV3GatewayBootstrapError: Error, Equatable, Sendable {
  case invalidPrivateRuntimeInvocation
  case invalidRecord
  case wrongRecordDirection
}

/**
 Fixed protocol facts shared by the current native enrollment runtime and the future
 sealed TypeScript `remote-host-v3` gateway runtime. This module neither locates nor
 launches Node, opens a socket, reads a token, or exposes FD198.
 */
public enum RemoteHostV3GatewayBootstrap {
  /** The only descriptor inherited by a private runtime child. */
  public static let privateDescriptor: Int32 = 198

  /** The only permitted private-runtime command-line suffix. */
  public static let privateRuntimeArguments = ["--private-fd", String(privateDescriptor)]

  /**
   The current signed app has the attested launcher, but no sealed Node and gateway
   entrypoint artifact pair. The launcher remains inert until both are packaged.
   */
  public static let unavailablePackagingRequirements: [RemoteHostV3GatewayPackagingRequirement] = [.signedNodeExecutable, .sealedGatewayEntrypoint]

  /** Validates the exact inherited-descriptor invocation accepted by the native child. */
  public static func validatePrivateRuntimeInvocation(_ arguments: [String]) throws {
    guard arguments == privateRuntimeArguments else {
      throw RemoteHostV3GatewayBootstrapError.invalidPrivateRuntimeInvocation
    }
  }

  /**
   Validates the fixed Remote Wire vocabulary, its direction, and the shared record
   byte bounds. Per-record metadata semantics remain owned by the native Host or the
   already-tested TypeScript provider that consumes that direction.
   */
  public static func validate(_ record: RemoteWireRecord, direction: RemoteHostV3GatewayWireDirection) throws {
    do {
      _ = try RemoteWire.encode(record)
    } catch {
      throw RemoteHostV3GatewayBootstrapError.invalidRecord
    }
    guard permits(record.kind, direction: direction) else {
      throw RemoteHostV3GatewayBootstrapError.wrongRecordDirection
    }
  }

  private static func permits(_ kind: RemoteWireKind, direction: RemoteHostV3GatewayWireDirection) -> Bool {
    switch direction {
    case .hostToGateway:
      switch kind {
      case .routeUpsert, .routeRevoked, .epochBegin, .epochCommit, .connectionOpen, .connectionFrame, .connectionClosed, .hostStopping, .deviceEnroll, .enrollmentSeed:
        return true
      case .runtimeReady, .epochBegun, .epochCommitted, .connectionSend, .connectionClose, .deviceEnrolled:
        return false
      }
    case .gatewayToHost:
      switch kind {
      case .runtimeReady, .epochBegun, .epochCommitted, .connectionSend, .connectionClose, .deviceEnrolled:
        return true
      case .routeUpsert, .routeRevoked, .epochBegin, .epochCommit, .connectionOpen, .connectionFrame, .connectionClosed, .hostStopping, .deviceEnroll, .enrollmentSeed:
        return false
      }
    }
  }
}
