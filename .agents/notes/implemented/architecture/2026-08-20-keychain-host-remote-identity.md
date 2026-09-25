# Agent Note: Keychain Host remote identity

Status: implemented

English | [中文](2026-08-20-keychain-host-remote-identity.zh.md)

## Problem

The persistent DSH Host needs signing and agreement keys that survive browser and Desktop lifecycles without placing private remote identity beside sessions, public device metadata, relay credentials, or JavaScript.

## Decision

`native/remote-host-keychain` is a sealed XPC service inside `DSHHost.app`. It owns independent Ed25519 signing and X25519 agreement private keys in the login Keychain and exposes only typed public-identity, signing, exact 32-byte agreement, and route-epoch coordination calls. Private key bytes never leave the helper, and the API has no generic operation, arbitrary profile, Keychain read, or route-token surface.

The helper derives its enclosing Host app and executable from its fixed `Contents/XPCServices/DSHRemoteHostKeychain.xpc` location. Its signed authorization resource contains the Host identifier, version, and designated requirement, but no build-machine path. The helper validates its complete signed bundle, exact canonical nesting, derived Host path, live peer path, metadata, and strict code requirement before accepting a connection. The Host reciprocally pins the helper's sealed service requirement. Moving the complete signed app between supported canonical installation locations therefore preserves authorization, while a symlink, changed resource, substituted binary, invalid signature, or different peer fails closed.

The signed Host uses the helper for its public Host identity, immediate native KDF work, Keychain-bound FD199 proofs, and crash-reclaimable route epoch leases and transactions. JavaScript receives only public enrollment and authenticated connection facts through the inherited bounded Remote Wire descriptors. Ordinary source-launched `dsh web` is not an authorized XPC peer.

## Verification

Focused Swift tests cover identity creation races, public-key separation, X25519 agreement, corrupt-row refusal, exact relocation derivation, canonical nesting, symlink rejection, epoch lease recovery, and revocation fences. Assembly and private-runtime smoke checks reject path-bearing authorization resources, validate reciprocal designated requirements and the complete app seal, relocate the assembled app before launch, and reject unauthorized peers and tampered signed resources.

## Alternatives considered

**Store private Host keys in the DSH storage domain.** Rejected because the ordinary Host store contains product data and public device facts, not macOS protected identity material.

**Use one key for signing and agreement.** Rejected because Ed25519 authentication and X25519 agreement have different purposes and key types.

**Use a command-line helper or Electron client.** Rejected because a same-user caller could turn a CLI into an oracle, and Electron does not own the durable Host lifecycle.

**Seal absolute build paths into authorization.** Rejected because a valid release must survive relocation as one complete signed app without trusting its build directory.

## Consequences

The protected identity and epoch authority remain available only through the strictly validated signed Host/XPC pair. Release packaging must keep the helper at its fixed nested location, preserve the whole-app seal, and pass relocation smoke before notarization. The logged-in owner may replace a user-owned `~/Applications` installation, so the security claim is signed-code isolation from other processes, not protection from the owning account.
