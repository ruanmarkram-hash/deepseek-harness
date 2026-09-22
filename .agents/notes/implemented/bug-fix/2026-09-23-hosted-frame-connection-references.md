# Agent Note: Hosted frame connection references

Status: implemented

English | [中文](2026-09-23-hosted-frame-connection-references.zh.md)

## Problem

Authenticated connection-open facts and per-message connection references have different schemas. Reusing open metadata on ordinary frames makes the hosted child reject its first application message. Comparing child references against serialized open metadata also rejects legitimate responses and misses close notifications.

## Decision

The native frame pump derives a one-field connection reference from the exact eight-field open record. It retains the complete open record only at connection admission. Send and close metadata use the existing duplicate-key-rejecting JSON parser, exact field sets and the current opaque connection ID; close also requires an allowlisted gateway reason. Member ordering and equivalent JSON escapes do not affect identity. The [native Host](../../../../native/remote-host-app/README.md) never broadens the [child wire](../../../../packages/mobile/remote-host-v3/README.md) schemas.

## Alternatives considered

**Allowing complete open metadata on every child frame** weakens an already-correct wire parser and repeats unnecessary authority facts on ordinary messages.

**Comparing serialized references** rejects equivalent JSON encodings. Parsing strict metadata preserves identity matching without accepting extra or duplicate fields.

## Consequences

The first application request and response can pass after authentication without closing FD198. Malformed sends still fail closed, and stale or invalid closes cannot stop the current connection. No credential, invitation, native epoch, relay protocol or child executable changes are required.

## Verification

`swift test --filter hostedFramePump` covers full open metadata, strict references, duplicate and escaped keys, close reasons, stale-close fencing and stopped state. Its cross-language case emits actual Swift bridge bytes, runs the TypeScript inherited-wire provider and gateway in a bounded subprocess, and returns the real response record through the Swift bridge and frame pump. Temporary fixtures contain only synthetic public identities and a session-list request; the subprocess receives no inherited credentials. This assembled application exchange supplements native unit tests; physical-phone acceptance remains a release check.
