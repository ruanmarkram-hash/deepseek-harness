# DSH mobile relay

English | [中文](README.zh.md)

`@deepseek-ai/dsh-mobile-relay` is the Cloudflare Workers and Durable Objects blind rendezvous for DSH phone pairing and encrypted remote transport. DSH stays on the Host. The relay has no route to the DSH Web server, SDK, computer-use permissions, credentials, filesystem, or general API.

## V3 route contract

The signed Host creates, rotates, and revokes one private route with a Host-only credential. The Durable Object stores salted one-way verifiers for the Host and device role credentials plus public route metadata, generation, expiry, and bounded handshake state. It never stores private keys, shared secrets, plaintext application messages, or a usable route credential.

Host and phone connect only to `/v3/routes/:routeId/connect` with `dsh-remote-v3` and a role-bound credential subprotocol. The relay validates the exact route, generation, epoch, role, direction, message vocabulary, size, and sequence before forwarding opaque handshake or ciphertext messages. It cannot complete the cryptographic handshake, decrypt a frame, claim peer delivery, or authorize a DSH operation. Rotation and revocation close both peers immediately and invalidate old credentials. A successful route DELETE returns `204`; a retry after route metadata is gone returns the `404` absent-route result used by durable Host revoke recovery.

## Internet pairing contract

`/v3/pairings/:pairingId` provides a separate short-lived QR or text-code rendezvous. It accepts one public phone enrollment offer, exposes it only to the code-bearing Host, and returns only an invitation encrypted by the Host to that phone's protected identity. The pairing object stores a verifier for the code and bounded public or encrypted transfer values; it is not a route relay and never receives the active Host route credential. Offer, approval, retrieval, acknowledgement, expiry, and replay all fail closed.

## V2 compatibility

The isolated `/v1` surface retains the version-two desktop pairing contract. Desktop and mobile use the exact `dsh-pairing-v2` WebSocket subprotocol and role-bound credentials. The relay forwards `mobile-init`, `desktop-accept`, and bounded opaque frames without decrypting, logging, persisting, replaying, or transforming proofs or application ciphertext. Desktop disconnect, revoke, or expiry closes sockets and deletes pairing state.

## Verification and deployment

Run `pnpm --filter @deepseek-ai/dsh-mobile-relay run check`, `pnpm --filter @deepseek-ai/dsh-mobile-relay run test`, and `pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy:dry-run`. Deploying requires an authenticated Wrangler session or narrowly scoped Cloudflare token. The checked-in production custom-domain route contains no secret. Never put Cloudflare, relay, pairing, Host, or device credentials in source, logs, URLs, or Wrangler variables.

The production deployment order and physical-device acceptance matrix are in the [remote-pairing release cookbook](../../docs/cookbook/releasing-dsh-remote-pairing.md).
