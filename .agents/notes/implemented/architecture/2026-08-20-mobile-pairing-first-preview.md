# Agent Note: Pairing-first mobile preview

Status: implemented

English | [中文](2026-08-20-mobile-pairing-first-preview.zh.md)

## Problem

The mobile shell needed to make the accountless desktop-pairing model understandable before camera capture, encrypted transport, and desktop approval plumbing exist. A generic disconnected settings row would either hide the security model or encourage an accidental claim that a pasted pairing code connects a phone.

## Decision

`apps/mobile/App.tsx` accepts a manually pasted desktop bootstrap through `@deepseek-ai/dsh-pairing-protocol`, clears the raw value after validation, and retains only a non-secret local summary for the preview. It maps expiry, version, capability, and malformed-code errors without echoing the payload or relay token.

The flow presents a local request review and an explicit wait that remains blocked until the desktop accepts. The only route past the wait is labelled as a visual paired-shell preview, which renders no remote session and does not alter the pairing state. The app contains no WebSocket, relay, cryptography, camera, credential, or computer-use code.

Mobile presentation fixes its permitted operations to session reading, live subscription, text input to an existing session, and turn cancellation. The app lists computer use, approvals, files, credentials, workspace and settings changes, attachments, and session creation as desktop-only.

## Alternatives considered

**A successful-pairing simulation.** Rejected because a local transition that appears to accept a phone would conceal the desktop confirmation requirement.

**A camera dependency before the transport exists.** Rejected because pasting exercises the same QR parser without expanding native permissions or the app supply chain.

**A general remote-control screen.** Rejected because mobile remains a constrained session client after pairing, not an authority over the desktop.

## Consequences

The pairing experience can be reviewed before relay integration while preserving the sensitive-code and desktop-only boundaries. The next mobile transport slice replaces the visual preview with secure local storage, platform cryptography, encrypted relay I/O, reconnect handling, and a desktop-confirmed connection state.
