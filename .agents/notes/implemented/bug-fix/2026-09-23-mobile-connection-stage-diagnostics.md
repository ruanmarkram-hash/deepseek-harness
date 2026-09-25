# Agent Note: Mobile connection stage diagnostics

Status: implemented

English | [中文](2026-09-23-mobile-connection-stage-diagnostics.zh.md)

## Problem

A generic connection error cannot distinguish phone authentication, relay opening, or encrypted handshake failure. Host-side absence of a first frame does not prove which phone operation failed or that the stored invitation expired.

## Decision

Each mobile connection attempt owns a closed set of diagnostic stages. Failures and deadlines expose only fixed stage labels and fixed guidance. The socket wrapper advances from hello preparation/sending to Host handshake only after its first carrier send returns successfully; it forwards frame contents unchanged and never parses or records them. Local send acceptance is not evidence of remote delivery. Receipt persistence and workspace loading share the authenticated bootstrap stage.

## Alternatives considered

**Displaying native or relay exception text** can expose credentials, identifiers or transport details and is unnecessary to locate the failed operation.

**Inferring expired pairing from a silent Host** confuses authentication, transport and routing failures and encourages destructive recovery without evidence.

## Consequences

The next physical attempt identifies the failed local stage without changing wire messages, validation, deadlines, native authentication, keys, durable epochs or retry rules. Diagnostics deliberately do not identify a root cause within a stage. Network rejection details still require independent relay evidence.

## Verification

Fault injection exercises every stage through the production mobile client, including failure before hello preparation, failure during send, failure after successful send and real encrypted workspace bootstrap. Sentinel exception details never enter visible state. Encrypted transcript timeout snapshots retain the exact stage while existing cancellation and next-epoch retry tests remain active. Physical iOS networking and Face ID remain release checks.
