# Agent Note: Cloudflare mobile pairing relay

Status: implemented

English | [中文](2026-08-20-cloudflare-mobile-pairing-relay.zh.md)

## Problem

The accountless mobile vocabulary needs a reachable rendezvous service, but DSH sessions, permissions, credentials, and computer-use authority must remain on the desktop. A relay that sees plaintext or survives desktop revocation would become a remote control plane.

## Decision

[`apps/mobile-relay/`](../../../../apps/mobile-relay/README.md) uses one Cloudflare Durable Object per public pairing id. The Worker filters paths and request structure before object dispatch. It uses a desktop-only credential for desktop admission and a separate QR mobile credential for phone admission, then stores only salted one-way verifiers, five-minute expiry, route identities, mobile capability request, and per-direction sequence counters. It stores no QR token or ciphertext.

WebSocket connections use Durable Object hibernation attachments for peer identity and rate-window state. The desktop identifies first, the mobile requests the fixed allowlist, and only an explicit desktop acceptance enables frame forwarding. The object validates shared relay envelopes, recipient direction, strict contiguous counters, message size, and rate limits without decrypting ciphertext. Desktop disconnect, desktop revocation, and expiry close every socket and erase the pairing state.

The public edge rejects over-4-KiB streamed creation bodies before room dispatch and applies a per-network creation limit. A dedicated allocator Durable Object supplies the global creation budget. A pairing permits one desktop and one mobile connection only, keeping the per-role message budget and socket scan bounded.

## Alternatives considered

**A general remote DSH API proxy.** Rejected because it would turn the relay into a second owner of local DSH authority and expose privileged routes beyond the phone session client.

**A relay-visible session protocol.** Rejected because plaintext session data, prompts, and results would make the relay a persistent data owner.

**Long-lived mobile bearer tokens.** Rejected because a short-lived QR rendezvous with desktop confirmation limits the effect of a captured bootstrap token.

## Consequences

The Worker needs no runtime secret or user account database, and idle sockets can hibernate without losing connection identity. A phone must re-pair after a desktop disconnect, revocation, or expiry. The desktop and Expo applications still own audited encryption, key verification, secure storage, and mapping the fixed mobile capabilities to safe DSH session operations.
