import CryptoKit
import Darwin
import Foundation
import Security

/**
 A release-only manifest for the optional Node implementation of the V3 gateway.

 The manifest is deliberately not a launch configuration. It identifies the fixed
 Node executable, gateway entrypoint, and FD198 close-on-exec add-on plus the code
 requirements for both native files. Route credentials, Host agreement material,
and relay URLs are never represented here.
 */
public struct RemoteHostV3SealedGatewayManifest: Codable, Equatable, Sendable {
  public let formatVersion: Int
  public let relativeNodeExecutablePath: String
  public let relativeGatewayEntrypointPath: String
  public let relativeGatewayCloexecAddonPath: String
  public let nodeSHA256: String
  public let gatewayEntrypointSHA256: String
  public let gatewayCloexecAddonSHA256: String
  public let nodeRequirement: String
  public let gatewayCloexecAddonRequirement: String

  public init(
    formatVersion: Int,
    relativeNodeExecutablePath: String,
    relativeGatewayEntrypointPath: String,
    relativeGatewayCloexecAddonPath: String,
    nodeSHA256: String,
    gatewayEntrypointSHA256: String,
    gatewayCloexecAddonSHA256: String,
    nodeRequirement: String,
    gatewayCloexecAddonRequirement: String
  ) {
    self.formatVersion = formatVersion
    self.relativeNodeExecutablePath = relativeNodeExecutablePath
    self.relativeGatewayEntrypointPath = relativeGatewayEntrypointPath
    self.relativeGatewayCloexecAddonPath = relativeGatewayCloexecAddonPath
    self.nodeSHA256 = nodeSHA256
    self.gatewayEntrypointSHA256 = gatewayEntrypointSHA256
    self.gatewayCloexecAddonSHA256 = gatewayCloexecAddonSHA256
    self.nodeRequirement = nodeRequirement
    self.gatewayCloexecAddonRequirement = gatewayCloexecAddonRequirement
  }
}

/** Exact, closed failures while validating an embedded V3 gateway release artifact. */
public enum RemoteHostV3SealedGatewayPackagingError: Error, Equatable, Sendable {
  case invalidManifest
  case missingArtifact
  case symlinkedArtifact
  case mutableInstallation
  case digestMismatch
  case invalidHostCodeSignature
  case invalidNodeCodeSignature
}

/** Verified locations of the three sealed embedded gateway release artifacts. */
public struct RemoteHostV3SealedGatewayArtifacts: Equatable, Sendable {
  public let nodeExecutable: URL
  public let gatewayEntrypoint: URL
  public let gatewayCloexecAddon: URL
  public let nodeRequirement: String
}

/**
 Verifies an optional embedded Node gateway without ever discovering a runtime from
 PATH, the current environment, or a caller supplied executable path.  Production
 code must obtain this manifest from the code-signed Host bundle and still use the
 fixed `--private-fd 198` native launch contract.
 */
public enum RemoteHostV3SealedGatewayPackaging {
  public static let formatVersion = 2
  public static let nodePath = "GatewayRuntime/node"
  public static let entrypointPath = "GatewayRuntime/dsh-remote-host-v3.mjs"
  public static let cloexecAddonPath = "GatewayRuntime/fd198-cloexec.node"
  public static let manifestPath = "GatewayRuntime/GatewayRuntimeManifest.plist"
  static let hostIdentifier = "com.deepseek.dsh.remote-host"

  /**
   Loads the optional release manifest from the signed Host bundle and validates
   every artifact before a native launcher could consider executing Node.
   */
  public static func loadAndValidateBundledArtifacts(bundle: Bundle = .main) throws -> RemoteHostV3SealedGatewayArtifacts {
    guard let resourceURL = bundle.resourceURL else {
      throw RemoteHostV3SealedGatewayPackagingError.missingArtifact
    }
    try validateRunningHost(bundle: bundle)
    _ = try validateImmutableInstallation(resourceURL)
    let manifestURL = try artifactURL(resourceURL: resourceURL, relativePath: manifestPath)
    guard let data = try? Data(contentsOf: manifestURL),
          let manifest = try? PropertyListDecoder().decode(RemoteHostV3SealedGatewayManifest.self, from: data)
    else { throw RemoteHostV3SealedGatewayPackagingError.invalidManifest }
    let artifacts = try validateArtifacts(resourceURL: resourceURL, manifest: manifest)
    try validateNodeCodeSignature(artifacts.nodeExecutable, requirement: manifest.nodeRequirement)
    try validateNodeCodeSignature(artifacts.gatewayCloexecAddon, requirement: manifest.gatewayCloexecAddonRequirement)
    return artifacts
  }

  public static func validateManifest(_ manifest: RemoteHostV3SealedGatewayManifest) throws {
    guard manifest.formatVersion == formatVersion,
          manifest.relativeNodeExecutablePath == nodePath,
          manifest.relativeGatewayEntrypointPath == entrypointPath,
          manifest.relativeGatewayCloexecAddonPath == cloexecAddonPath,
          isLowercaseSHA256(manifest.nodeSHA256),
          isLowercaseSHA256(manifest.gatewayEntrypointSHA256),
          isLowercaseSHA256(manifest.gatewayCloexecAddonSHA256),
          !manifest.nodeRequirement.isEmpty,
          manifest.nodeRequirement.contains("anchor apple generic"),
          !manifest.gatewayCloexecAddonRequirement.isEmpty,
          manifest.gatewayCloexecAddonRequirement.contains("anchor apple generic")
    else { throw RemoteHostV3SealedGatewayPackagingError.invalidManifest }
  }

  /**
   Validates the fixed resource-relative artifact triplet and their release digests.
   The caller cannot substitute a Node path, entrypoint, or native add-on through metadata.
   */
  public static func validateArtifacts(
    resourceURL: URL,
    manifest: RemoteHostV3SealedGatewayManifest
  ) throws -> RemoteHostV3SealedGatewayArtifacts {
    try validateManifest(manifest)
    let node = try artifactURL(resourceURL: resourceURL, relativePath: nodePath)
    let entrypoint = try artifactURL(resourceURL: resourceURL, relativePath: entrypointPath)
    let addon = try artifactURL(resourceURL: resourceURL, relativePath: cloexecAddonPath)
    guard try digest(of: node) == manifest.nodeSHA256,
          try digest(of: entrypoint) == manifest.gatewayEntrypointSHA256,
          try digest(of: addon) == manifest.gatewayCloexecAddonSHA256
    else { throw RemoteHostV3SealedGatewayPackagingError.digestMismatch }
    return RemoteHostV3SealedGatewayArtifacts(
      nodeExecutable: node,
      gatewayEntrypoint: entrypoint,
      gatewayCloexecAddon: addon,
      nodeRequirement: manifest.nodeRequirement
    )
  }

  /** Checks the code-signed Node executable against the sealed manifest requirement. */
  public static func validateNodeCodeSignature(
    _ nodeExecutable: URL,
    requirement: String
  ) throws {
    var code: SecStaticCode?
    var expected: SecRequirement?
    guard SecStaticCodeCreateWithPath(nodeExecutable as CFURL, [], &code) == errSecSuccess,
          SecRequirementCreateWithString(requirement as CFString, [], &expected) == errSecSuccess,
          let code, let expected,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), expected) == errSecSuccess
    else { throw RemoteHostV3SealedGatewayPackagingError.invalidNodeCodeSignature }
  }

  static func artifactURL(resourceURL: URL, relativePath: String) throws -> URL {
    let root = resourceURL.resolvingSymlinksInPath().standardizedFileURL
    guard resourceURL.standardizedFileURL == root else {
      throw RemoteHostV3SealedGatewayPackagingError.missingArtifact
    }
    let components = relativePath.split(separator: "/", omittingEmptySubsequences: false)
    guard !components.isEmpty,
          components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
    else { throw RemoteHostV3SealedGatewayPackagingError.missingArtifact }
    var candidate = root
    for (index, component) in components.enumerated() {
      candidate.appendPathComponent(String(component), isDirectory: index + 1 < components.count)
      var metadata = Darwin.stat()
      guard lstat(candidate.path, &metadata) == 0 else {
        throw RemoteHostV3SealedGatewayPackagingError.missingArtifact
      }
      let kind = metadata.st_mode & S_IFMT
      guard kind != S_IFLNK else {
        throw RemoteHostV3SealedGatewayPackagingError.symlinkedArtifact
      }
      guard isTrustedInstallationNode(
        owner: metadata.st_uid, mode: metadata.st_mode,
        hasExtendedACL: hasExtendedACL(candidate.path), expectedOwner: try expectedInstallationOwner(resourceURL: resourceURL)
      ) else {
        throw RemoteHostV3SealedGatewayPackagingError.mutableInstallation
      }
      if index + 1 == components.count {
        guard kind == S_IFREG else { throw RemoteHostV3SealedGatewayPackagingError.missingArtifact }
      } else {
        guard kind == S_IFDIR else { throw RemoteHostV3SealedGatewayPackagingError.missingArtifact }
      }
    }
    return candidate
  }

  /**
   Accepts either the root-owned system installation or the current-user-owned
   `~/Applications` installation. The logged-in owner is trusted to replace the
   latter; the code seal and designated requirement still authenticate every
   executable byte before use.
   */
  @discardableResult static func validateImmutableInstallation(_ resourceURL: URL) throws -> uid_t {
    let resolved = resourceURL.resolvingSymlinksInPath().standardizedFileURL
    guard resourceURL.standardizedFileURL == resolved else {
      throw RemoteHostV3SealedGatewayPackagingError.mutableInstallation
    }
    let expectedOwner = try expectedInstallationOwner(resourceURL: resolved)
    let app = resolved.deletingLastPathComponent().deletingLastPathComponent()
    var current = app.deletingLastPathComponent()
    for component in ["DSHHost.app", "Contents", "Resources"] {
      current.appendPathComponent(component, isDirectory: true)
      var metadata = Darwin.stat()
      guard lstat(current.path, &metadata) == 0,
            (metadata.st_mode & S_IFMT) == S_IFDIR,
            isTrustedInstallationNode(
              owner: metadata.st_uid, mode: metadata.st_mode,
              hasExtendedACL: hasExtendedACL(current.path), expectedOwner: expectedOwner
            )
      else { throw RemoteHostV3SealedGatewayPackagingError.mutableInstallation }
    }
    let enumerator = FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil)
    while let node = enumerator?.nextObject() as? URL {
      var metadata = Darwin.stat()
      guard lstat(node.path, &metadata) == 0,
            metadata.st_mode & S_IFMT != S_IFLNK,
            metadata.st_mode & S_IFMT == S_IFDIR || metadata.st_mode & S_IFMT == S_IFREG,
            isTrustedInstallationNode(
              owner: metadata.st_uid, mode: metadata.st_mode,
              hasExtendedACL: hasExtendedACL(node.path), expectedOwner: expectedOwner
            )
      else { throw RemoteHostV3SealedGatewayPackagingError.mutableInstallation }
    }
    return expectedOwner
  }

  static func expectedInstallationOwner(resourceURL: URL, homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser, effectiveUID: uid_t = geteuid()) throws -> uid_t {
    let resources = resourceURL.standardizedFileURL.path
    if resources == "/Applications/DSHHost.app/Contents/Resources" { return 0 }
    let userResources = homeDirectory.appendingPathComponent("Applications/DSHHost.app/Contents/Resources").standardizedFileURL.path
    guard resources == userResources, effectiveUID != 0 else {
      throw RemoteHostV3SealedGatewayPackagingError.mutableInstallation
    }
    return effectiveUID
  }

  /** Every app descendant must have the installation owner, no ACL, and no group/world writer. */
  static func isTrustedInstallationNode(
    owner: uid_t,
    mode: mode_t,
    hasExtendedACL: Bool,
    expectedOwner: uid_t
  ) -> Bool {
    owner == expectedOwner && !hasExtendedACL && mode & (S_IWGRP | S_IWOTH) == 0
  }

  /**
   Compares the canonical requirement text emitted by Security.framework.

   `SecRequirementCopyData` is not a stable semantic identity: compiling the
   same requirement text can produce different opaque bytes from the copy
   embedded in a code signature. The strict validity check below remains the
   authority for evaluating the packaged requirement against the signed app.
   */
  static func matchesPackagedDesignatedRequirement(_ packaged: String, designated: String) -> Bool {
    packaged.contains("anchor apple generic") && packaged == designated
  }

  static func validateRunningHost(bundle: Bundle) throws {
    let bundleURL = bundle.bundleURL.standardizedFileURL
    guard bundleURL == bundleURL.resolvingSymlinksInPath().standardizedFileURL,
          bundleURL.lastPathComponent == "DSHHost.app",
          bundle.bundleIdentifier == hostIdentifier,
          let executable = bundle.executableURL?.standardizedFileURL,
          executable == bundleURL.appendingPathComponent("Contents/MacOS/dsh-remote-host-app").standardizedFileURL,
          executable == executable.resolvingSymlinksInPath().standardizedFileURL,
          let requirementURL = bundle.url(forResource: "HostActivationRequirement", withExtension: "plist"),
          let requirementData = try? Data(contentsOf: requirementURL),
          let values = try? PropertyListSerialization.propertyList(from: requirementData, format: nil) as? [String: Any],
          let requirementText = values["requirement"] as? String,
          !requirementText.isEmpty
    else { throw RemoteHostV3SealedGatewayPackagingError.invalidHostCodeSignature }
    var code: SecStaticCode?
    var requirement: SecRequirement?
    guard SecStaticCodeCreateWithPath(bundleURL as CFURL, [], &code) == errSecSuccess,
          SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess,
          let code, let requirement,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess
    else { throw RemoteHostV3SealedGatewayPackagingError.invalidHostCodeSignature }
    var designated: SecRequirement?
    var designatedString: CFString?
    guard SecCodeCopyDesignatedRequirement(code, [], &designated) == errSecSuccess,
          let designated,
          SecRequirementCopyString(designated, [], &designatedString) == errSecSuccess,
          let designatedString,
          matchesPackagedDesignatedRequirement(requirementText, designated: designatedString as String)
    else { throw RemoteHostV3SealedGatewayPackagingError.invalidHostCodeSignature }
  }

  /** Any extended ACL is rejected because it can grant an unprivileged writer access beyond mode bits. */
  static func hasExtendedACL(_ path: String) -> Bool {
    guard let accessControlList = acl_get_file(path, ACL_TYPE_EXTENDED) else {
      return errno != ENOENT
    }
    defer { _ = acl_free(UnsafeMutableRawPointer(accessControlList)) }
    var entry: acl_entry_t?
    return acl_get_entry(accessControlList, Int32(ACL_FIRST_ENTRY.rawValue), &entry) == 0
  }

  static func digest(of url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let data = try handle.read(upToCount: 64 * 1024) ?? Data()
      if data.isEmpty { break }
      hasher.update(data: data)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private static func isLowercaseSHA256(_ value: String) -> Bool {
    guard value.count == 64 else { return false }
    return value.unicodeScalars.allSatisfy { scalar in
      (scalar.value >= 48 && scalar.value <= 57) || (scalar.value >= 97 && scalar.value <= 102)
    }
  }
}
