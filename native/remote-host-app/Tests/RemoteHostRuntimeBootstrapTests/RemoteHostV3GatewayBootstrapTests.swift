import CryptoKit
import Foundation
import Testing
@testable import RemoteHostRuntimeBootstrap
@testable import RemoteHostWire

@Test func gatewayBootstrapFixesTheOnlyPrivateRuntimeInvocation() throws {
  #expect(RemoteHostV3GatewayBootstrap.privateDescriptor == 198)
  try RemoteHostV3GatewayBootstrap.validatePrivateRuntimeInvocation(["--private-fd", "198"])
  #expect(throws: RemoteHostV3GatewayBootstrapError.invalidPrivateRuntimeInvocation) {
    try RemoteHostV3GatewayBootstrap.validatePrivateRuntimeInvocation(["--private-fd", "197"])
  }
  #expect(throws: RemoteHostV3GatewayBootstrapError.invalidPrivateRuntimeInvocation) {
    try RemoteHostV3GatewayBootstrap.validatePrivateRuntimeInvocation(["--private-fd", "198", "--inspect"])
  }
}

@Test func gatewayBootstrapAcceptsOnlyTheFixedDirections() throws {
  for kind in [RemoteWireKind.routeUpsert, .routeRevoked, .epochBegin, .epochCommit, .connectionOpen, .connectionFrame, .connectionClosed, .hostStopping, .deviceEnroll, .enrollmentSeed] {
    let record = RemoteWireRecord(kind: kind)
    try RemoteHostV3GatewayBootstrap.validate(record, direction: .hostToGateway)
    #expect(throws: RemoteHostV3GatewayBootstrapError.wrongRecordDirection) {
      try RemoteHostV3GatewayBootstrap.validate(record, direction: .gatewayToHost)
    }
  }
  for kind in [RemoteWireKind.runtimeReady, .epochBegun, .epochCommitted, .connectionSend, .connectionClose, .deviceEnrolled] {
    let record = RemoteWireRecord(kind: kind)
    try RemoteHostV3GatewayBootstrap.validate(record, direction: .gatewayToHost)
    #expect(throws: RemoteHostV3GatewayBootstrapError.wrongRecordDirection) {
      try RemoteHostV3GatewayBootstrap.validate(record, direction: .hostToGateway)
    }
  }
}

@Test func gatewayBootstrapRejectsOversizedOrNonUTF8RecordsBeforeDirectionUse() {
  #expect(throws: RemoteHostV3GatewayBootstrapError.invalidRecord) {
    try RemoteHostV3GatewayBootstrap.validate(RemoteWireRecord(kind: .deviceEnroll, metadata: Data([0xff])), direction: .hostToGateway)
  }
  #expect(throws: RemoteHostV3GatewayBootstrapError.invalidRecord) {
    try RemoteHostV3GatewayBootstrap.validate(RemoteWireRecord(kind: .connectionFrame, payload: Data(repeating: 1, count: RemoteWire.maximumRecordBytes)), direction: .hostToGateway)
  }
}

@Test func currentAppHasNoGatewayLaunchPlanUntilAllSealedArtifactsArePackaged() {
  #expect(RemoteHostV3GatewayBootstrap.unavailablePackagingRequirements == [.signedNodeExecutable, .sealedGatewayEntrypoint])
}

@Test func hostedWebConfigurationRequiresOneCanonicalStoreAndFixedLaunchFacts() throws {
  let configuration = RemoteHostV3HostedWebConfiguration(
    formatVersion: 1, dshHome: "/Users/example/.dsh", patchRelativePath: "rc8-core.patch.yml", patchSHA256: String(repeating: "a", count: 64),
    port: 3080, trustedHost: "dsh.example.invalid"
  )
  try RemoteHostV3HostedChildPackaging.validateWebConfiguration(configuration)
  #expect(throws: RemoteHostV3HostedChildPackagingError.invalidManifest) {
    try RemoteHostV3HostedChildPackaging.validateWebConfiguration(.init(
      formatVersion: 1, dshHome: "/Users/example/.dsh", patchRelativePath: "../mutable.yml", patchSHA256: String(repeating: "a", count: 64),
      port: 3080, trustedHost: "dsh.example.invalid"
    ))
  }
}

@Test func sealedGatewayManifestIsClosedToTheEmbeddedNodeEntrypointAndFD198Addon() throws {
  let manifest = RemoteHostV3SealedGatewayManifest(
    formatVersion: 2,
    relativeNodeExecutablePath: "GatewayRuntime/node",
    relativeGatewayEntrypointPath: "GatewayRuntime/dsh-remote-host-v3.mjs",
    relativeGatewayCloexecAddonPath: "GatewayRuntime/fd198-cloexec.node",
    nodeSHA256: String(repeating: "a", count: 64),
    gatewayEntrypointSHA256: String(repeating: "b", count: 64),
    gatewayCloexecAddonSHA256: String(repeating: "c", count: 64),
    nodeRequirement: "anchor apple generic and identifier \"com.deepseek.dsh.remote-host-gateway-node\"",
    gatewayCloexecAddonRequirement: "anchor apple generic and identifier \"com.deepseek.dsh.remote-host-gateway-fd198-cloexec\"",
  )
  try RemoteHostV3SealedGatewayPackaging.validateManifest(manifest)

  let pathSubstitution = RemoteHostV3SealedGatewayManifest(
    formatVersion: 2,
    relativeNodeExecutablePath: "../../usr/bin/node",
    relativeGatewayEntrypointPath: "GatewayRuntime/dsh-remote-host-v3.mjs",
    relativeGatewayCloexecAddonPath: "GatewayRuntime/fd198-cloexec.node",
    nodeSHA256: String(repeating: "a", count: 64),
    gatewayEntrypointSHA256: String(repeating: "b", count: 64),
    gatewayCloexecAddonSHA256: String(repeating: "c", count: 64),
    nodeRequirement: "anchor apple generic",
    gatewayCloexecAddonRequirement: "anchor apple generic",
  )
  #expect(throws: RemoteHostV3SealedGatewayPackagingError.invalidManifest) {
    try RemoteHostV3SealedGatewayPackaging.validateManifest(pathSubstitution)
  }
}

@Test func sealedGatewayManifestRejectsNonReleaseDigestsAndUnsignedRequirements() {
  let upperCaseDigest = RemoteHostV3SealedGatewayManifest(
    formatVersion: 2,
    relativeNodeExecutablePath: "GatewayRuntime/node",
    relativeGatewayEntrypointPath: "GatewayRuntime/dsh-remote-host-v3.mjs",
    relativeGatewayCloexecAddonPath: "GatewayRuntime/fd198-cloexec.node",
    nodeSHA256: String(repeating: "A", count: 64),
    gatewayEntrypointSHA256: String(repeating: "b", count: 64),
    gatewayCloexecAddonSHA256: String(repeating: "c", count: 64),
    nodeRequirement: "anchor apple generic",
    gatewayCloexecAddonRequirement: "anchor apple generic",
  )
  #expect(throws: RemoteHostV3SealedGatewayPackagingError.invalidManifest) {
    try RemoteHostV3SealedGatewayPackaging.validateManifest(upperCaseDigest)
  }

  let missingRequirement = RemoteHostV3SealedGatewayManifest(
    formatVersion: 2,
    relativeNodeExecutablePath: "GatewayRuntime/node",
    relativeGatewayEntrypointPath: "GatewayRuntime/dsh-remote-host-v3.mjs",
    relativeGatewayCloexecAddonPath: "GatewayRuntime/fd198-cloexec.node",
    nodeSHA256: String(repeating: "a", count: 64),
    gatewayEntrypointSHA256: String(repeating: "b", count: 64),
    gatewayCloexecAddonSHA256: String(repeating: "c", count: 64),
    nodeRequirement: "identifier \"com.deepseek.dsh.remote-host-gateway-node\"",
    gatewayCloexecAddonRequirement: "anchor apple generic",
  )
  #expect(throws: RemoteHostV3SealedGatewayPackagingError.invalidManifest) {
    try RemoteHostV3SealedGatewayPackaging.validateManifest(missingRequirement)
  }
}

@Test func sealedGatewayManifestRejectsAnIntermediateGatewayRuntimeSymlink() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
  let outside = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer {
    try? FileManager.default.removeItem(at: root)
    try? FileManager.default.removeItem(at: outside)
  }
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
  let node = outside.appendingPathComponent("node")
  let entrypoint = outside.appendingPathComponent("dsh-remote-host-v3.mjs")
  try Data("node".utf8).write(to: node)
  try Data("entrypoint".utf8).write(to: entrypoint)
  try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("GatewayRuntime"), withDestinationURL: outside)
  let manifest = RemoteHostV3SealedGatewayManifest(
    formatVersion: 2,
    relativeNodeExecutablePath: "GatewayRuntime/node",
    relativeGatewayEntrypointPath: "GatewayRuntime/dsh-remote-host-v3.mjs",
    relativeGatewayCloexecAddonPath: "GatewayRuntime/fd198-cloexec.node",
    nodeSHA256: gatewayDigest(Data("node".utf8)),
    gatewayEntrypointSHA256: gatewayDigest(Data("entrypoint".utf8)),
    gatewayCloexecAddonSHA256: gatewayDigest(Data("addon".utf8)),
    nodeRequirement: "anchor apple generic",
    gatewayCloexecAddonRequirement: "anchor apple generic",
  )
  #expect(throws: RemoteHostV3SealedGatewayPackagingError.symlinkedArtifact) {
    try RemoteHostV3SealedGatewayPackaging.validateArtifacts(resourceURL: root, manifest: manifest)
  }
}

@Test func sealedGatewayPackagingRejectsASubstitutableBundleBeforeAnyArtifactPathCanBeUsed() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let resources = root.appendingPathComponent("Mutable.app/Contents/Resources", isDirectory: true)
  let runtime = resources.appendingPathComponent("GatewayRuntime", isDirectory: true)
  try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
  try Data("""
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.dsh.mutable-test</string></dict></plist>
  """.utf8).write(to: root.appendingPathComponent("Mutable.app/Contents/Info.plist"))
  for name in ["node", "dsh-remote-host-v3.mjs", "fd198-cloexec.node", "GatewayRuntimeManifest.plist"] {
    try Data("substitutable \(name)".utf8).write(to: runtime.appendingPathComponent(name))
  }
  guard let bundle = Bundle(path: root.appendingPathComponent("Mutable.app").path) else {
    Issue.record("Could not construct the temporary mutable bundle")
    return
  }

  #expect(throws: RemoteHostV3SealedGatewayPackagingError.invalidHostCodeSignature) {
    try RemoteHostV3SealedGatewayPackaging.loadAndValidateBundledArtifacts(bundle: bundle)
  }
}

@Test func sealedGatewayInstallationAcceptsOnlyItsDeclaredOwnerWithoutSharedWritersOrACL() {
  let root: uid_t = 0
  let admin: gid_t = 80
  let user: uid_t = 501
  _ = admin
  #expect(RemoteHostV3SealedGatewayPackaging.isTrustedInstallationNode(owner: root, mode: S_IFDIR | 0o755, hasExtendedACL: false, expectedOwner: root))
  #expect(RemoteHostV3SealedGatewayPackaging.isTrustedInstallationNode(owner: user, mode: S_IFDIR | 0o755, hasExtendedACL: false, expectedOwner: user))
  #expect(!RemoteHostV3SealedGatewayPackaging.isTrustedInstallationNode(owner: user, mode: S_IFDIR | 0o775, hasExtendedACL: false, expectedOwner: user))
  #expect(!RemoteHostV3SealedGatewayPackaging.isTrustedInstallationNode(owner: root, mode: S_IFDIR | 0o755, hasExtendedACL: false, expectedOwner: user))
  #expect(!RemoteHostV3SealedGatewayPackaging.isTrustedInstallationNode(owner: user, mode: S_IFDIR | 0o755, hasExtendedACL: true, expectedOwner: user))
}

@Test func sealedGatewayMatchesOnlyTheExactPackagedDesignatedRequirementText() {
  let expected = "identifier \"com.deepseek.dsh.remote-host\" and anchor apple generic and certificate leaf[subject.OU] = F2H9RBSH38"
  let substituted = "identifier \"com.deepseek.dsh.remote-host\" and anchor apple generic and certificate leaf[subject.OU] = ATTACKER123"
  #expect(RemoteHostV3SealedGatewayPackaging.matchesPackagedDesignatedRequirement(expected, designated: expected))
  #expect(!RemoteHostV3SealedGatewayPackaging.matchesPackagedDesignatedRequirement(expected, designated: substituted))
  #expect(!RemoteHostV3SealedGatewayPackaging.matchesPackagedDesignatedRequirement("identifier \"com.deepseek.dsh.remote-host\"", designated: "identifier \"com.deepseek.dsh.remote-host\""))
}

@Test func hostedAndGatewayLoadersShareTheTwoCanonicalInstallationBoundaries() throws {
  let home = URL(fileURLWithPath: "/Users/tester", isDirectory: true)
  #expect(try RemoteHostV3SealedGatewayPackaging.expectedInstallationOwner(
    resourceURL: URL(fileURLWithPath: "/Applications/DSHHost.app/Contents/Resources"), homeDirectory: home, effectiveUID: 501
  ) == 0)
  #expect(try RemoteHostV3SealedGatewayPackaging.expectedInstallationOwner(
    resourceURL: URL(fileURLWithPath: "/Users/tester/Applications/DSHHost.app/Contents/Resources"), homeDirectory: home, effectiveUID: 501
  ) == 501)
  let temporaryResources = URL(fileURLWithPath: "/tmp/DSHHost.app/Contents/Resources", isDirectory: true)
  #expect(throws: RemoteHostV3SealedGatewayPackagingError.mutableInstallation) {
    try RemoteHostV3SealedGatewayPackaging.validateImmutableInstallation(temporaryResources)
  }
  #expect(throws: RemoteHostV3HostedChildPackagingError.mutableInstallation) {
    try RemoteHostV3HostedChildPackaging.validateImmutableInstallation(resourceURL: temporaryResources)
  }
}

@Test func fd198CloseOnExecAddonPreventsANodeDescendantFromInheritingTheHostPipe() throws {
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
  let package = root.deletingLastPathComponent()
  let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: temporary) }
  try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
  let addon = temporary.appendingPathComponent("fd198-cloexec.node")
  let descendant = temporary.appendingPathComponent("descendant")
  let launcher = temporary.appendingPathComponent("launcher")
  try runFD198CloexecTool("/usr/bin/clang", ["-dynamiclib", "-arch", "arm64", "-fvisibility=hidden", "-Wl,-undefined,dynamic_lookup", package.appendingPathComponent("GatewayRuntime/fd198-cloexec.c").path, "-o", addon.path])
  try runFD198CloexecTool("/usr/bin/clang", ["-arch", "arm64", package.appendingPathComponent("Tests/fd198-cloexec-descendant.c").path, "-o", descendant.path])
  try runFD198CloexecTool("/usr/bin/clang", ["-arch", "arm64", package.appendingPathComponent("Tests/fd198-cloexec-launcher.c").path, "-o", launcher.path])
  let script = """
  const addon = { exports: {} }
  process.dlopen(addon, process.argv[1])
  addon.exports.setCloseOnExec()
  const result = require('node:child_process').spawnSync(process.argv[2], [], { stdio: 'ignore' })
  process.exit(result.status === 0 ? 0 : 1)
  """
  try runFD198CloexecTool(launcher.path, ["/usr/bin/env", "node", "-e", script, addon.path, descendant.path])
}

private func gatewayDigest(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func runFD198CloexecTool(_ executable: String, _ arguments: [String]) throws {
  let task = Process()
  task.executableURL = URL(fileURLWithPath: executable)
  task.arguments = arguments
  task.standardOutput = Pipe()
  task.standardError = Pipe()
  try task.run()
  task.waitUntilExit()
  guard task.terminationStatus == 0 else { throw RemoteHostV3GatewayBootstrapError.invalidPrivateRuntimeInvocation }
}
