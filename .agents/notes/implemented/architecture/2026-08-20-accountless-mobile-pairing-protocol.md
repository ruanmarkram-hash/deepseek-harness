# Agent Note: Accountless encrypted mobile pairing vocabulary

Status: implemented

English | [中文](2026-08-20-accountless-mobile-pairing-protocol.zh.md)

## Problem

The DSH desktop is the trusted owner of local sessions and privileged capabilities, while a phone needs an efficient remote session surface without a user account, a local-network assumption, or plaintext visibility at the relay. Ad-hoc QR strings and relay JSON would make expiry, capability admission, and replay behavior inconsistent between Electron, Expo, and the relay.

## Decision

`packages/mobile/pairing-protocol` supplies a version-one, platform-neutral parser for a desktop-issued, short-lived QR bootstrap and opaque encrypted relay frames. The QR has one canonical `dsh-pairing:v1:` base64url JSON form, expires within five minutes, identifies the rendezvous and desktop with public opaque ids, and carries a short-lived relay bearer token. The package validates the token format but never logs or persists it.

The relay is limited to transport-token and routing decisions. The Electron host remains the trust anchor: it creates the bootstrap, confirms the device, approves the fixed mobile capability allowlist, and owns revocation. The Expo client and Electron host supply audited platform cryptography and send opaque ciphertext through the relay. The shared package deliberately has no key generation, encryption, decryption, network I/O, or secret storage.

Relay envelopes use one version, distinct sender and recipient ids, a bounded opaque ciphertext field, and a contiguous sequence for each direction. Recipients reject duplicate, skipped, invalid, and exhausted sequences rather than silently reordering them. Version one permits only reading/subscribing to sessions and sending/cancelling existing turns; it excludes computer use, filesystem, credentials, workspace management, administration, and creating sessions.

## Alternatives considered

**Supabase-backed account identity.** Rejected because the product needs a separate, accountless device channel rather than another user database or shared product backend.

**Relay-visible session JSON.** Rejected because a relay that can inspect session content becomes a data owner and increases the exposure of prompts, outputs, and operational context.

**A general remote-control capability.** Rejected because the phone is a constrained session client. Desktop-only authority stays on the desktop even after encrypted pairing succeeds.

## Consequences

The Cloudflare Durable Object implementation can route and authenticate one short-lived pairing without becoming a plaintext store. It must validate only its own token and routing state, expire it promptly, and relay ciphertext without interpreting it. Electron and Expo now share exact version, parser, capability, and replay rules, but deployment must still supply audited cryptography, secure token storage, desktop confirmation, device revocation, reconnect recovery, and a real authenticated session gateway.
