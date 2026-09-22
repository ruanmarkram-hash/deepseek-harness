# Agent Note: Native finalized epoch projection

Status: implemented

English | [中文](2026-09-23-native-finalized-epoch-projection.zh.md)

## Problem

The signed native transport commits relay handshake epochs in its protected ledger, while the hosted gateway independently requires the same committed epoch in its public route table before admitting application traffic. Enrollment and route creation alone leave that table at zero. A successful encrypted handshake therefore does not establish usable mobile access.

## Decision

The private FD198 protocol has a dedicated native-finalization request and durable acknowledgment. The FD199-seeded gateway checks the full route, enrollment identities, generation and finalized epoch, and refuses rollback, unresolved future reservations, revoked identities and live-connection replacement. The Host waits for the exact acknowledgment before opening the application connection. Stop and acknowledgment admission are serialized. Neither record carries a credential or changes the mobile protocol.

## Alternatives considered

**Ordinary begin/commit calls** reserve the gateway's next epoch even when the native handshake reconciles an earlier committed epoch after a lost receipt. Repeated counter increments invent connections and cannot recover native progress safely.

**Relaxing connection admission or resetting counters** hides disagreement and weakens replay protection. Explicit monotonic projection retains strict connection admission and leaves the protected native ledger untouched.

## Consequences

Both native Host/runtime executables and the dynamically loaded gateway package must ship together. Older gateways reject the new record rather than admitting an uncommitted connection. Scoped provider tests cover refusal and frame delivery; native tests cover encoded acknowledgment validation, cancellation and supervisor forwarding. The built-package smoke checks durable JSON reload, identical-epoch retry and native progress across separate provider instances. These checks do not substitute for signed-bundle and physical-phone connectivity verification.
