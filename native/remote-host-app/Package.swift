// swift-tools-version: 6.2
import PackageDescription
import Foundation

let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let sodiumSourceHash = "bf2745b62184002bdb9a6e19bf41cf08678eacb0b6680b8806c87ce86a6977b9"
let sodiumArchiveHash = "01027432dbed0b8b6617a42085d4d67929cde37e46e8344b3380385bcaac74e5"
let sodiumRoot = packageRoot.appendingPathComponent("third_party/libsodium/prebuilt/macos-arm64")
let sodiumSource = packageRoot.appendingPathComponent("third_party/libsodium/libsodium-1.0.22-stable.tar.gz")
let sodiumStaticArchive = sodiumRoot.appendingPathComponent("libsodium.a")

func sha256(_ url: URL) -> String? {
  let task = Process()
  task.executableURL = URL(fileURLWithPath: "/usr/bin/shasum")
  task.arguments = ["-a", "256", url.path]
  let output = Pipe()
  task.standardOutput = output
  task.standardError = Pipe()
  do { try task.run() } catch { return nil }
  task.waitUntilExit()
  guard task.terminationStatus == 0,
        let line = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.split(separator: " ").first,
        line.count == 64 else { return nil }
  return String(line)
}

func commandOutput(_ executable: String, _ arguments: [String]) -> String? {
  let task = Process()
  task.executableURL = URL(fileURLWithPath: executable)
  task.arguments = arguments
  let output = Pipe()
  task.standardOutput = output
  task.standardError = Pipe()
  do { try task.run() } catch { return nil }
  task.waitUntilExit()
  guard task.terminationStatus == 0 else { return nil }
  return String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
}

let resolvedBuildRoot = sodiumRoot.resolvingSymlinksInPath().path + "/"
let resolvedArchive = sodiumStaticArchive.resolvingSymlinksInPath().path
guard commandOutput("/usr/bin/uname", ["-m"]) == "arm64",
      sha256(sodiumSource) == sodiumSourceHash,
      resolvedArchive.hasPrefix(resolvedBuildRoot),
      sha256(sodiumStaticArchive) == sodiumArchiveHash else {
  fatalError("SodiumXChaChaBridge requires the tracked macOS-arm64 libsodium archive with its pinned digest")
}

let package = Package(
  name: "dsh-remote-host-app",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "dsh-remote-host-app", targets: ["RemoteHostApp"]),
    .executable(name: "dsh-remote-host-runtime", targets: ["RemoteHostRuntime"]),
  ],
  targets: [
    .target(name: "RemoteHostWire"),
    .target(name: "RemoteHostFd199", dependencies: ["RemoteHostWire"]),
    .target(
      name: "RemoteHostRuntimeBootstrap",
      dependencies: ["RemoteHostWire"],
      path: "Sources/RemoteHostRuntime/Bootstrap",
    ),
    .target(name: "SodiumXChaChaBridge", path: "Sources/SodiumXChaChaBridge", publicHeadersPath: "include", linkerSettings: [.unsafeFlags([sodiumStaticArchive.path])]),
    .target(name: "RemoteHostXChaCha", dependencies: ["SodiumXChaChaBridge"], linkerSettings: [.linkedFramework("Security")]),
    .target(
      name: "RemoteHostRelay",
      dependencies: ["RemoteHostFd199", "RemoteHostRuntimeBootstrap", "RemoteHostWire", "RemoteHostXChaCha"],
      linkerSettings: [.linkedFramework("Security"), .linkedFramework("LocalAuthentication")],
    ),
    .executableTarget(
      name: "RemoteHostApp",
      dependencies: ["RemoteHostWire", "RemoteHostRelay", "RemoteHostFd199"],
      path: "Sources/RemoteHostApp",
      linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("Security")],
    ),
    .executableTarget(
      name: "RemoteHostRuntime",
      dependencies: ["RemoteHostFd199", "RemoteHostRuntimeBootstrap", "RemoteHostWire", "RemoteHostRelay"],
      path: "Sources/RemoteHostRuntime",
      exclude: ["Bootstrap"],
      linkerSettings: [.linkedFramework("Security")],
    ),
    .testTarget(name: "RemoteHostWireTests", dependencies: ["RemoteHostWire"]),
    .testTarget(name: "RemoteHostFd199Tests", dependencies: ["RemoteHostFd199", "RemoteHostWire"]),
    .testTarget(name: "RemoteHostRuntimeBootstrapTests", dependencies: ["RemoteHostRuntimeBootstrap", "RemoteHostWire"]),
    .testTarget(name: "RemoteHostRelayTests", dependencies: ["RemoteHostRelay", "RemoteHostFd199", "RemoteHostXChaCha"], resources: [.copy("fixtures/v3-3dh-noble.json")]),
    .testTarget(
      name: "RemoteHostXChaChaTests",
      dependencies: ["RemoteHostXChaCha"],
      resources: [.copy("fixtures/xchacha-v3-noble.json")],
    ),
    .testTarget(
      name: "RemoteHostAppTests",
      dependencies: ["RemoteHostApp", "RemoteHostFd199", "RemoteHostWire"],
    ),
  ],
)
