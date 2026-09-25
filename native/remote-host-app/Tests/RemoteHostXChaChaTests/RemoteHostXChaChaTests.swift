import Foundation
import Testing
@testable import RemoteHostXChaCha

private func fixture() throws -> [String: String] {
  let url = try #require(Bundle.module.url(forResource: "xchacha-v3-noble", withExtension: "json"))
  let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
  return try #require(value as? [String: String])
}

private func data(_ fixture: [String: String], _ field: String) throws -> Data {
  let hex = try #require(fixture[field])
  guard hex.count.isMultiple(of: 2) else { throw XChaChaError.invalidInput }
  var output = Data(capacity: hex.count / 2)
  var cursor = hex.startIndex
  while cursor < hex.endIndex {
    let next = hex.index(cursor, offsetBy: 2)
    guard let byte = UInt8(hex[cursor..<next], radix: 16) else { throw XChaChaError.invalidInput }
    output.append(byte)
    cursor = next
  }
  return output
}

@Test("XChaCha matches the checked-in Noble V3 fixture byte-for-byte")
func matchesNobleFixture() throws {
  let value = try fixture()
  let key = try XChaChaKey(data(value, "keyHex"))
  let nonce = try XChaChaNonce(data(value, "nonceHex"))
  let aad = try data(value, "aadHex")
  let plaintext = try data(value, "plaintextHex")
  let ciphertext = try data(value, "ciphertextHex")

  #expect(try XChaCha.seal(plaintext, aad: aad, key: key, nonce: nonce) == ciphertext)
  #expect(try XChaCha.open(ciphertext, aad: aad, key: key, nonce: nonce) == plaintext)
}

@Test("XChaCha rejects a modified ciphertext or authenticated data")
func rejectsTampering() throws {
  let value = try fixture()
  let key = try XChaChaKey(data(value, "keyHex"))
  let nonce = try XChaChaNonce(data(value, "nonceHex"))
  let aad = try data(value, "aadHex")
  let ciphertext = try data(value, "ciphertextHex")
  var alteredCiphertext = ciphertext
  alteredCiphertext[alteredCiphertext.startIndex] ^= 0x01
  var alteredAAD = aad
  alteredAAD[alteredAAD.startIndex] ^= 0x01

  #expect(throws: XChaChaError.self) { try XChaCha.open(alteredCiphertext, aad: aad, key: key, nonce: nonce) }
  #expect(throws: XChaChaError.self) { try XChaCha.open(ciphertext, aad: alteredAAD, key: key, nonce: nonce) }
}

@Test("XChaCha zeroize overwrites mutable caller-owned bytes")
func zeroizesCallerBuffer() {
  var secret = Data(repeating: 0xa5, count: 64)
  XChaCha.zeroize(&secret)
  #expect(secret == Data(repeating: 0, count: 64))
}

@Test("XChaChaKey owns a separate mutable copy and wipes that copy")
func ownsAndWipesKeyMaterial() throws {
  var caller = Data(repeating: 0x5a, count: 32)
  var key = try XChaChaKey(caller)
  caller[0] = 0x01
  #expect(key.bytes[0] == 0x5a)
  key.destroy()
  #expect(key.bytes == Data(repeating: 0, count: 32))
  #expect(caller[0] == 0x01)
}

@Test("The production sealer consumes one nonce per frame")
func consumesUniqueNonces() async throws {
  let value = try fixture()
  let key = try XChaChaKey(data(value, "keyHex"))
  let sealer = XChaChaFrameSealer(key: key, nonces: try XChaChaNonceSequence(prefix: Data(repeating: 0x42, count: 4)))
  let first = try await sealer.seal(Data([0x01]))
  let second = try await sealer.seal(Data([0x01]))

  #expect(first.nonce.encoded != second.nonce.encoded)
  #expect(try XChaCha.open(first.ciphertext, key: key, nonce: first.nonce) == Data([0x01]))
  #expect(try XChaCha.open(second.ciphertext, key: key, nonce: second.nonce) == Data([0x01]))
}

@Test("A nonce sequence fails closed after its final nonce")
func rejectsNonceSequenceExhaustion() throws {
  var sequence = try XChaChaNonceSequence(prefix: Data(repeating: 0, count: 4), initialCounter: .max)
  _ = try sequence.next()
  #expect(throws: XChaChaError.self) { try sequence.next() }
}
