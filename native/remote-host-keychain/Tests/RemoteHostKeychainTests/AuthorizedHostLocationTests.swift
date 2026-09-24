import Foundation
import Testing
@testable import RemoteHostKeychain

@Test func authorizedHostLocationSurvivesWholeAppRelocation() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let original = root.appendingPathComponent("build/DSHHost.app", isDirectory: true)
  try makeHost(at: original)
  let installed = root.appendingPathComponent("Applications/DSHHost.app", isDirectory: true)
  try FileManager.default.createDirectory(at: installed.deletingLastPathComponent(), withIntermediateDirectories: true)
  try FileManager.default.moveItem(at: original, to: installed)

  let service = installed.appendingPathComponent("Contents/XPCServices/DSHRemoteHostKeychain.xpc", isDirectory: true)
  let location = try authorizedHostLocation(serviceBundleURL: service, client: client)
  #expect(location.bundleURL == installed.standardizedFileURL)
  #expect(location.executableURL == installed.appendingPathComponent("Contents/MacOS/dsh-remote-host-app"))
}

@Test func authorizedHostLocationRejectsASymlinkedApp() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let actual = root.appendingPathComponent("actual/DSHHost.app", isDirectory: true)
  try makeHost(at: actual)
  let linked = root.appendingPathComponent("Applications/DSHHost.app", isDirectory: true)
  try FileManager.default.createDirectory(at: linked.deletingLastPathComponent(), withIntermediateDirectories: true)
  try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: actual)
  let service = linked.appendingPathComponent("Contents/XPCServices/DSHRemoteHostKeychain.xpc", isDirectory: true)
  #expect(throws: (any Error).self) { try authorizedHostLocation(serviceBundleURL: service, client: client) }
}

private let client = AuthorizedClient(
  requirement: "identifier \"com.deepseek.dsh.remote-host\"",
  bundleIdentifier: "com.deepseek.dsh.remote-host",
  bundleVersion: "1"
)

private func makeHost(at app: URL) throws {
  try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
  try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/XPCServices/DSHRemoteHostKeychain.xpc"), withIntermediateDirectories: true)
  try Data("host".utf8).write(to: app.appendingPathComponent("Contents/MacOS/dsh-remote-host-app"))
  try Data("""
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.deepseek.dsh.remote-host</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  </dict></plist>
  """.utf8).write(to: app.appendingPathComponent("Contents/Info.plist"))
}
