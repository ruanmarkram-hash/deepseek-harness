#!/usr/bin/env node
// Reproducible Noble V3 3DH reference fixture for the signed Host transport.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const require = createRequire(new URL('../../../packages/mobile/remote-relay-protocol/package.json', import.meta.url))
const { x25519 } = require('@noble/curves/ed25519.js')
const { hkdf } = require('@noble/hashes/hkdf.js')
const { sha256 } = require('@noble/hashes/sha2.js')
const { chacha20poly1305 } = require('@noble/ciphers/chacha.js')
const b64 = bytes => Buffer.from(bytes).toString('base64url')
const text = new TextEncoder()
const hostStatic = new Uint8Array(32).fill(7), deviceStatic = new Uint8Array(32).fill(3)
const hostEphemeral = new Uint8Array(32).fill(1), deviceEphemeral = new Uint8Array(32).fill(11)
const ids = { routeId: 'aaaaaaaaaaaaaaaa', generation: 1, connectionEpoch: 1, deviceId: 'dddddddddddddddd', hostId: 'hhhhhhhhhhhhhhhh', enrollment: 'eeeeeeeeeeeeeeee' }
const hello = { version: 3, type: 'hello', routeId: ids.routeId, generation: 1, connectionEpoch: 1, senderDeviceId: ids.deviceId, senderEnrollmentId: ids.enrollment, recipientDeviceId: ids.hostId, recipientEnrollmentId: ids.enrollment, ephemeralPublicKey: b64(x25519.getPublicKey(deviceEphemeral)), nonce: b64(new Uint8Array(12).fill(12)) }
const welcome = { version: 3, type: 'welcome', routeId: ids.routeId, generation: 1, connectionEpoch: 1, senderDeviceId: ids.hostId, senderEnrollmentId: ids.enrollment, recipientDeviceId: ids.deviceId, recipientEnrollmentId: ids.enrollment, ephemeralPublicKey: b64(x25519.getPublicKey(hostEphemeral)), nonce: b64(new Uint8Array(12).fill(2)) }
const context = text.encode(JSON.stringify(['dsh-remote', 3, hello.routeId, hello.generation, hello.connectionEpoch, hello.senderDeviceId, hello.senderEnrollmentId, hello.recipientDeviceId, hello.recipientEnrollmentId, hello.ephemeralPublicKey, hello.nonce, welcome.senderDeviceId, welcome.senderEnrollmentId, welcome.recipientDeviceId, welcome.recipientEnrollmentId, welcome.ephemeralPublicKey, welcome.nonce]))
const shared = (secret, pub) => x25519.getSharedSecret(secret, pub)
const material = new Uint8Array(128)
material.set(shared(hostStatic, x25519.getPublicKey(deviceStatic)), 0)
material.set(shared(hostEphemeral, x25519.getPublicKey(deviceStatic)), 32)
material.set(shared(hostStatic, x25519.getPublicKey(deviceEphemeral)), 64)
material.set(shared(hostEphemeral, x25519.getPublicKey(deviceEphemeral)), 96)
const keys = hkdf(sha256, material, context, text.encode('dsh-remote/v3/3dh'), 64)
const frame = (type, sender, recipient, nonce, key, label) => {
  const value = { version: 3, type, routeId: ids.routeId, generation: 1, connectionEpoch: 1, senderDeviceId: sender, senderEnrollmentId: ids.enrollment, recipientDeviceId: recipient, recipientEnrollmentId: ids.enrollment, nonce: b64(nonce), ciphertext: '' }
  const aad = text.encode(JSON.stringify([type, value.routeId, value.generation, value.connectionEpoch, value.senderDeviceId, value.senderEnrollmentId, value.recipientDeviceId, value.recipientEnrollmentId]))
  value.ciphertext = b64(chacha20poly1305(key, nonce, aad).encrypt(text.encode(label)))
  return value
}
const ready = frame('ready', ids.deviceId, ids.hostId, new Uint8Array(12).fill(13), keys.slice(0,32), 'dsh-remote/v3/ready')
const hostNonce = counter => Uint8Array.from([...new Uint8Array(4).fill(3), ...new Uint8Array(8).fill(0).map((_, index) => Number((BigInt(counter) >> BigInt((7-index)*8)) & 255n))])
const finish = frame('finish', ids.hostId, ids.deviceId, hostNonce(0), keys.slice(32), 'dsh-remote/v3/finish')
const ack = frame('ack', ids.deviceId, ids.hostId, new Uint8Array(12).fill(15), keys.slice(0,32), 'dsh-remote/v3/ack')
const commit = frame('commit', ids.hostId, ids.deviceId, hostNonce(1), keys.slice(32), 'dsh-remote/v3/commit')
writeFileSync(new URL('../Tests/RemoteHostRelayTests/fixtures/v3-3dh-noble.json', import.meta.url), JSON.stringify({ source: '@noble/curves + @noble/hashes + @noble/ciphers V3 protocol', hello, welcome, ready, finish, ack, commit, context: b64(context), clientToHost: b64(keys.slice(0,32)), hostToClient: b64(keys.slice(32)) }, null, 2) + '\n')
