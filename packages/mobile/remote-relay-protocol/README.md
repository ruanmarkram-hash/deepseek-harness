---
description: "Authenticate paired peers and encrypt ordered relay frames with caller-owned sockets."
kind: "package-library"
---

# dsh-remote-relay-protocol

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-remote-relay-protocol` authenticates one enrolled remote device and one DSH Host across a blind V3 WebSocket relay. It exposes no relay deployment, device enrollment endpoint, Host API dispatcher, persistent key store, or UI.

## Table of Contents

- [Surface](#surface)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="surface"></a>

## Surface

No runtime invariant companion is published because the caller-owned transport and cipher expose no independently observable Cordis service relationship.

Before opening a connection, the Host and device already know each other's enrolled static X25519 public agreement key and Host-minted immutable identity incarnation. A device incarnation changes on re-enrollment; the Host incarnation identifies its current protected identity, not a device enrollment. Each supplies `RemoteRelayIdentity.agreement`, a protected provider with a public key and `deriveSharedSecret(peerPublicKey)` callback. The callback returns a fresh shared-secret copy for immediate KDF consumption and never exposes a private key. Every handshake and encrypted frame authenticates both device ids and identity incarnations, so a revoked or re-enrolled identity cannot attach through a stale connection. `connectRemoteRelayDevice()` sends a device ephemeral key and nonce; `acceptRemoteRelayDevice()` answers with a Host ephemeral key and nonce. Both sides derive directional keys from static-static, static-ephemeral, ephemeral-static, and ephemeral-ephemeral X25519 values. The encrypted `ready`, Host `finish`, device `ack`, Host `commit`, device `confirm`, and Host `receipt` flights prove finality: the Host invokes its required durable epoch finalizer only after authenticating `confirm`, and the device becomes live only after authenticating the post-finalization `receipt`. Every encrypted flight binds route id, generation, epoch, device ids, and enrollment ids as AEAD associated data. Ephemeral secrets are erased after derivation, so later static-key compromise does not recover a recorded connection.

An accepted connection only encrypts and decrypts exact `@deepseek-ai/dsh-remote-wire` envelopes. Every ciphertext binds its route id, generation, connection epoch, sender, recipient, and exact next sequence as authenticated data. Incoming ciphertext must be the next contiguous sequence; old, skipped, malformed, altered, or wrong-epoch messages fail closed. The relay can validate and route the same outer message without access to an application envelope or its ciphertext plaintext.

Callers provide a cryptographic random source and a small `RemoteRelaySocket` adapter. This keeps the protocol portable across the Host runtime, browser-compatible mobile runtime, React Native, and a native transport. The random source must return fresh caller-owned buffers: this package copies and then zeroes every returned `Uint8Array`, including an invalid-length result. `connectRemoteRelayDevice()` and `acceptRemoteRelayDevice()` accept an optional `signal`; it cancels every pending handshake flight, closes the socket, and clears derived key material. The caller must retain the raw socket close handle until the connection resolves. `acceptRemoteRelayDevice()` requires an idempotent Host epoch finalizer; it must durably record the authenticated epoch before the function emits `receipt`. A new route starts at epoch 1. The Host epoch provider returns the exact pending epoch until finalization succeeds, then exactly one higher; a device may accept only those two values to recover a receipt interrupted after finalization. `send(envelope, fence)` serializes close and write: it reports `committed-before-fence` only when the local WebSocket accepted the bytes after its final active-fence check. It never claims peer delivery, and an ambiguous write closes the connection and reports `not-committed`. Private identity material belongs in the platform's protected store; this package copies it only long enough to calculate a shared secret and never serializes it.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- This package does not mint or rotate route capabilities, open a WebSocket, persist an identity, decide enrollment, or dispatch decrypted DSH API operations. The Host-owned connection provider supplies those effects and rechecks device revocation before yielding a connection.
- It deliberately does not include computer-use video or control messages. A future native macOS helper needs its own explicit capability and privacy model.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
