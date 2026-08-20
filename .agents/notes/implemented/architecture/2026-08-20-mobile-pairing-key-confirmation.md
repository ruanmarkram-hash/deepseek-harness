# Agent Note: Mobile pairing key confirmation

Status: implemented

English | [中文](2026-08-20-mobile-pairing-key-confirmation.zh.md)

## Problem

The accountless pairing rendezvous needs a way for the desktop and phone to prove they derived the same fresh secret before a relay permits session traffic. A QR relay credential alone proves only access to the rendezvous, not the intended desktop key or peer.

## Decision

[dsh-pairing-protocol](../../../../packages/mobile/pairing-protocol/README.md) uses version-two ephemeral X25519 key confirmation. The desktop QR binds a canonical 32-byte public key. The phone sends a fresh public key and XChaCha20-Poly1305 mobile-init proof. HKDF-SHA-256 derives each proof key from X25519 shared secret and a transcript that binds identities, public keys, version, pairing id, and requested capabilities. The desktop verifies that proof before explicit approval, then returns a desktop-accept proof. The phone verifies that proof before opening a revocable local application-frame gate.

After local confirmation, the package derives direction-separated XChaCha20-Poly1305 session-envelope keys from the same bound transcript. Each frame authenticates its relay routing fields and must have the next contiguous sequence in that direction. Its closed plaintext grammar is text-only: desktop-to-mobile carries snapshots, text deltas, turn states, and safe errors; mobile-to-desktop carries only text submission and turn cancellation. Active private keys, directional keys, and sequence state remain in memory for the foreground pairing only. `destroyPairingEphemeralKeyPair()` and `MobileSessionCipher.erase()` clear secrets and revoke local confirmation on close, expiry, or revocation.

Randomness is injected by each platform. The shared module has no default random provider, network client, secret storage, live app wiring, or authority to approve a phone. It does not select a DSH session, connect a live desktop or phone session, or authorize a general DSH API.

The Cloudflare relay validates exact control fields and proof bounds but forwards both proofs as opaque values. It never stores either proof, plaintext, raw token, or application ciphertext. It permits frames only after desktop-accept, while each endpoint remains responsible for local proof verification. This partially supersedes the external-cryptography deferral in [accountless mobile pairing vocabulary](2026-08-20-accountless-mobile-pairing-protocol.md); accountless ownership, fixed capabilities, and opaque relay routing remain unchanged.

## Alternatives considered

**Platform WebCrypto only.** Rejected because Electron and Expo need identical, reviewable behavior without divergent subtle-crypto adapters or platform key-format differences.

**A relay-verified proof.** Rejected because it would require the relay to possess or derive pairing secrets and would turn the rendezvous into a security authority.

**Acceptance without a return proof.** Rejected because the phone would have no cryptographic confirmation that the accepting peer possesses the QR-bound desktop key.

## Consequences

The protocol adds three pinned pure-JavaScript dependencies: Noble curves, hashes, and ciphers. Deterministic vectors pin the key, transcript, nonce, ciphertext, tamper rejection, gate revocation, secret erasure, directional encryption, routing authentication, replay rejection, and closed-message behavior. Desktop and mobile integrations must still wire the verified foreground-only envelopes to a safe adapter for one desktop-selected DSH session; this note does not authorize computer use, filesystem access, credentials, workspace access, session creation, attachments, arbitrary-session access, or a general remote DSH API.
