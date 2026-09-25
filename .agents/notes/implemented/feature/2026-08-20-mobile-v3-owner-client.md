# Agent Note: Mobile V3 owner client

Status: implemented

English | [中文](2026-08-20-mobile-v3-owner-client.zh.md)

## Problem

The first phone client was a foreground V2 bridge to one Desktop-selected session. It could not own the same long-lived Host as the browser, create Host sessions, preserve authenticated reconnect state, or distinguish local forgetting from Host revocation.

## Decision

DSH Mobile is a V3 Host owner client. Its native module keeps independent Ed25519 signing and X25519 agreement identities in a user-presence, this-device-only iOS Keychain item. TypeScript receives public identity and an agreement operation, never private-key bytes. A custom native or TestFlight build is required because Expo Go lacks the module.

The app supports both physical local transfer and internet pairing. Internet pairing scans or accepts the short-lived `dsh3` code shown by the signed Host, sends the exact public phone offer to the fixed relay origin, keeps the fingerprint visible for Host approval, and decrypts the returned invitation only with the protected phone identity. The strict invitation binds the route, device credential, Host agreement pin, both enrollment incarnations, expected device keys, expiry, and exact next epoch. Camera permission is used only for the pairing code; manual code entry remains available.

One verified invitation, durable event cursor, and next epoch are stored in a non-rendered native Keychain record. Import opens no connection. An explicit user action opens the production V3 socket and reports connected state only after mutual authentication and the encrypted Host commit. The app lists and creates sessions, projects Host snapshots and ordered events, and sends text prompts without inventing local messages or persisting rendered conversation content.

An iOS `inactive` interruption, including the system presence prompt, preserves a pending in-memory presence session. Actual backgrounding, disconnect, malformed traffic, or replacement closes the physical socket and clears that session. Explicit retry is allowed only after the previous transport retires and uses the Host-issued exact next epoch. **Forget invitation** clears the local Keychain route, epoch, cursor, and projection; it does not revoke the Host route. Host revocation invalidates the route and requires a fresh pairing.

## Verification

Focused TypeScript tests cover strict invitation and pairing-code parsing, encrypted internet invitation transfer, temporary `inactive` interruption, actual background teardown, durable state serialization, exact-epoch reconnect, abort and socket retirement races, snapshot and replay cursor ordering, request dispatch, and forget behavior. Native Swift tests cover protected identity lifecycle and presence-session clearing. Production acceptance additionally requires the processed TestFlight build on a physical iPhone over a network different from the notarized Host.

## Alternatives considered

**Keep the V2 Desktop bridge.** Rejected because one Desktop-selected foreground session cannot implement the shared persistent Host owner model.

**Connect directly to a public Host HTTP endpoint.** Rejected because it would bypass relay role credentials, Host pinning, exact epochs, and encrypted remote wire.

**Call an X25519 Keychain key a Secure Enclave key.** Rejected because iOS exposes no Secure Enclave X25519 key class; the implementation makes the narrower accurate Keychain claim.

**Make forget revoke the Host.** Rejected because deletion of local phone state and durable Host authorization are distinct actions with different failure and recovery semantics.

## Consequences

The phone can pair by camera or code, reconnect explicitly, use the shared browser Host, and forget its local invitation. It remains foreground-only, contains no local fallback conversation, and does not provide macOS computer-use capture or control. Distribution claims require TestFlight availability and the complete different-network prompt, reconnect, restart, revoke, and forget matrix.
