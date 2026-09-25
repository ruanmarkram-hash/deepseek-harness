# Agent Note: The hosted configured runtime adopts FD199 for the shared one-Host service

Status: implemented

English | [中文](2026-08-22-hosted-configured-runtime-fd199.zh.md)

## Problem

The phone could authenticate to a native route but still lacked the configured `dsh web` models, sessions, approvals, and event stream used by the browser. A loopback API could not prove ownership, and running another session core would split the Host state.

## Decision

The signed Host launches the configured Web runtime with two inherited private socketpair descriptors: 198 carries authenticated V3 connections and 199 carries ownership authority. `apps/cli` accepts only the exact trailing `--private-relay-fd 198 --private-authority-fd 199` contract, validates both descriptors as sockets before boot effects, removes the suffix from application arguments, and mounts the FD199 and V3 overlay. Ordinary `dsh web` starts without either descriptor and keeps its existing composition.

Descriptor 199 uses bounded, length-prefixed strict JSON with direction-specific vocabularies and duplicate-key rejection. The child proves readiness, recovers the native journal, exports digest-verified session artifacts, drains and releases store ownership, exits, and allows a new child to consume one signed activation. The native authority owns the journal through no-follow relative filesystem operations, signs canonical export and activation proofs through the protected Host identity, and rejects tampered, replayed, symlinked, or out-of-order state.

`CurrentWebFd199Lifecycle` fences browser writes during ownership transition while leaving read-side event streams available. After the activated child consumes the signed journal, `RemoteHostV3Controller.startWithNative()` binds descriptor 198 to the same configured process, store, models, sessions, approvals, and events. The native Host retains route credentials and private-key operations; the child receives only public route and authenticated connection facts.

## Verification

Focused TypeScript and Swift suites cover exact launcher overlay parsing, socket validation, protocol bounds, duplicate-key refusal, journal compare-and-set and recovery, proof tamper rejection, store quiescence, child reaping, two-generation prepare and activate choreography, and deferred descriptor-198 attachment. The release cookbook additionally requires the relocated signed Host to create and prompt a browser session before notarization, then prove the same Host from a different-network TestFlight phone.

## Alternatives considered

**Use the loopback Web API as the takeover channel.** Rejected because loopback reachability does not authenticate the signed Host or confer store ownership.

**Run a separate fixed-session phone Host.** Rejected because it would split models, sessions, approvals, and storage from the browser Host.

**Copy session state between concurrent owners.** Rejected because concurrent writers and copied bytes cannot provide the single-owner durability guarantee.

## Consequences

Browser and phone share one configured Host after an explicit signed ownership transition. Export is bounded at 128 MiB total and 8 MiB per session artifact, and the first adapter does not export attachments. Same-store adoption avoids copying those omitted artifacts. The path depends on the signed native supervisor and cannot be activated by a source process that merely supplies its own socket descriptors.
