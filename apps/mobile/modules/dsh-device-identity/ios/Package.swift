// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DshDeviceIdentityPresence",
  products: [
    .library(name: "DshDeviceIdentityPresence", targets: ["DshDeviceIdentityPresence"]),
  ],
  targets: [
    .target(name: "DshDeviceIdentityPresence", path: "Sources/DshDeviceIdentityPresence"),
    .testTarget(name: "DshDeviceIdentityPresenceTests", dependencies: ["DshDeviceIdentityPresence"], path: "Tests/DshDeviceIdentityPresenceTests"),
  ]
)
