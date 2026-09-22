# Agent Note: Mobile bootstrap retry and presence reuse

Status: implemented

English | [中文](2026-09-23-mobile-bootstrap-retry-and-presence.zh.md)

## Problem

An authenticated receipt advances the mobile client's expected next epoch before workspace bootstrap finishes. Using that mutable epoch to identify the connection deadline disables the timer during bootstrap. A silent Host can then leave the client connecting indefinitely, while a pairing sheet that does not observe connection state presents an apparently inactive Connect button. Reading protected identity data again after owner authentication also prompts unnecessarily.

## Decision

The deadline belongs to the exact connection attempt and configuration, not the next durable epoch. It remains active through device description, session listing and snapshot projection. Expiry retires the transport and send permission, aborts the attempt and rejects pending requests. Retry retains the receipt-confirmed next epoch. The pairing and connection sheets share connection progress, failure and retry presentation; per-client action serialization excludes duplicate taps before React renders the pending state.

Public identity lookup reuses only public projections of the currently authenticated native identity. Without that session it follows the unchanged protected Keychain loading path. Backgrounding, disconnect, timeout and stale authentication completion retain their existing clearing rules; no private bytes cross the native interface.

## Alternatives considered

**Extending the timeout** cannot fix a timer whose ownership check becomes false after receipt. **Rolling the epoch back** risks replay and contradicts authenticated finality.

**Caching the protected identity independently of user presence** avoids prompts by weakening the security lifetime. Reusing the existing authorized session only for public projection avoids the redundant read without extending that lifetime.

## Consequences

A silent Host bootstrap becomes a visible, retryable error rather than a permanently disabled action. A new native iOS build is required for the authenticated public projection; updating JavaScript alone does not ship that part. Existing Keychain service names, bundle identity, invitation state and enrollment remain unchanged.

## Verification

Deterministic encrypted-transcript tests stall each bootstrap stage after receipt, expire the original timer, assert the visible retry snapshot, reconnect at the exact next epoch, and reject effects from a late prior snapshot completion. Action tests exclude duplicate taps. Native presence tests verify that authorized public projection skips protected loading, clearing restores it, and late authentication cannot restore a cleared session. Physical Face ID and TestFlight verification remain release checks.
