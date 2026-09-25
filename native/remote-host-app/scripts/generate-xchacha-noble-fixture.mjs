#!/usr/bin/env node
// Re-generates the checked-in interoperability fixture with the exact Noble V3
// primitive used by packages/mobile/remote-relay-protocol. This is a developer
// verification aid, never called by a production Host process.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const relayRequire = createRequire(new URL('../../../packages/mobile/remote-relay-protocol/package.json', import.meta.url))
const relayPackage = relayRequire('./package.json')
if (relayPackage.dependencies?.['@noble/ciphers'] !== '2.2.0') {
  throw new Error('expected the V3 relay package to pin @noble/ciphers@2.2.0')
}
const noblePath = relayRequire.resolve('@noble/ciphers/chacha.js')
const { chacha20poly1305 } = await import(pathToFileURL(noblePath).href)

const hex = (value) => Buffer.from(value).toString('hex')
const key = Uint8Array.from({ length: 32 }, (_, index) => index)
const nonce = Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index)
const aad = new TextEncoder().encode('dsh-remote/v3/aad-vector')
const plaintext = new TextEncoder().encode('DSH V3 ChaCha cross-language fixture')
const ciphertext = chacha20poly1305(key, nonce, aad).encrypt(plaintext)

process.stdout.write(`${JSON.stringify({
  generator: '@noble/ciphers@2.2.0 chacha20poly1305(key, nonce, aad).encrypt(plaintext)',
  keyHex: hex(key),
  nonceHex: hex(nonce),
  aadHex: hex(aad),
  plaintextHex: hex(plaintext),
  ciphertextHex: hex(ciphertext),
}, null, 2)}\n`)
