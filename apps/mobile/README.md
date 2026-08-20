# DSH Mobile

English | [中文](README.zh.md)

`@deepseek-ai/dsh-mobile` is the foreground-only native Expo companion for one desktop-selected DSH session. It presents a session-first workspace and an immersive text conversation while DSH desktop retains execution, approvals, local permissions, files, credentials, workspace changes, attachments, settings, and session creation.

The version-two mobile transport uses the deployed version-two relay. A phone still does not show a connection as live until the desktop has cryptographically accepted its pairing request.

## Pairing and connection

The user pastes a short-lived version-two QR bootstrap created by DSH desktop. The app parses it in memory, immediately clears the raw text field, and accepts only the compiled DSH Cloudflare relay origin. It uses Expo Crypto's native CSPRNG to create an in-memory X25519 mobile key, connects through the exact `dsh-pairing-v2` WebSocket protocol with the mobile relay bearer in the role-bound subprotocol, never in a URL, sends `mobile-init`, and waits for a cryptographically verified `desktop-accept` before deriving the directional session cipher.

The app ends its connection on expiry, rejection, malformed traffic, socket failure, user disconnection, or any background transition. Ending a pairing closes the socket and erases the QR bootstrap, relay bearer, ephemeral key, and session cipher from memory. The phone does not reconnect or restore a prior pairing.

## Mobile scope

After desktop acceptance, the app decrypts only safe session snapshots, text deltas, turn state, and safe errors. It can encrypt only desktop-approved text submission requests for the desktop-selected session. This foreground release cannot cancel a turn because it has no trustworthy desktop run identity; cancellation returns only with a run-identity design. The UI never shows preview, cached, or disconnected content as live data.

Camera pairing and durable key or session storage are intentionally absent. The app uses the official DeepSeek mark from [`website/public/favicon.svg`](../../website/public/favicon.svg) for its app and in-product icon surfaces while retaining the separate DSH product name.
