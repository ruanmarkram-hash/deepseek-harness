# Agent Note: Desktop-owned mobile pairing bridge

Status: implemented

English | [中文](2026-08-20-desktop-owned-mobile-pairing-bridge.zh.md)

## Problem

The Cloudflare relay can create a short-lived rendezvous, but letting the rendered local DSH page create it would expose a relay credential path to untrusted web content. The desktop also needs a clear lifecycle before any phone is allowed to receive encrypted session frames.

## Decision

[`apps/desktop/src/mobile-pairing.ts`](../../../../apps/desktop/src/mobile-pairing.ts) is an Electron-main-process-only creator for one Cloudflare pairing. Its constructor accepts a fixed HTTPS relay origin and no renderer-provided value. Each creation generates separate 32-byte base64url pairing and desktop ids plus separate desktop and mobile relay credentials, expires after four minutes, and posts the exact version-one creation body with the desktop credential in the authorization header.

The bridge retains only the desktop credential in memory. It returns the mobile credential only in the canonical `dsh-pairing:v1:` QR bootstrap with the derived `wss:` relay URL and fixed session read, subscribe, send-turn, and cancel-turn capability list. Its snapshots omit both credentials and the QR value. `idle`, `creating`, `ready`, and `failed` states reject concurrent creation and clear the retained desktop credential when closed.

The bridge opens no WebSocket and has no renderer IPC, session projection, DSH API proxy, tool approval, file, workspace, credential, settings, or computer-use behavior. It is a host-owned creation boundary only; key verification, end-to-end encryption, explicit desktop acceptance, and safe session operation adapters remain outside it.

## Alternatives considered

**Create pairings from the local web renderer.** Rejected because the local page has no host credential authority and renderer-originated creation would weaken the Electron privilege boundary.

**Reuse one relay credential for both peers.** Rejected because role-separated credentials stop a QR recipient from impersonating the desktop at relay creation or connection.

**Add a general mobile DSH API tunnel.** Rejected because the pairing creator must not become a hidden session or computer-control transport before the constrained mobile capability adapter exists.

## Consequences

The desktop can render a QR code after the relay acknowledges the exact expiry, while a network failure or malformed acknowledgment reveals no credential in its state or error text. A created relay room can still live until its short expiry after a local close because this bridge deliberately does not yet open the desktop WebSocket required to revoke it. Future host work must consume the retained desktop credential through the relay's role-bound WebSocket, ask for explicit local device approval, and bind audited encrypted payloads to the fixed mobile operation set.
