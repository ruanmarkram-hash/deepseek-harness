# DSH mobile relay

English | [中文](README.zh.md)

`@deepseek-ai/dsh-mobile-relay` is the Cloudflare Workers and Durable Objects rendezvous for one short-lived, accountless DSH phone pairing. DSH stays on the desktop. The relay has no route to the DSH web server, SDK, computer-use permissions, credentials, filesystem, or general API.

## Runtime contract

The desktop creates `POST /v1/pairings/:pairingId` with its separate bearer credential and exact version-two JSON: desktop id, canonical 32-byte `desktopEphemeralPublicKey`, mobile relay credential, and expiry. The relay validates but does not retain the public key. It stores only salted one-way token verifiers, expiry, desktop routing id, mobile id and capability request, and frame sequence counters. It never stores raw credentials, encrypted proofs, or application ciphertext.

Desktop and mobile connect with the exact `dsh-pairing-v2` WebSocket subprotocol and role-bound token subprotocol. The desktop identifies with `desktop-hello`. The mobile then sends `mobile-init` containing its public key and opaque encrypted proof. The relay validates sizes, ids, capability names, and canonical encodings before forwarding that object unchanged to the live desktop. The desktop must verify the proof and explicitly approve before it sends an opaque `desktop-accept` proof. The relay forwards that acceptance unchanged to the mobile, then allows bounded opaque frames.

The Durable Object still checks a single desktop and mobile connection, peer direction, persisted contiguous sequences, 64 KiB frame ciphertext, 96 KiB messages, and 30 messages per second. It does not decrypt, log, persist, replay, transform, or queue proofs or frames. Desktop disconnect, desktop revoke, and expiry close every socket and delete pairing state. The phone must locally verify the desktop proof before it sends application frames.

## Verification and deployment

Run `pnpm --filter @deepseek-ai/dsh-mobile-relay run check` and `pnpm --filter @deepseek-ai/dsh-mobile-relay run test`. `pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy:dry-run` bundles without an API request. Deploying requires an authenticated Wrangler session or narrowly scoped Cloudflare token. Do not put Cloudflare, relay, QR, or desktop credentials in source, logs, or Wrangler variables.
