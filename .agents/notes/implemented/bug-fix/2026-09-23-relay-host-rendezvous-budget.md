# Agent Note: Relay Host rendezvous budget

Status: implemented

English | [中文](2026-09-23-relay-host-rendezvous-budget.zh.md)

## Problem

The relay's unbound-socket timeout can close an authenticated Host while its owner waits for phone authentication. The native Host's independent rendezvous budget cannot protect a socket that the relay closes first.

## Decision

The [relay](../../../../apps/mobile-relay/README.md) permits an authenticated unbound Host to wait 125 seconds: the [native rendezvous](2026-09-23-host-paired-phone-rendezvous.md) budget plus five seconds of relay scheduling margin. Unbound devices retain their 30-second limit. After hello, an unbound Host uses the handshake's 30-second deadline instead of its earlier connection timestamp. Alarm scheduling, expiry and expired-owner eviction share this calculation. Handshake transitions reschedule the earliest alarm without extending the handshake's start time.

## Alternatives considered

**Increasing the shared timeout** also extends device idle admission and active cryptographic handshakes, neither of which needs human-authentication time.

**Changing only the alarm callback** leaves expired-owner eviction and scheduled alarm timestamps inconsistent. A shared calculation preserves the same bound across all three paths.

## Consequences

One authenticated Host can retain an idle socket longer. Credential verification, single-peer ownership, rotation, revocation, and epoch admission remain unchanged. Durable Object integration tests cover exact idle boundaries, early and late hello deadlines, alarm recomputation and superseded-owner fencing. Physical-phone verification remains a release check.
