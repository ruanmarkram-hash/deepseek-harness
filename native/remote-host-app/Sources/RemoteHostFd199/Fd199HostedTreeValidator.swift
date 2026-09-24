import Foundation

/**
 One promised node_modules link: package name and the exact absolute target
 the signed TreeManifest.plist recorded at assembly time.
 */
public struct Fd199HostedTreeEntry: Codable, Equatable, Sendable {
  public let name: String
  public let target: String

  public init(name: String, target: String) {
    self.name = name
    self.target = target
  }
}

/** Decoded tree manifest sealed inside the Host bundle. */
public struct Fd199HostedTreeManifest: Codable, Equatable, Sendable {
  public let formatVersion: Int
  public let packageCount: Int
  public let entries: [Fd199HostedTreeEntry]
}

/**
 Validates the external node_modules link farm against the sealed tree
 manifest. The farm lives outside the code-signed bundle (codesign forbids
 outbound symlinks in sealed resources), so its integrity model is
 structural: every promised link must exist and resolve to the exact
 recorded target, with no unlisted links beside them. Content trust comes
 from the local signed checkout that produced the targets.
 */
public enum Fd199HostedTreeValidator {
  public static func decodeManifest(_ data: Data) throws -> Fd199HostedTreeManifest {
    let manifest = try PropertyListDecoder().decode(Fd199HostedTreeManifest.self, from: data)
    guard manifest.formatVersion == 1,
          manifest.entries.count == manifest.packageCount,
          !manifest.entries.isEmpty
    else { throw Fd199Error.invalidState }
    return manifest
  }

  /**
   - Parameters:
     - manifestData: Raw TreeManifest.plist bytes from the Host bundle.
     - nodeModulesRoot: The external directory the farm was generated into.
   */
  public static func validate(root nodeModulesRoot: String, manifestData: Data) throws {
    let manifest = try decodeManifest(manifestData)
    var seen = Set<String>()
    for entry in manifest.entries {
      guard !seen.contains(entry.name) else { throw Fd199Error.invalidState }
      seen.insert(entry.name)
      let linkURL = URL(fileURLWithPath: nodeModulesRoot).appendingPathComponent(entry.name)
      guard let values = try? linkURL.resourceValues(forKeys: [.isSymbolicLinkKey]),
            values.isSymbolicLink == true,
            (try? FileManager.default.destinationOfSymbolicLink(atPath: linkURL.path)) == entry.target
      else { throw Fd199Error.journal }
    }
    guard let present = try? FileManager.default.contentsOfDirectory(atPath: nodeModulesRoot) else {
      throw Fd199Error.journal
    }
    for name in present where name != ".DS_Store" {
      guard seen.contains(name) || seen.contains(where: { $0.hasPrefix("\(name)/") }) else {
        throw Fd199Error.invalidState
      }
    }
  }
}
