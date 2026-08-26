import Foundation
import SodiumXChaChaBridge
import Security

public enum XChaChaError: Error { case invalidInput, failed, nonceExhausted, randomFailure }
public struct XChaChaKey: Sendable {
  var bytes: Data
  public init(_ value: Data) throws {
    guard value.count == 32 else { throw XChaChaError.invalidInput }
    var owned = Data(count: 32)
    _ = owned.withUnsafeMutableBytes { destination in value.withUnsafeBytes { source in memcpy(destination.baseAddress!, source.baseAddress!, 32) } }
    bytes = owned
  }
  mutating func destroy() { XChaCha.zeroize(&bytes) }
}
public struct XChaChaNonce: Sendable { let bytes: Data; public init(_ value: Data) throws { guard value.count == 12 else { throw XChaChaError.invalidInput }; bytes = value }; public var encoded: Data { bytes } }
public enum XChaCha {
  public static func seal(_ plaintext: Data, aad: Data = Data(), key: XChaChaKey, nonce: XChaChaNonce) throws -> Data { try crypt(plaintext, aad: aad, key: key, nonce: nonce, decrypt: false) }
  public static func open(_ ciphertext: Data, aad: Data = Data(), key: XChaChaKey, nonce: XChaChaNonce) throws -> Data { try crypt(ciphertext, aad: aad, key: key, nonce: nonce, decrypt: true) }
  /// Overwrites the currently addressable bytes. The caller owns the lifetime of the buffer.
  public static func zeroize(_ value: inout Data) {
    value.withUnsafeMutableBytes { bytes in
      guard let base = bytes.baseAddress, !bytes.isEmpty else { return }
      dsh_secure_zero(base, bytes.count)
    }
  }
  public static func zeroize(_ value: inout Data?) {
    guard value != nil else { return }
    value!.withUnsafeMutableBytes { bytes in
      guard let base = bytes.baseAddress, !bytes.isEmpty else { return }
      dsh_secure_zero(base, bytes.count)
    }
  }
  private static func crypt(_ input: Data, aad: Data, key: XChaChaKey, nonce: XChaChaNonce, decrypt: Bool) throws -> Data {
    var output = Data(count: decrypt ? max(0, input.count - 16) : input.count + 16); var length: UInt64 = 0
    let result = output.withUnsafeMutableBytes { out in input.withUnsafeBytes { value in aad.withUnsafeBytes { auth in key.bytes.withUnsafeBytes { key in nonce.bytes.withUnsafeBytes { nonce in
      decrypt ? dsh_chacha_decrypt(out.bindMemory(to: UInt8.self).baseAddress, &length, value.bindMemory(to: UInt8.self).baseAddress, UInt64(input.count), auth.bindMemory(to: UInt8.self).baseAddress, UInt64(aad.count), nonce.bindMemory(to: UInt8.self).baseAddress, key.bindMemory(to: UInt8.self).baseAddress) : dsh_chacha_encrypt(out.bindMemory(to: UInt8.self).baseAddress, &length, value.bindMemory(to: UInt8.self).baseAddress, UInt64(input.count), auth.bindMemory(to: UInt8.self).baseAddress, UInt64(aad.count), nonce.bindMemory(to: UInt8.self).baseAddress, key.bindMemory(to: UInt8.self).baseAddress)
    } } } } }
    guard result == 0 else { throw XChaChaError.failed }; output.count = Int(length); return output
  }
}

struct XChaChaNonceSequence: Sendable {
  private var prefix: Data
  private var counter: UInt64
  private var exhausted = false

  init(prefix: Data, initialCounter: UInt64 = 0) throws {
    guard prefix.count == 4 else { throw XChaChaError.invalidInput }
    self.prefix = prefix
    self.counter = initialCounter
  }

  mutating func next() throws -> XChaChaNonce {
    guard !exhausted else { throw XChaChaError.nonceExhausted }
    var encodedCounter = counter.bigEndian
    var bytes = prefix
    withUnsafeBytes(of: &encodedCounter) { bytes.append(contentsOf: $0) }
    exhausted = counter == .max
    counter &+= 1
    return try XChaChaNonce(bytes)
  }
  mutating func destroy() { XChaCha.zeroize(&prefix); counter = 0; exhausted = true }
}

public struct XChaChaSealedFrame: Sendable {
  public let nonce: XChaChaNonce
  public let ciphertext: Data
}

/// The only production encryption entrypoint. It allocates a fresh nonce for every frame.
public actor XChaChaFrameSealer {
  private var key: XChaChaKey?
  private var nonces: XChaChaNonceSequence

  public init(key: XChaChaKey) throws {
    var prefix = Data(count: 4)
    let result = prefix.withUnsafeMutableBytes { bytes in
      guard let base = bytes.bindMemory(to: UInt8.self).baseAddress else { return errSecParam }
      return SecRandomCopyBytes(kSecRandomDefault, bytes.count, base)
    }
    guard result == errSecSuccess else { throw XChaChaError.randomFailure }
    self.key = key
    self.nonces = try XChaChaNonceSequence(prefix: prefix)
  }

  init(key: XChaChaKey, nonces: XChaChaNonceSequence) {
    self.key = key
    self.nonces = nonces
  }
  @_spi(DSHTesting) public init(key: XChaChaKey, noncePrefix: Data) throws {
    self.key = key
    self.nonces = try XChaChaNonceSequence(prefix: noncePrefix)
  }

  public func seal(_ plaintext: Data, aad: Data = Data()) throws -> XChaChaSealedFrame {
    let nonce = try nonces.next()
    guard let key else { throw XChaChaError.failed }
    return XChaChaSealedFrame(nonce: nonce, ciphertext: try XChaCha.seal(plaintext, aad: aad, key: key, nonce: nonce))
  }
  public func destroyedForVerification() -> Bool { key == nil }
  public func destroy() {
    if key != nil { key!.destroy() }
    key = nil
    nonces.destroy()
  }
}
