# Agent Note: Automatic rearm of a hosted phone route

Status: implemented

English | [中文](2026-09-25-hosted-phone-automatic-rearm.zh.md)

## Problem

The phone closes its foreground-only relay transport when iOS backgrounds it. The Host formerly kept a terminal phone session without listening again. The phone's explicit retry then reached an unattended route and stopped at the Host handshake, despite a healthy local Web child and valid invitation.

## Decision

Once the Host explicitly activates the paired phone route, transport termination drains the socket receiver and writer, acknowledges `connection.closed` to the seeded child, and re-arms a wait on the same route. The child and local Web runtime remain in place when the child is healthy and the prior connection closed cleanly. The Host issues the next exact epoch through its existing ledger. The phone still initiates every connection explicitly with owner authentication; backgrounding never gives the Host authority to connect the phone by itself.

The [earlier recovery decision](2026-09-23-hosted-phone-session-recovery.md) remains the fallback for a dead or unsafe child. The Host replaces that child only after the ended transport has drained. A failed reconnect wait retries without discarding a reusable child. Host Stop and revocation disarm waiting; a clean Host restart still requires explicit route activation.

## Alternatives considered

**Replace the child on every phone disconnect.** This interrupts the local Web workspace after ordinary iOS backgrounding and needlessly repeats the one-shot enrollment seed in a new process.

**Reconnect the phone automatically.** A backgrounded phone cannot safely complete owner-presence authentication without a user action, so only the Host rendezvous is automatic.

## Consequences

Normal phone retries preserve the local Web session and the verified invitation. Closing the connection in the child before reopening prevents stale connection state from rejecting the new connection ID. A child that dies after the Host liveness check can still cause one failed phone attempt before replacement, so physical-device reconnection remains release evidence rather than an inferred result from unit tests.
