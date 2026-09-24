# Agent Note: The signed Host retains one FD199 lifecycle and opens the relay only after activation

Status: implemented

English | [中文](2026-08-24-host-owned-relay-activation.zh.md)

## Problem

A correctly packaged hosted child still must not open a public relay socket merely because the Host launched. Pairing, configured-runtime ownership, route activation, restart recovery, and revocation need one retained native owner with explicit user control.

## Decision

`DSHHost.app` retains one `HostedRuntimeController` for its application lifetime. **Start hosted runtime** validates the complete signed installation, starts or recovers the FD199 configured Web owner, and leaves the relay closed. **Activate paired phone** consumes the signed FD199 activation, reconciles the native-confirmed public enrollment seed and receipt, and only then starts one authenticated V3 route socket owned by `HostedRelaySession`.

Internet pairing is also Host-owned. **Pair iPhone from anywhere…** creates a short-lived public code, retrieves one public phone offer, displays the complete fingerprint, and requires local Host approval. The resulting invitation is encrypted to that phone identity. The relay never receives the Host-only route credential or plaintext invitation. Local offer import remains available, and **Copy fresh iPhone invitation** reissues only the phone-safe invitation for the active route.

The activated relay bridge forwards only authenticated connection records and direct application JSON bytes over descriptor 198. Device, route, epoch, private-key, and credential state stay native-owned. Stopping or quitting detaches the bridge, cancels receive and write tasks, closes and zeroizes transport state, and stops the child. Restarting **Start hosted runtime** recovers an already active journal and route only after the same sealed installation and credential checks pass.

**Revoke paired phone…** records durable cleanup intent, revokes the public route, retires any child copy, stops the relay and hosted child, and removes native credentials only after idempotent cleanup succeeds. Ambiguous remote cleanup remains fail-closed. Phone-side **Forget invitation** is intentionally separate and cannot revoke the Host route.

## Verification

Focused Swift tests cover inert start, one retained controller, exact seed and receipt reconciliation, two-generation FD199 activation, direct frame preservation, FIFO child output, restart recovery, route and epoch ownership, ambiguous cleanup, revoke fencing, and teardown. Relay and mobile tests cover short-lived internet pairing, encrypted invitation transfer, explicit connect and reconnect, revocation denial, and local forget. Distribution acceptance remains the notarized-Host and different-network TestFlight matrix.

## Alternatives considered

**Open the relay during Host startup.** Rejected because starting the local Web owner must not imply public network activation.

**Let the hosted child own the route credential.** Rejected because JavaScript would then control the credential and enrollment lifetime that authenticate the signed Host.

**Treat phone forget as revocation.** Rejected because local deletion cannot prove that durable Host and relay authorization was removed.

## Consequences

Start, activation, restart, revoke, and forget have distinct observable meanings. A Host may serve browser sessions while the phone relay remains off. Activation fails closed without a confirmed active route, valid signed journal, exact public enrollment receipt, and authenticated relay handshake. A production claim requires the packaged candidate to pass relocation before its one final notarization and the processed TestFlight build to pass the full physical-device matrix.
