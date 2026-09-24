---
description: "Use protected native Host signing and agreement identities without exposing private keys."
kind: "package-reference"
---

# dsh-remote-host-identity

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-remote-host-identity` defines the Host facade for a long-lived Ed25519 signing identity and an independent X25519 agreement identity. A signed native provider owns private keys; JavaScript receives only a protected handle, never private key bytes, a `$DSH_HOME` record, device-directory entry, or log value.

## Table of Contents

- [Surface](#surface)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="surface"></a>

## Surface

No runtime invariant companion is published because private Keychain state is not independently observable outside the identity provider.

When a signed native Keychain provider composes it, `ctx.remoteHostIdentity` returns public Host metadata, signs an already transcript-bound payload, and derives a shared secret from one validated X25519 remote public key. Callers must feed the returned secret directly to their KDF and must not persist or log it.

`ctx.remoteEnrollment.issueRoute()` mints a five-minute route id plus distinct Host and client relay tokens for a future local QR exchange. It keeps at most 32 exact routes only in process memory until expiry or one `confirm()` call consumes one and passes a copied locally confirmed remote public identity to `ctx.remoteDevices.enroll()`. Route tokens are not written anywhere by this package, and this package creates no HTTP endpoint, QR screen, relay request, or remote enrollment listener.

The package ships no Keychain implementation and the Web Host does not mount it. A future signed provider must create and use protected keys under its own restrictive macOS access policy, fail closed on missing or corrupt state, and expose only the protected handle.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- **Host Devices UI and QR exchange** — a local UI must display and transfer the ephemeral enrollment route before a phone can be confirmed; this package exposes only the Host-local controller API.
- **Signed native Keychain provider** — the shipped Web Host does not mount this package. A signed helper with a restrictive application access policy is required before any Host can own remote connections.
- **Authenticated relay and encryption runtime** — the controller mints relay-ready values but does not transmit them. The remote connection runtime owns mutual authentication, KDF use, ciphertext transport, reconnect, and revocation enforcement.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
