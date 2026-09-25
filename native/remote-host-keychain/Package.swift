// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "dsh-remote-host-keychain",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "dsh-remote-host-keychain", targets: ["RemoteHostKeychain"]),
  ],
  targets: [
    .executableTarget(
      name: "RemoteHostKeychain",
      path: "Sources/RemoteHostKeychain",
      linkerSettings: [.linkedFramework("Security")],
    ),
    .testTarget(name: "RemoteHostKeychainTests", dependencies: ["RemoteHostKeychain"]),
  ],
)
