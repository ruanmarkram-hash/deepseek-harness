# Agent Note: Desktop-owned mobile pairing bridge

Status: implemented

English | [中文](2026-08-20-desktop-owned-mobile-pairing-bridge.zh.md)

## Problem

The Cloudflare relay can create a short-lived rendezvous, but letting the rendered local DSH page create it would expose a relay credential path to untrusted web content. The desktop also needs a clear lifecycle before any phone is allowed to receive encrypted session frames.

## Decision

[`apps/desktop/src/mobile-pairing.ts`](../../../../apps/desktop/src/mobile-pairing.ts) is an Electron-main-process-only creator for one Cloudflare pairing. Its constructor accepts a build-owned HTTPS relay origin and no renderer-provided value. Each creation generates separate 32-byte base64url pairing and desktop ids plus separate desktop and mobile relay credentials, expires after four minutes, and posts the exact version-two creation body with the desktop credential in the authorization header.

The bridge returns the mobile credential only in the canonical `dsh-pairing:v2:` bootstrap with the desktop ephemeral public key, derived `wss:` relay URL, and fixed read, subscribe, and send capabilities. Its ordinary state snapshots omit both credentials and the bootstrap. The desktop connection accessor is main-process-only: it returns the desktop role credential and X25519 key only to the live transport, then erases the private key after directional frame keys are derived.

[`apps/desktop/src/mobile-live-transport.ts`](../../../../apps/desktop/src/mobile-live-transport.ts) owns one relay socket and one explicitly selected existing local session. It verifies `mobile-init`, asks for native desktop approval, sends `desktop-accept`, and uses the protocol package's ordered encrypted closed envelope. Its loopback adapter names only `session.list`, `session.history`, and text-only queued `session.prompt`; it has no caller-supplied URL, path, mode, attachment, raw event stream, or session id. The native picker retains real session ids only in Electron main and maps the chosen session to an opaque mobile handle. Every mobile prompt gets a separate native confirmation, defaulting to rejection. Mobile cancellation is intentionally unavailable because the local runtime offers only session-wide cancellation, without a trustworthy mobile turn identity or ownership boundary; an encrypted `cancel-turn` is rejected without touching local DSH.

The dedicated pairing window is sandboxed and has a narrow preload only for local session aliases, start, close, pairing-code display, and non-secret state. The normal DSH renderer has no pairing IPC. `src/mobile-relay-config.ts` compiles the one trusted public relay origin into the package, so Finder launches do not depend on a mutable process environment. Either socket/local failure, close, expiry, denial, or revocation erases connection material and closes the pairing rather than reconnecting in the background.

## Alternatives considered

**Create pairings from the local web renderer.** Rejected because the local page has no host credential authority and renderer-originated creation would weaken the Electron privilege boundary.

**Reuse one relay credential for both peers.** Rejected because role-separated credentials stop a QR recipient from impersonating the desktop at relay creation or connection.

**Add a general mobile DSH API tunnel.** Rejected because the pairing creator must not become a hidden session or computer-control transport. The live transport remains a closed text-only adapter.

## Consequences

The desktop can present the QR bootstrap after the relay acknowledges the exact expiry, while a network failure or malformed acknowledgment reveals no credential in its ordinary state or error text. A desktop disconnect now revokes relay authority and forces a future foreground pairing. The phone never receives a local DSH session id, tool result, filesystem path, credential, setting, workspace data, attachment, raw event, or computer-use authority. Snapshot polling deliberately does not report an active mobile turn because it cannot prove that a local turn belongs to a phone request, so the composer cannot remain locked after a completed local response. Cancellation can return only after the local runtime exposes a trustworthy per-turn identity and ownership boundary. This desktop transport awaits the matching deployed v2 relay; it must not be released against the current v1 deployment.
