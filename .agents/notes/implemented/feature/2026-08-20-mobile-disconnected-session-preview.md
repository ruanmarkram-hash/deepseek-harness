# Agent Note: Mobile disconnected session preview

Status: implemented

English | [中文](2026-08-20-mobile-disconnected-session-preview.zh.md)

## Problem

The mobile client had only a gateway-address form, so it did not establish the session-first interaction that a DSH companion needs. Treating an address form as a connection flow would also imply that the app can authenticate a user, retrieve sessions, or hold desktop authority before a mobile gateway exists.

## Decision

`apps/mobile/App.tsx` renders a native, session-first local preview with a session browser, immersive conversation screen, composition area, and settings entry. Clearly labelled sample rows and messages demonstrate the information hierarchy but are never represented as synced session data. The conversation composer accepts an in-memory draft for layout and keyboard behaviour; its action opens pairing settings instead of sending a request.

Pairing settings report the disconnected state and explain that the authenticated mobile gateway is absent. The app does not collect a gateway address, QR code, account token, or credential, make a network call, retain a draft after the process closes, or claim that a desktop is paired. Computer use and macOS privacy permissions remain desktop-only.

## Alternatives considered

**Keep the gateway-address form.** It supplies a configuration field without session navigation and invites a user to expect a connection path that the product cannot safely provide.

**Show an empty session list only.** An empty state is truthful but does not let the product evaluate the full-screen conversation and composition experience before transport exists. Labelled local samples retain that clarity.

**Add a direct phone-to-desktop connection.** A direct path would create new authentication, reachability, session-policy, and credential-lifetime responsibilities. The authenticated gateway remains the owner of those responsibilities.

**Persist preview drafts or pairing input.** Persistence would make an unpaired local preview look like an account or connection state. The preview keeps only open-process UI state.

## Consequences

The mobile app can be evaluated as a session companion without silently performing network work or blurring desktop privileges. A future gateway can replace the labelled preview source with authenticated session state and bind composition to an approved transport, but it must preserve the explicit desktop-only computer-use boundary. The current sample content is intentionally non-durable and cannot resume work.
