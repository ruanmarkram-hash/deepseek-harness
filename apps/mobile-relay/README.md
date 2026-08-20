# DSH mobile relay

English | [中文](README.zh.md)

`@deepseek-ai/dsh-mobile-relay` is the Cloudflare Workers and Durable Objects rendezvous for one short-lived, accountless DSH phone pairing. It never proxies the DSH web server or SDK: DSH remains loopback-only on the desktop, which explicitly accepts the phone before any encrypted frame can pass.

## Runtime contract

The desktop creates `POST /v1/pairings/:pairingId` with `Authorization: Bearer <desktopRelayToken>` and this exact JSON body: `{ "version": 1, "desktopDeviceId": "…", "mobileRelayToken": "…", "expiresAt": 123 }`. `pairingId` and `desktopDeviceId` are public opaque identifiers. The desktop credential is never placed in the QR bootstrap; its separate mobile credential is the bootstrap's `relayToken`. Neither credential enters URLs, logs, or durable storage. The relay generates a random salt, persists only one-way `SHA-256(salt + token)` verifiers, keeps expiry and routing metadata, and schedules an alarm at expiry.

Desktop and mobile connect through `GET /v1/pairings/:pairingId/connect` with `Upgrade: websocket`. Desktop uses `dsh-pairing-v1, dsh-desktop.<desktopRelayToken>`; the phone uses `dsh-pairing-v1, dsh-mobile.<mobileRelayToken>`. The response selects only `dsh-pairing-v1`; it never reflects either credential. A connection first sends one control object with `version: 1` and its `pairingId`.

- Desktop identifies with `{ "type": "desktop-hello", "desktopDeviceId": "…" }`.
- Mobile requests the protocol allowlist with `{ "type": "mobile-request", "mobileDeviceId": "…", "capabilities": ["session:read", "session:subscribe", "turn:send", "turn:cancel"] }`.
- The relay forwards that request to the live desktop. Only `{ "type": "desktop-accept", "mobileDeviceId": "…" }` starts forwarding. `{ "type": "desktop-revoke" }`, desktop disconnect, or expiry sends `pairing-revoked` and closes every socket.

After acceptance, clients send only `@deepseek-ai/dsh-pairing-protocol` relay frames. The Durable Object checks their exact versioned envelope, desktop/mobile direction, one-device identity, contiguous persisted sequence counter, 64 KiB ciphertext limit, and fixed 96 KiB message and 30-message-per-second connection limits. It forwards the unchanged ciphertext only to a connected recipient and never decrypts, logs, stores, parses, replays, or queues it.

The mobile capability list is fixed: `session:read`, `session:subscribe`, `turn:send`, and `turn:cancel`. The relay has no routes for filesystem access, credentials, settings, computer-use approvals, tool approvals, session creation, attachments, raw DSH events, or a general API tunnel.

The public creation route is deliberately constrained before pairing-room dispatch: a dedicated allocator Durable Object enforces at most 20 creation attempts per 10 seconds across every Cloudflare location, while a Cloudflare edge rate limit permits at most two per minute from one network address. The Worker rejects declared or streamed creation bodies above 4 KiB. Each pairing admits at most one desktop and one mobile WebSocket at a time, so the 30-message-per-second budget is per pairing role rather than an unbounded fan-out. These limits reduce anonymous Internet abuse; they do not turn the accountless relay into an identity service.

## Verification and deployment

Run `pnpm --filter @deepseek-ai/dsh-mobile-relay run check`, `pnpm --filter @deepseek-ai/dsh-mobile-relay run test`, and `pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy:dry-run`. The test suite uses Cloudflare's local Vitest pool to exercise creation, one-way storage, desktop approval, frame forwarding, sequence rejection, and revocation. The last command bundles and validates the Worker and Durable Object declaration without making a Cloudflare API request.

`pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy` requires an authenticated Wrangler session or a narrowly scoped Cloudflare API token that can edit the target Worker and Durable Object. It needs no runtime secret or account database. Do not put the Cloudflare token, relay token, or a desktop pairing bootstrap in this repository or a Wrangler `vars` block.

The Worker name is `dsh-mobile-relay` and its first Durable Object migration is `v1`. Deploy its configuration as source of truth. Later mobile and desktop work must supply audited end-to-end encryption, secure device-key storage, and session operation adapters; this relay does not create those cryptographic keys or interpret their payloads.
