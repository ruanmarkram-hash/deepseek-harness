---
description: "Choose the mobile transport, trusted-device, and signed Host integration packages."
kind: "package-group"
---

# mobile/ — shared mobile product vocabulary

English | [中文](README.zh.md)

## Summary

These packages connect the signed DSH Host, native mobile client, and remote relay. Protocol libraries define transport values; Host plugins adapt already-authorized phone requests to the configured Host services. Pairing does not independently grant local computer, filesystem, credential, or workspace access.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>

## Packages

| Package | Role |
|---|---|
| [`pairing-protocol/`](pairing-protocol/README.md) | Validates accountless encrypted-pairing bootstrap data, mobile capability declarations, and opaque relay-frame ordering |
| [`remote-api/`](remote-api/README.md) | Preserves released mobile request and event contracts over current Host controllers |
| [`remote-devices/`](remote-devices/README.md) | Owns the Host's durable public trusted-device directory and enrollment incarnations |
| [`remote-gateway/`](remote-gateway/README.md) | Dispatches authenticated remote-wire requests and ordered Host events over an injected trusted connection |
| [`remote-host-fd199/`](remote-host-fd199/README.md) | Performs the authenticated hosted-runtime ownership handoff over inherited descriptor 199 |
| [`remote-host-identity/`](remote-host-identity/README.md) | Defines the signed native Host identity provider and local enrollment controller |
| [`remote-host-v3/`](remote-host-v3/README.md) | Adapts the signed Host's inherited descriptor 198 into the configured V3 Host gateway |
| [`remote-relay-protocol/`](remote-relay-protocol/README.md) | Implements the mutually authenticated encrypted V3 relay handshake and frame transport |
| [`remote-wire/`](remote-wire/README.md) | Defines the bounded V3 owner API, event stream, approvals, action cards, and cursor vocabulary |

<a id="related-documentation"></a>

## Related documentation

The [mobile subsystem reference](../../docs/subsystems/mobile.md) owns the shared service and event definitions.

<a id="dev-note"></a>

## Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
