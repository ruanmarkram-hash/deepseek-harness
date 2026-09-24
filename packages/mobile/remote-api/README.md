---
description: "Connect released mobile clients and the thin Desktop discovery wrapper to current Host controllers without changing their wire contracts."
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-api

English | [中文](README.zh.md)

## Summary

Released mobile clients can list sessions, submit prompts, receive committed text, and answer the same approvals as desktop browsers. The configured Host remains the owner of sessions, agents, persistence, and pending interactions. This adapter preserves the mobile request and event contracts without exposing a second general-purpose HTTP API.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The signed Host launcher mounts this plugin alongside the authenticated mobile gateway. It provides the in-process `apiProxy` contract consumed by that gateway; it does not authenticate a device or grant capabilities. Ordinary browser clients use the current [API Gateway](../../api/gateway/README.md).

The independently installed thin Desktop wrapper can POST its existing discovery envelope to `/api/host.describe`. This exact route accepts only kernel-observed loopback callers with a loopback Host header and no Origin header. It rejects other methods and oversized bodies. No legacy mutation endpoint is mounted.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The adapter](src/adapter.ts) maps released mobile envelopes to current controller calls and supplies stable request identities. [The event adapter](src/events.ts) projects committed message text for released phone renderers and uses Gateway's existing pending interaction owner for approvals and questions. It validates session and approval identities before submitting a response. The optional hosted write fence covers complete unary operations and interaction responses; read streams remain available during ownership handoff.

Runtime invariant: No companion is published. This package does not maintain a second authoritative session or approval store; controller calls re-read the current services, and pending delivery records are removed with their owned stream lifecycle.

The in-process adapter and sealed Host loopback carrier share [one unary method map](src/api/unary.ts). Each carrier retains its own request handling, streams, downloads, and response delivery.

`plugins.list` and `plugins.setEnabled` dispatch through the Host-owned `hostPlugins` service. They exchange sanitized installed rows and exact ids only; package installation has no phone request method.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Remote Gateway](../remote-gateway/README.md): authenticated remote dispatch.
- [Remote Wire](../remote-wire/README.md): bounded phone request contracts.
- [FD199 ownership](../remote-host-fd199/README.md): signed Host handoff and write fencing.

<a id="model-experience"></a>
## Model Experience

None, as this package dispatches existing controller calls and contributes no prompt, tool schema, or model-visible event of its own.

#### KV Cache effect

No direct effect; the invoked controller and its model-facing owners determine context and cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The compatibility contract is limited to released phone behavior.

- Preset copying, document opening, and removal are unavailable and return explicit capability errors. Session-log downloads return not found.
- Cold history uses current paged session queries without activating an agent. The adapter does not add a durable event replay store.
- Discovery has no browser bootstrap cookie because the thin Desktop wrapper calls it before opening the browser connection. Its loopback-only, origin-free route is read-only and does not replace Connection authentication for any current API.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
