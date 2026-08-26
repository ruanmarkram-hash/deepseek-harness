import Foundation

/** Closed failures for the FD199 authority, wire, and journal. */
public enum Fd199Error: Error, Equatable, Sendable {
  case malformed
  case invalidState
  case bounds
  case proof
  case journal
}

/// Direction-tagged child-to-authority messages, byte-compatible with the
/// TypeScript `@deepseek-ai/dsh-remote-host-fd199` client.
public enum Fd199ClientMessage: Equatable, Sendable {
  case hello
  case recover
  case desktopReady
  case prepareFile(name: String, sha256: String, bytesBase64: String)
  case prepareComplete
  case releasing
  case activate
}

/// Direction-tagged authority-to-child messages.
public enum Fd199AuthorityMessage: Equatable, Sendable {
  case ready(hostAppPath: String)
  case snapshot(status: Fd199OwnershipStatus, generation: Int)
  case releaseAuthorized
  case activated(generation: Int)
  case instruct(action: Fd199InstructionAction)
}

/// Journal ownership status reported after native revalidation.
public enum Fd199OwnershipStatus: Equatable, Sendable {
  case none
  case exported
  case releasing
  case prepared
  case activated
}

/// Authority-initiated lifecycle instructions.
public enum Fd199InstructionAction: Equatable, Sendable {
  case prepare
  case activate
}

/// The only protocol version this module speaks.
public let fd199ProtocolVersion = 1

/// Maximum encoded body bytes: one 8 MiB export file base64-encoded plus overhead.
public let fd199MaximumBodyBytes = 16 * 1024 * 1024

/// Maximum export files in one prepared transition.
public let fd199MaximumFiles = 8_192

/// Maximum decoded export-file bytes.
public let fd199MaximumFileBytes = 8 * 1024 * 1024

let fd199ExportNamePattern = "^sessions\\/[A-Za-z0-9][A-Za-z0-9_-]{0,95}\\.jsonl$|^attachments\\/[a-f0-9]{64}$"
let fd256HexPattern = "^[a-f0-9]{64}$"

/**
 Parses one complete frame body into an authority message. Duplicate JSON
 keys, unknown keys, wrong direction vocabulary, and non-canonical encodings
 are rejected exactly like the TypeScript peer.
 - Parameter body: Exact UTF-8 JSON body bytes without the length prefix.
 */
public func fd199DecodeAuthorityFrame(_ body: Data) throws -> Fd199AuthorityMessage {
  let object = try fd199StrictObject(body)
  guard let kind = object["kind"] as? String else { throw Fd199Error.malformed }
  switch kind {
  case "ready":
    try fd199ExactKeys(object, ["kind", "protocolVersion", "hostAppPath"])
    guard object["protocolVersion"] as? Int == fd199ProtocolVersion else { throw Fd199Error.malformed }
    let path = try fd199String(object["hostAppPath"])
    guard path.hasPrefix("/"), path.count > 1, !path.contains("\u{0}"), !path.contains("\n") else { throw Fd199Error.malformed }
    return .ready(hostAppPath: path)
  case "snapshot":
    try fd199ExactKeys(object, ["kind", "status", "generation"])
    let status = try fd199Status(object["status"])
    let generation = try fd199Generation(object["generation"], minimum: 0)
    return .snapshot(status: status, generation: generation)
  case "release-authorized":
    try fd199ExactKeys(object, ["kind"])
    return .releaseAuthorized
  case "activated":
    try fd199ExactKeys(object, ["kind", "generation"])
    return .activated(generation: try fd199Generation(object["generation"], minimum: 1))
  case "instruct":
    try fd199ExactKeys(object, ["kind", "action"])
    guard let action = object["action"] as? String else { throw Fd199Error.malformed }
    if action == "prepare" { return .instruct(action: .prepare) }
    if action == "activate" { return .instruct(action: .activate) }
    throw Fd199Error.malformed
  default:
    throw Fd199Error.malformed
  }
}

/**
 Parses one complete frame body into a client message with the same strictness.
 */
public func fd199DecodeClientFrame(_ body: Data) throws -> Fd199ClientMessage {
  let object = try fd199StrictObject(body)
  guard let kind = object["kind"] as? String else { throw Fd199Error.malformed }
  switch kind {
  case "hello":
    try fd199ExactKeys(object, ["kind"])
    return .hello
  case "recover":
    try fd199ExactKeys(object, ["kind"])
    return .recover
  case "desktop-ready":
    try fd199ExactKeys(object, ["kind"])
    return .desktopReady
  case "prepare-file":
    try fd199ExactKeys(object, ["kind", "name", "sha256", "bytesBase64"])
    let name = try fd199String(object["name"])
    let sha256 = try fd199String(object["sha256"])
    let bytesBase64 = try fd199String(object["bytesBase64"])
    guard name.range(of: fd199ExportNamePattern, options: .regularExpression) != nil else { throw Fd199Error.malformed }
    guard sha256.range(of: fd256HexPattern, options: .regularExpression) != nil else { throw Fd199Error.malformed }
    guard !bytesBase64.isEmpty, bytesBase64.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil else { throw Fd199Error.malformed }
    guard let decoded = Data(base64Encoded: fd199PaddedBase64url(bytesBase64)),
          decoded.count <= fd199MaximumFileBytes else { throw Fd199Error.bounds }
    return .prepareFile(name: name, sha256: sha256, bytesBase64: bytesBase64)
  case "prepare-complete":
    try fd199ExactKeys(object, ["kind"])
    return .prepareComplete
  case "releasing":
    try fd199ExactKeys(object, ["kind"])
    return .releasing
  case "activate":
    try fd199ExactKeys(object, ["kind"])
    return .activate
  default:
    throw Fd199Error.malformed
  }
}

/**
 Encodes one client message into exact canonical compact JSON body bytes.
 */
public func fd199EncodeClientMessage(_ message: Fd199ClientMessage) throws -> Data {
  let text: String
  switch message {
  case .hello:
    text = "{\"kind\":\"hello\"}"
  case .recover:
    text = "{\"kind\":\"recover\"}"
  case .desktopReady:
    text = "{\"kind\":\"desktop-ready\"}"
  case let .prepareFile(name, sha256, bytesBase64):
    text = "{\"kind\":\"prepare-file\",\"name\":\(jsonString(name)),\"sha256\":\(jsonString(sha256)),\"bytesBase64\":\(jsonString(bytesBase64))}"
  case .prepareComplete:
    text = "{\"kind\":\"prepare-complete\"}"
  case .releasing:
    text = "{\"kind\":\"releasing\"}"
  case .activate:
    text = "{\"kind\":\"activate\"}"
  }
  return try fd199Body(Data(text.utf8))
}

/**
 Encodes one authority message into exact canonical compact JSON body bytes.
 */
public func fd199EncodeAuthorityMessage(_ message: Fd199AuthorityMessage) throws -> Data {
  let text: String
  switch message {
  case let .ready(hostAppPath):
    text = "{\"kind\":\"ready\",\"protocolVersion\":\(fd199ProtocolVersion),\"hostAppPath\":\(fd199JsonString(hostAppPath))}"
  case let .snapshot(status, generation):
    text = "{\"kind\":\"snapshot\",\"status\":\"\(fd199StatusText(status))\",\"generation\":\(generation)}"
  case .releaseAuthorized:
    text = "{\"kind\":\"release-authorized\"}"
  case let .activated(generation):
    text = "{\"kind\":\"activated\",\"generation\":\(generation)}"
  case let .instruct(action):
    let actionText = action == .prepare ? "prepare" : "activate"
    text = "{\"kind\":\"instruct\",\"action\":\"\(actionText)\"}"
  }
  return try fd199Body(Data(text.utf8))
}

// MARK: - Strict JSON

/**
 Parses one frame body into a flat string-keyed object while rejecting
 duplicate keys, unknown syntax, trailing content, and non-object roots.
 Nested values stay as NSNull/NSNumber/NSString/NSArray/NSDictionary results
 of the strict scan.
 */
func fd199StrictObject(_ body: Data) throws -> [String: Any] {
  guard body.count > 0, body.count <= fd199MaximumBodyBytes else { throw Fd199Error.bounds }
  guard let text = String(data: body, encoding: .utf8) else { throw Fd199Error.malformed }
  var cursor = StrictCursor(text: text)
  let value = try cursor.parseValue()
  cursor.skipWhitespace()
  guard cursor.isAtEnd else { throw Fd199Error.malformed }
  guard let object = value as? [String: Any] else { throw Fd199Error.malformed }
  return object
}

/// Mutable parse position with the shared failure behavior.
struct StrictCursor {
  let characters: [Character]
  var position = 0

  init(text: String) {
    characters = Array(text)
  }

  var isAtEnd: Bool { position >= characters.count }

  mutating func skipWhitespace() {
    while position < characters.count, characters[position] == " "
      || characters[position] == "\t"
      || characters[position] == "\n"
      || characters[position] == "\r" {
      position += 1
    }
  }

  mutating func peek() throws -> Character {
    guard position < characters.count else { throw Fd199Error.malformed }
    return characters[position]
  }

  mutating func take() throws -> Character {
    let character = try peek()
    position += 1
    return character
  }

  mutating func parseValue() throws -> Any {
    skipWhitespace()
    let character = try peek()
    if character == "{" { return try parseObject() }
    if character == "[" { return try parseArray() }
    if character == "\"" { return try parseString() }
    if hasPrefix("true") { position += 4; return true }
    if hasPrefix("false") { position += 5; return false }
    if hasPrefix("null") { position += 4; return NSNull() }
    return try parseNumber()
  }

  func hasPrefix(_ prefix: String) -> Bool {
    guard position + prefix.count <= characters.count else { return false }
    return Array(characters[position..<(position + prefix.count)]) == Array(prefix)
  }

  mutating func parseNumber() throws -> NSNumber {
    let allowed = CharacterSet(charactersIn: "-0123456789.eE+")
    var text = ""
    while position < characters.count, let scalar = characters[position].unicodeScalars.first, allowed.contains(scalar) {
      text.append(characters[position])
      position += 1
    }
    guard let number = Double(text), text.range(of: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$", options: .regularExpression) != nil else {
      throw Fd199Error.malformed
    }
    return NSNumber(value: number)
  }

  mutating func parseString() throws -> String {
    _ = try take()
    var output = ""
    while true {
      guard position < characters.count else { throw Fd199Error.malformed }
      let character = try take()
      if character == "\"" { return output }
      if character == "\\" {
        let escape = try take()
        switch escape {
        case "\"": output.append("\"")
        case "\\": output.append("\\")
        case "/": output.append("/")
        case "b": output.append("\u{08}")
        case "f": output.append("\u{0C}")
        case "n": output.append("\n")
        case "r": output.append("\r")
        case "t": output.append("\t")
        case "u":
          guard position + 4 <= characters.count else { throw Fd199Error.malformed }
          let hex = String(characters[position..<(position + 4)])
          guard let scalar = UInt32(hex, radix: 16), let unicode = Unicode.Scalar(scalar) else { throw Fd199Error.malformed }
          position += 4
          output.append(Character(unicode))
        default:
          throw Fd199Error.malformed
        }
        continue
      }
      guard let scalar = character.unicodeScalars.first, !scalar.properties.isDefaultIgnorableCodePoint, character.unicodeScalars.allSatisfy({ $0.value >= 0x20 }) else {
        throw Fd199Error.malformed
      }
      output.append(character)
    }
  }

  mutating func parseObject() throws -> [String: Any] {
    _ = try take()
    var object = [String: Any]()
    skipWhitespace()
    if try peek() == "}" {
      _ = try take()
      return object
    }
    while true {
      skipWhitespace()
      let key = try parseString()
      guard object[key] == nil else { throw Fd199Error.malformed }
      skipWhitespace()
      guard try take() == ":" else { throw Fd199Error.malformed }
      object[key] = try parseValue()
      skipWhitespace()
      let separator = try take()
      if separator == "}" { return object }
      guard separator == "," else { throw Fd199Error.malformed }
    }
  }

  mutating func parseArray() throws -> [Any] {
    _ = try take()
    var array = [Any]()
    skipWhitespace()
    if try peek() == "]" {
      _ = try take()
      return array
    }
    while true {
      array.append(try parseValue())
      skipWhitespace()
      let separator = try take()
      if separator == "]" { return array }
      guard separator == "," else { throw Fd199Error.malformed }
    }
  }
}

// MARK: - Shared helpers

func fd199ExactKeys(_ object: [String: Any], _ expected: Set<String>) throws {
  guard Set(object.keys) == expected else { throw Fd199Error.malformed }
}

func fd199String(_ value: Any?) throws -> String {
  guard let text = value as? String else { throw Fd199Error.malformed }
  return text
}

func fd199Status(_ value: Any?) throws -> Fd199OwnershipStatus {
  guard let text = value as? String else { throw Fd199Error.malformed }
  switch text {
  case "none": return .none
  case "exported": return .exported
  case "releasing": return .releasing
  case "prepared": return .prepared
  case "activated": return .activated
  default: throw Fd199Error.malformed
  }
}

func fd199StatusText(_ status: Fd199OwnershipStatus) -> String {
  switch status {
  case .none: return "none"
  case .exported: return "exported"
  case .releasing: return "releasing"
  case .prepared: return "prepared"
  case .activated: return "activated"
  }
}

func fd199Generation(_ value: Any?, minimum: Int) throws -> Int {
  guard let number = value as? NSNumber, let integer = number as? Int,
        integer >= minimum, integer <= 2_147_483_647, number == NSNumber(value: integer) else {
    throw Fd199Error.malformed
  }
  return integer
}

func fd199PaddedBase64url(_ value: String) -> String {
  var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  let padding = (4 - base64.count % 4) % 4
  base64.append(String(repeating: "=", count: padding))
  return base64
}

func fd199JsonString(_ value: String) -> String {
  var escaped = ""
  for character in value {
    switch character {
    case "\"": escaped.append("\\\"")
    case "\\": escaped.append("\\\\")
    case "\n": escaped.append("\\n")
    case "\r": escaped.append("\\r")
    case "\t": escaped.append("\\t")
    default:
      if let scalar = character.unicodeScalars.first, scalar.value < 0x20 {
        escaped.append(String(format: "\\u%04x", scalar.value))
      } else {
        escaped.append(character)
      }
    }
  }
  return "\"\(escaped)\""
}

func fd199Body(_ body: Data) throws -> Data {
  guard body.count <= fd199MaximumBodyBytes else { throw Fd199Error.bounds }
  return body
}
