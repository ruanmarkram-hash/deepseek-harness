import CryptoKit
import Darwin
import Foundation
import Security

/**
 A release-only manifest for the optional hosted `dsh web` child.

 Like the sealed gateway manifest, this is deliberately not a launch
 configuration: it identifies the fixed Node executable and the single
 self-contained CLI bundle plus their code requirements. Route credentials,
 Host agreement material, relay URLs, and store contents are never represented
 here.
 */
public struct RemoteHostV3HostedChildManifest: Codable, Equatable, Sendable {
  public let formatVersion: Int
  public let relativeNodeExecutablePath: String
  public let relativeChildEntrypointPath: String
  public let nodeSHA256: String
  public let childEntrypointSHA256: String
  public let childBundleSHA256: String
  public let nodeRequirement: String
  /** Plist inventorying every shipped node_modules package and file. */
  public let relativeTreeManifestPath: String?

  public init(
    formatVersion: Int,
    relativeNodeExecutablePath: String,
    relativeChildEntrypointPath: String,
    nodeSHA256: String,
    childEntrypointSHA256: String,
    childBundleSHA256: String = String(repeating: "0", count: 64),
    nodeRequirement: String,
    relativeTreeManifestPath: String? = nil
  ) {
    self.formatVersion = formatVersion
    self.relativeNodeExecutablePath = relativeNodeExecutablePath
    self.relativeChildEntrypointPath = relativeChildEntrypointPath
    self.nodeSHA256 = nodeSHA256
    self.childEntrypointSHA256 = childEntrypointSHA256
    self.childBundleSHA256 = childBundleSHA256
    self.nodeRequirement = nodeRequirement
    self.relativeTreeManifestPath = relativeTreeManifestPath
  }
}

/** Exact, closed failures while validating an embedded hosted child artifact. */
public enum RemoteHostV3HostedChildPackagingError: Error, Equatable, Sendable {
  case invalidManifest
  case missingArtifact
  case symlinkedArtifact
  case mutableInstallation
  case digestMismatch
  case invalidNodeCodeSignature
}

/** Verified locations of the two hosted child release artifacts. */
public struct RemoteHostV3HostedChildArtifacts: Equatable, Sendable {
  public let nodeExecutable: URL
  public let childEntrypoint: URL
  public let nodeRequirement: String
  public let webConfiguration: RemoteHostV3HostedWebConfiguration
}

/** Install-specific, signed launch facts for the hosted Web owner. */
public struct RemoteHostV3HostedWebConfiguration: Codable, Equatable, Sendable {
  public let formatVersion: Int
  public let dshHome: String
  public let patchRelativePath: String
  public let patchSHA256: String
  public let port: Int
  public let trustedHost: String
}

/**
 Verifies an optional embedded hosted child without ever discovering a runtime
 from PATH, the environment, or a caller-supplied path. The entrypoint must be
 a single self-contained bundle so its digest covers every behavior the child
 can execute; production code obtains this manifest from the code-signed Host
 bundle and still uses the fixed `--private-relay-fd 198
 --private-authority-fd 199` launch contract.
 */
public enum RemoteHostV3HostedChildPackaging {
  public static let formatVersion = 2
  public static let nodePath = "HostedChild/node"
  public static let entrypointPath = "HostedChild/child/dsh-web.mjs"
  public static let manifestPath = "HostedChild/HostedChildManifest.plist"
  public static let defaultTreeManifestPath = "HostedChild/TreeManifest.plist"
  public static let webConfigurationPath = "HostedChild/HostedWebConfiguration.plist"

  /**
   Loads the optional release manifest from the signed Host bundle and validates
   both artifacts plus the shipped module tree before a native launcher may
   execute Node.
   */
  public static func loadAndValidateBundledArtifacts(bundle: Bundle = .main) throws -> RemoteHostV3HostedChildArtifacts {
    guard let resourceURL = bundle.resourceURL else {
      throw RemoteHostV3HostedChildPackagingError.missingArtifact
    }
    do {
      try RemoteHostV3SealedGatewayPackaging.validateRunningHost(bundle: bundle)
      try validateImmutableInstallation(resourceURL: resourceURL)
    } catch {
      throw RemoteHostV3HostedChildPackagingError.mutableInstallation
    }
    let manifestURL = try artifactURL(resourceURL: resourceURL, relativePath: manifestPath)
    guard let data = try? Data(contentsOf: manifestURL),
          let manifest = try? PropertyListDecoder().decode(RemoteHostV3HostedChildManifest.self, from: data)
    else { throw RemoteHostV3HostedChildPackagingError.invalidManifest }
    let artifacts = try validateArtifacts(resourceURL: resourceURL, manifest: manifest)
    try RemoteHostV3SealedGatewayPackaging.validateNodeCodeSignature(artifacts.nodeExecutable, requirement: manifest.nodeRequirement)
    return artifacts
  }

  public static func validateManifest(_ manifest: RemoteHostV3HostedChildManifest) throws {
    guard manifest.formatVersion == formatVersion,
          manifest.relativeNodeExecutablePath == nodePath,
          manifest.relativeChildEntrypointPath == entrypointPath,
          isLowercaseSHA256(manifest.nodeSHA256),
          isLowercaseSHA256(manifest.childEntrypointSHA256),
          isLowercaseSHA256(manifest.childBundleSHA256),
          !manifest.nodeRequirement.isEmpty,
          manifest.nodeRequirement.contains("anchor apple generic"),
          manifest.relativeTreeManifestPath == defaultTreeManifestPath
    else { throw RemoteHostV3HostedChildPackagingError.invalidManifest }
  }

  /**
   Validates the fixed resource-relative artifact pair and their release digests.
   The caller cannot substitute a Node path or child entrypoint through metadata.
   */
  public static func validateArtifacts(
    resourceURL: URL,
    manifest: RemoteHostV3HostedChildManifest
  ) throws -> RemoteHostV3HostedChildArtifacts {
    try validateManifest(manifest)
    let node = try artifactURL(resourceURL: resourceURL, relativePath: nodePath)
    let entrypoint = try artifactURL(resourceURL: resourceURL, relativePath: entrypointPath)
    let bundle = try artifactURL(resourceURL: resourceURL, relativePath: "HostedChild/child/dsh-web.bundle.mjs")
    let webConfigurationURL = try artifactURL(resourceURL: resourceURL, relativePath: webConfigurationPath)
    guard let webConfiguration = try? PropertyListDecoder().decode(RemoteHostV3HostedWebConfiguration.self, from: Data(contentsOf: webConfigurationURL)) else {
      throw RemoteHostV3HostedChildPackagingError.invalidManifest
    }
    try validateWebConfiguration(webConfiguration)
    guard try digest(of: node) == manifest.nodeSHA256,
          try digest(of: entrypoint) == manifest.childEntrypointSHA256,
          try digest(of: bundle) == manifest.childBundleSHA256
    else { throw RemoteHostV3HostedChildPackagingError.digestMismatch }
    guard let treePath = manifest.relativeTreeManifestPath,
          let treeURL = try? artifactURL(resourceURL: resourceURL, relativePath: treePath),
          let treeData = try? Data(contentsOf: treeURL)
    else { throw RemoteHostV3HostedChildPackagingError.invalidManifest }
    try validateExecutableTree(resourceURL: resourceURL, manifestData: treeData)
    return RemoteHostV3HostedChildArtifacts(
      nodeExecutable: node,
      childEntrypoint: entrypoint,
      nodeRequirement: manifest.nodeRequirement,
      webConfiguration: webConfiguration
    )
  }

  public static func validateWebConfiguration(_ configuration: RemoteHostV3HostedWebConfiguration) throws {
    let parts = configuration.patchRelativePath.split(separator: "/", omittingEmptySubsequences: false)
    guard configuration.formatVersion == 1,
          configuration.dshHome.hasPrefix("/"), !configuration.dshHome.contains(".."),
          !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
          isLowercaseSHA256(configuration.patchSHA256),
          configuration.port >= 1, configuration.port <= 65_535,
          configuration.trustedHost.range(of: "^[A-Za-z0-9.-]+$", options: .regularExpression) != nil,
          !configuration.trustedHost.hasPrefix("."), !configuration.trustedHost.hasSuffix(".")
    else { throw RemoteHostV3HostedChildPackagingError.invalidManifest }
  }

  /**
   Validates the shipped node_modules tree structurally: package and total file
   counts match the manifest and the quick hash over every shipped file's
   node_modules-relative path and byte size reproduces exactly. Deep content
   integrity is carried by the Host bundle's own code signature, which seals
   these resources at assembly time.
   */
  static func validateTreeShipped() throws { throw RemoteHostV3HostedChildPackagingError.invalidManifest }
  static func isLowercaseSHA256(_ value: String) -> Bool {
    value.count == 64 && value.allSatisfy { $0.isNumber || ("a"..."f").contains($0) }
  }

  // MARK: - Shared sealed-validation helpers (internal to this module)

  static func validateImmutableInstallation(resourceURL: URL) throws {
    do {
      try RemoteHostV3SealedGatewayPackaging.validateImmutableInstallation(resourceURL)
    } catch {
      throw RemoteHostV3HostedChildPackagingError.mutableInstallation
    }
  }

  static func artifactURL(resourceURL: URL, relativePath: String) throws -> URL {
    guard !relativePath.contains(".."),
          relativePath == "HostedChild" || relativePath.hasPrefix("HostedChild/") || relativePath.hasPrefix("GatewayRuntime/")
    else { throw RemoteHostV3HostedChildPackagingError.invalidManifest }
    let url = resourceURL.appendingPathComponent(relativePath)
    var status = stat()
    guard lstat(url.path, &status) == 0 else {
      throw RemoteHostV3HostedChildPackagingError.missingArtifact
    }
    guard (status.st_mode & S_IFMT) != S_IFLNK else {
      throw RemoteHostV3HostedChildPackagingError.symlinkedArtifact
    }
    return url
  }

  static func digest(of url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let chunk = try handle.read(upToCount: 1 << 20)
      guard let chunk, !chunk.isEmpty else { break }
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /** Validates the complete, sealed JavaScript import closure and rejects extras. */
  static func validateExecutableTree(resourceURL: URL, manifestData: Data) throws {
    guard let root = try? PropertyListSerialization.propertyList(from: manifestData, format: nil) as? [String: Any],
          (root["formatVersion"] as? NSNumber)?.intValue == 2,
          let entries = root["entries"] as? [[String: Any]], !entries.isEmpty
    else { throw RemoteHostV3HostedChildPackagingError.invalidManifest }
    var listed = Set<String>()
    for entry in entries {
      guard Set(entry.keys) == Set(["relativePath", "sha256"]),
            let path = entry["relativePath"] as? String,
            let hash = entry["sha256"] as? String,
            path.hasPrefix("HostedChild/"), !path.contains(".."),
            isLowercaseSHA256(hash), listed.insert(path).inserted
      else { throw RemoteHostV3HostedChildPackagingError.invalidManifest }
      let file = try artifactURL(resourceURL: resourceURL, relativePath: path)
      var status = stat()
      guard lstat(file.path, &status) == 0, (status.st_mode & S_IFMT) == S_IFREG,
            RemoteHostV3SealedGatewayPackaging.isTrustedInstallationNode(
              owner: status.st_uid, mode: status.st_mode,
              hasExtendedACL: RemoteHostV3SealedGatewayPackaging.hasExtendedACL(file.path),
              expectedOwner: try RemoteHostV3SealedGatewayPackaging.expectedInstallationOwner(resourceURL: resourceURL)
            )
      else { throw RemoteHostV3HostedChildPackagingError.mutableInstallation }
      guard try digest(of: file) == hash else { throw RemoteHostV3HostedChildPackagingError.digestMismatch }
    }
    let hostedRoot = try artifactURL(resourceURL: resourceURL, relativePath: "HostedChild")
    let enumerator = FileManager.default.enumerator(at: hostedRoot, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles])
    while let url = enumerator?.nextObject() as? URL {
      let relative = "HostedChild/" + url.path.replacingOccurrences(of: hostedRoot.path + "/", with: "")
      var status = stat()
      guard lstat(url.path, &status) == 0 else { throw RemoteHostV3HostedChildPackagingError.missingArtifact }
      guard (status.st_mode & S_IFMT) != S_IFLNK else { throw RemoteHostV3HostedChildPackagingError.symlinkedArtifact }
      guard RemoteHostV3SealedGatewayPackaging.isTrustedInstallationNode(
        owner: status.st_uid, mode: status.st_mode,
        hasExtendedACL: RemoteHostV3SealedGatewayPackaging.hasExtendedACL(url.path),
        expectedOwner: try RemoteHostV3SealedGatewayPackaging.expectedInstallationOwner(resourceURL: resourceURL)
      ) else { throw RemoteHostV3HostedChildPackagingError.mutableInstallation }
      if (status.st_mode & S_IFMT) == S_IFDIR { continue }
      guard (status.st_mode & S_IFMT) == S_IFREG else { throw RemoteHostV3HostedChildPackagingError.invalidManifest }
      if relative == "HostedChild/node" || relative == "HostedChild/HostedChildManifest.plist" || relative == "HostedChild/TreeManifest.plist" || relative == webConfigurationPath { continue }
      guard listed.contains(relative) else { throw RemoteHostV3HostedChildPackagingError.invalidManifest }
    }
  }

}
