# Agent Note: Host paired-phone rendezvous

Status: implemented

English | [中文](2026-09-23-host-paired-phone-rendezvous.zh.md)

## Problem

The Host's first cryptographic deadline starts before the phone sends a frame. Device-owner authentication and the time between independent user actions can consume that deadline without any cryptographic exchange. A generic timeout does not distinguish an absent phone from a stalled handshake.

## Decision

Explicit activation retains its single native route owner and epoch reservation while awaiting the first frame for at most 120 seconds. Only after that exact frame arrives does the supervisor construct the cryptographic transport with its unchanged 10-second flight deadline. The transport's normal decoding, route, enrollment, epoch and handshake-order checks consume the buffered first frame once. Invalid input fails closed without retry. Deadline errors contain a fixed phase name, never route coordinates or secrets.

Stop cancels the pending read even before its continuation is installed. A completed rendezvous timer cannot close a later handshake. State and durable admission are rechecked after suspension, so late reads cannot construct a transport or finalize an epoch after Stop or revocation.

## Alternatives considered

**Increasing every handshake deadline** grants stalled cryptographic exchanges more time and still conflates human interaction with protocol progress.

**Unbounded initial waiting or automatic retries** retains resources indefinitely or hides failure. A separate bounded wait permits authentication while preserving explicit connection ownership and existing epoch recovery.

## Consequences

The native Host changes without a mobile wire change or replacement invitation. The two-minute wait retains one socket and an exclusive route lease; Stop releases them, and failed attempts retain the exact uncommitted pending epoch for retry. Redundant mobile authentication prompts remain a separate mobile concern.

## Verification

Focused supervisor tests complete a real encrypted hello-to-receipt transcript after 119 seconds, advance past the obsolete rendezvous timer, and verify each later flight still expires after 10 seconds. Other cases cover the initial timeout, malformed and revoked first frames, exclusive ownership, Stop with a noncooperative late read, and cancellation before continuation installation. Existing transport timeout-fence and application-I/O teardown tests pass alongside them. Signed-bundle and physical-phone verification remain separate release checks.
