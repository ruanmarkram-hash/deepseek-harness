# dsh-pairing-protocol

English | [中文](README.zh.md)

`@deepseek-ai/dsh-pairing-protocol` is the version-two accountless pairing, key-confirmation, and foreground-only encrypted session-envelope library shared by the Electron desktop, Expo phone, and Cloudflare relay. It supplies protocol primitives, not a live application connection.

## Surface

The desktop creates a fresh X25519 pair and puts only its canonical 32-byte base64url public key in the short-lived `dsh-pairing:v2:` QR bootstrap. The QR also contains the public pairing and desktop ids, fixed mobile capability set, `wss:` relay URL, expiry, and the mobile-only relay credential. The desktop relay credential and every ephemeral secret stay outside the QR.

The phone creates its own X25519 pair through an injected `PairingRandomSource`, then sends an exact `mobile-init` control with its public key, allowed requested capabilities, and a bounded nonce-prefixed XChaCha20-Poly1305 proof. The proof key is HKDF-SHA-256 over X25519 shared secret and a transcript binding the protocol version, pairing id, both device ids, both public keys, and capabilities. The desktop verifies that proof before explicit approval, then sends a similarly bound `desktop-accept` proof. The phone verifies it before opening its local application-frame gate.

After local proof verification, `createMobileSessionCipher()` derives separate in-memory XChaCha20-Poly1305 keys for desktop-to-mobile and mobile-to-desktop envelopes. Each envelope authenticates the immutable relay routing fields, admits only the next contiguous sequence in its direction, and erases both directional keys when closed. The plaintext grammar is closed and text-only: desktop-to-mobile permits `session-snapshot`, `text-delta`, `turn-state`, and `error`; mobile-to-desktop permits only `send-text` and `cancel-turn`. Snapshot counts and every text field are bounded before encryption or after decryption.

The relay validates field bounds and forwards controls and opaque frames unchanged. It cannot decrypt either proof or a frame. A desktop acceptance is required before it forwards frames, while clients must verify the corresponding proof and call `confirmPairingKey().requireConfirmed()` before creating or opening a session cipher. This is a foreground-only transport foundation: active secrets, directional keys, and sequence state stay only in process memory. Call `destroyPairingEphemeralKeyPair()` and erase the cipher, which revokes the confirmation, on close, expiry, or desktop revocation.

The only mobile capabilities are `session:read`, `session:subscribe`, `turn:send`, and `turn:cancel`. This package has no computer-use, filesystem, credentials, workspace, administration, session creation, attachment, or arbitrary-session capability.

## Limitations

The package has no WebSocket client, secure-storage provider, user-approval UI, live desktop or mobile app wiring, or DSH session gateway. It does not select a session, send a turn to DSH, receive a live DSH stream, reconnect in the background, or expose a general DSH API. Desktop and mobile integrations must supply platform CSPRNG adapters, retain active secrets only in memory, verify proofs before application traffic, and map the fixed allowlist to safe operations for one desktop-selected session. The relay never becomes a general DSH API proxy.
