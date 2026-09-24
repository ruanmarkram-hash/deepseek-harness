---
description: "Parse bounded transport-neutral requests, responses, and events for trusted remote clients."
kind: "package-library"
---

# dsh-remote-wire

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-remote-wire` defines the version-three, transport-neutral envelope vocabulary for a trusted remote DSH client connected to one host-owned harness. It is a parser and contract package, not a relay, connection, trust store, encryption layer, or UI.

## Table of Contents

- [Surface](#surface)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="surface"></a>

## Surface

No runtime invariant companion is published because this stateless envelope parser owns no Host process state or event stream.

Every envelope carries fixed `version: 3` and `connectionEpoch`. A client request carries an opaque `requestId` and `idempotencyKey`; a response echoes that request id. Host events carry both an opaque delivery `eventId` and the original Host `requestId`, plus a contiguous delivery `cursor`; answerable event replies echo that Host request id. The client sends `stream-ack` only after applying the highest contiguous cursor locally. The parser does not retain ordering state, so a future connection owner enforces epoch replacement, idempotency retention, and acknowledgement progression.

`REMOTE_WIRE_METHODS` is a closed allowlist checked against the public API Proxy `RpcMethodMap`. It admits the current DSH session, workspace, model, subagent, configuration, credential, and host methods without introducing a second, hand-named computer-use API. `REMOTE_WIRE_EVENTS` preserves every existing public host and mux event name. Approval answers preserve the current `allowed-once` and `rejected` outcomes. A generic `client-response` echoes a host request id and can answer the existing question requests. Device controls are limited to connection lifecycle (`device.describe`, `device.heartbeat`, and `device.disconnect`), never host tool execution.

The parser rejects extra or missing fields, unsupported versions, unknown methods or events, invalid opaque ids, invalid epochs or cursors, unbounded JSON, malformed result, approval, or client-response shapes. Payload, result, and the complete reconstructed envelope are capped at 8 MiB; recursive JSON also caps scalar strings at 1 MiB, depth at 32, and entries per container at 1,024. Prototype-poisoning keys are rejected. Parser failures use stable codes and do not echo untrusted content.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- This package does not authenticate a device, bind a transport, persist idempotency records, order or replay a stream, dispatch a DSH method, or apply approval and device-control policy. A future host-owned connection runtime owns those effects and maps the validated vocabulary to the existing DSH API Proxy.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
