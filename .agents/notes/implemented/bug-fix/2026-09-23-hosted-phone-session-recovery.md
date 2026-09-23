# Agent Note: Explicit recovery of ended hosted phone sessions

Status: implemented

English | [中文](2026-09-23-hosted-phone-session-recovery.zh.md)

## Problem

An established phone transport can end while the local Web child remains healthy. Retaining that terminal session blocks another activation, but simply clearing it would send a second one-shot enrollment seed into the same child and leave its old connection registered.

## Decision

The [hosted runtime lifecycle](../../../../native/remote-host-app/Sources/RemoteHostApp/HostedRuntimeLifecycle.swift) admits explicit activation when its retained phone session has a monotonic ended state. A single reservation covers waiting for the old session's cleanup, stopping its seeded child, starting a replacement child, and activating a fresh phone session. The production composition reuses the existing native credential, signed journal, and finalized epoch state. No background transport callback restarts the local Web runtime.

Session shutdown closes forwarding and joins both the receiver and outbound writer before replacement. EOF requests cleanup from a separate task because shutdown waits for the receiver itself. Concurrent stop callers join the same completed cleanup. Stop keeps the lifecycle reservation canceled until any late factory or startup returns and disposes its candidate; a replacement cannot overlap that cleanup.

## Alternatives considered

**Clear only the ended session.** This preserves the child but repeats its one-shot seed and retains the old child connection. A fresh child is required for the existing protocol.

**Automatically restart the child on transport failure.** This interrupts a healthy local Web session without an explicit user action. Transport termination only ends phone delivery; the next Activate owns recovery.

## Consequences

Recovery briefly interrupts local Web service when the user requests it. Active sessions still reject overlapping activation. Replacement failure leaves local startup available; it does not reset pairing credentials, the signed journal, or native epochs. There are no relay protocol or protected-key changes.

Focused Swift lifecycle regressions cover explicit recovery order, retained local ownership before retry, cleanup waiting, stale session completion, stop during replacement startup and session construction, and failed replacement restart. A suspended writer regression verifies frame-pump quiescence and queued-frame disposal. The existing Swift-to-TypeScript gateway test exercises unchanged application framing through the real gateway. Signed-app recovery and a reconnecting physical phone remain release smoke coverage; these unit tests do not establish that deployment evidence.
