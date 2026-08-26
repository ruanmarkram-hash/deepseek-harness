# dsh-remote-host-keychain

English | [中文](README.zh.md)

`dsh-remote-host-keychain` is a macOS XPC helper for the DSH Host's protected remote identity. It owns the long-lived Ed25519 signing key and independent X25519 agreement key. Its signed XPC client may open public identity or request one exact X25519 agreement with a 32-byte peer public key. JavaScript never receives a private-key value.

The helper validates its enclosing signed XPC bundle, strict code signature, and fixed identifier before it reads an authorization resource or touches Keychain. It stores one binary property-list identity per requested Host profile in the login Keychain with a `SecAccess` trusted-application ACL created from the helper's signed executable. The Keychain therefore recognizes the helper's designated code requirement, not the shared `/usr/bin/security` program. A malformed row, changed designated requirement, changed signed resource, invalid signature, or invalid CryptoKit key fails closed without rekeying.

The service also reads a signed bundle resource containing its one authorized Host-client designated requirement, identifier, and build version. It derives the enclosing Host app and executable from its canonical `Contents/XPCServices/DSHRemoteHostKeychain.xpc` location, so moving the complete signed app does not invalidate authorization and no build-machine path is persisted. It then checks the live peer's exact derived process path, strict code requirement, identifier, and bundle version. macOS rejects every other XPC peer before the service sees a request. The Host client must set the service's designated requirement on its own `NSXPCConnection` before activation, so a separately registered service cannot impersonate the bundled helper. The executable has no standard-input protocol and does not perform signing or agreement when run directly, so it is not a same-user signing oracle.

The same sealed service is the per-route V3 epoch coordinator. A signed Host connection can acquire one route lease and enter a short Keychain read-modify-write interval. Both are held by the authenticated XPC connection, never by a filesystem pathname or an exported token. A lease is released on explicit close or XPC invalidation, so a crashed Host cannot strand epoch ownership. Revocation may enter the short interval while another Host owns a connection lease, allowing it to persist the revocation fence that makes that owner fail its next admission check.

CryptoKit does not expose Ed25519 or X25519 private keys as non-exportable `SecKey` objects on macOS. The helper stores their raw representations only inside the Keychain row, loads them only in its short-lived signed process, and performs the requested cryptographic operation before exit. The source wipes mutable copies that it owns after use; CryptoKit's internal key representation is released on process exit.

## Assemble a signed XPC service

```sh
native/remote-host-keychain/scripts/assemble-xpc-service.sh \\
  --signing-identity "Apple Development: Name (TEAMID)" \\
  --authorized-client /absolute/path/to/signed-dsh-host-client \\
  --output /absolute/path/to/DSHRemoteHostKeychain.xpc
```

The assembly script requires an explicit non-ad-hoc Apple Development signing identity. It resolves the selected certificate's Team ID, then verifies that the supplied Host client and every signed output have that Team ID, an Apple anchor, and the selected certificate constraint in their designated requirements. Only then does it read the client's exact designated requirement, seal it in the service bundle, sign the bundle with hardened runtime, and verify its signature. `assemble-host-owner.sh` is the only supported deployment path: it embeds the completed service in that exact Host bundle location.

## XPC methods

The sealed Host can call `openHostPublicIdentity`, which creates or opens the fixed Host profile and returns its public identity. It can also call `deriveHostSharedSecret(withPeerPublicKey:)` with exactly one canonical raw 32-byte X25519 peer key. The helper derives the secret before replying with its exact 32 bytes; malformed keys, invalid points, and all-zero results return no secret. The only other calls are fixed epoch lease and transaction admission for a validated route identifier. There is no JSON operation envelope, request identifier, signing method, arbitrary profile selector, generic derive API, Keychain read API, or route-token API.

This source tree does not compose the helper into the Web Host or install any standalone service. Current `dsh web` source execution is unsigned and cannot satisfy the service's client requirement. The signed Host sets the sealed service requirement on every XPC connection and uses the returned secret immediately for native KDF work.
