# Agent Note: Foreground mobile pairing transport

Status: implemented

English | [中文](2026-08-20-mobile-foreground-pairing-transport.zh.md)

## Problem

The mobile companion needs a live continuation of one DSH desktop session without becoming another authority for local execution, operating-system permissions, credentials, files, or workspace changes. A visual shell or direct phone-to-desktop route cannot establish that limited authority safely.

## Decision

`apps/mobile/transport.ts` owns a memory-only pairing attempt. It parses one pasted version-two bootstrap, accepts only the compiled Cloudflare relay origin, creates a fresh X25519 mobile key and opaque device id from Expo Crypto's native CSPRNG, and opens the role-bound `dsh-pairing-v2` WebSocket. It sends `mobile-init`, verifies the desktop proof in `desktop-accept`, then creates the directional encrypted session envelope. The app accepts only the shared protocol's desktop-to-mobile session vocabulary and sends only text submission vocabulary in this foreground release.

`apps/mobile/App.tsx` makes desktop acceptance, connection state, selected-session availability, prompt approval, and disconnected states explicit. It has no sample conversations or local paired preview. A background transition, expiry, socket ending, relay rejection, malformed traffic, or user disconnection closes the transport and clears its UI session.

`MOBILE_RELAY_V2_DEPLOYED` is true because the fixed production relay has completed its version-two cutover and its health check succeeds. The transport may open the fixed-origin socket for a valid, fresh desktop bootstrap, but the UI still shows no remote session as live until the desktop cryptographically accepts the phone.

## Data lifetime and authority

The raw QR field is cleared after parsing. The bootstrap, mobile relay bearer, ephemeral secret, confirmation, and session cipher remain in process memory only. Every terminal path closes the socket, zeros key material through the shared protocol, revokes the cipher, and drops the bootstrap reference. The app does not restore, reconnect, or persist a pairing.

The desktop selects the single session and explicitly approves every mobile text submission request. Mobile receives only safe text session snapshots, deltas, turn state, and safe errors. It has no path to computer use, tool approval, files, credentials, workspace or settings changes, attachments, arbitrary session creation, cancellation, camera access, or a generic desktop API. Cancellation is absent because a session-wide cancellation request has no trustworthy local DSH run identity and could cancel an unrelated desktop turn. It returns only with a real run-identity design.

## Alternatives considered

**Keep a disconnected preview.** A labelled preview helps early interface work but cannot validate acceptance, session freshness, replay protection, or prompt authority. The live app uses truthful empty and waiting states instead.

**Connect directly to the desktop.** Direct reachability creates an additional authentication, network exposure, and credential-lifetime system. The short-lived relay remains the only rendezvous.

**Persist the QR credential or session cipher.** Persistence would turn a foreground companion into a durable mobile authority and make stale session data look resumable. Re-pairing after every terminal transition keeps desktop ownership clear.

**Keep session-wide cancellation.** The local DSH session lacks a trustworthy run identity, so a cancellation could target an unrelated desktop turn. The foreground release removes it instead of guessing; a later run-identity design can add it back safely.

**Add camera scanning.** Camera permission adds a device capability without changing the pairing protocol. Manual paste remains sufficient until camera work has its own bounded decision and review.

## Consequences

The phone can continue a selected text session only while foregrounded and while its desktop stays connected. This costs reconnect convenience and leaves the user to re-pair after backgrounding, but it removes silent credential retention and fails closed on uncertain transport state. The official DeepSeek mark appears on mobile icon surfaces while the user-facing product remains DSH.
