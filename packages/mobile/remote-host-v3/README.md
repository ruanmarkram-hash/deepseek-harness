---
description: "Connect the signed Host transport to the configured remote gateway over descriptor 198."
kind: "package-reference"
---

# dsh-remote-host-v3

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-remote-host-v3` stores public V3 route coordinates, Host and device incarnations, relay generation, and committed or pending connection epochs under the `remote_host_v3` storage domain. It stores no relay token, private key, shared secret, plaintext frame, session content, or mobile credential.

## Table of Contents

- [Signed Host-app handoff](#signed-host-app-handoff)
- [Private Remote Wire contract](#private-remote-wire-contract)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="signed-host-app-handoff"></a>

## Signed Host-app handoff

No runtime invariant companion is published because route mutations are serialized and storage-schema validated, with no independent event-derived route state.

The Web bundle keeps this package disabled. A live composition is permitted only inside a runtime child started by a signed persistent DSH Host.app. That app is the sole client of the Keychain XPC helper, owns every private key operation, route token, relay provisioning call, WebSocket upgrade, encrypted handshake, and ciphertext carrier. It passes only already authenticated, decrypted `TrustedRemoteConnection` values through an inherited private pipe to the verified runtime child. The pipe has no path, port, discovery protocol, signing method, derivation method, route-token operation, or generic request interface.

The controller validates that its injected provider attests the configured absolute Host-app executable path and names the handoff `inherited-private-pipe`; it then gives that typed provider to `ctx.remoteGateway`. The gateway independently rechecks the immutable peer tuple against the local device directory before every DSH operation. Ordinary `dsh web` source execution receives no provider and fails closed when enabled.

Two attach paths exist. `start()` consumes a provider mounted at boot time, as before. The hosted FD199 startup plugin (`@deepseek-ai/dsh-remote-host-fd199`) instead calls `startWithNative()` after its authority handshake and journal consume succeeded; the deferred attach is accepted exactly once per process, validates an absolute Host-app path and the `inherited-private-pipe` kind, and rejects repeat or post-disposal attaches. `createInheritedNativeProvider(descriptor, hostAppPath)` builds that provider over this deployment's durable route allocator and device directory while accepting only descriptor 198; descriptor 198 stays unread until something actually serves the returned pipe.

`RemoteHostV3RouteAllocator` remains the durable public route and exact-epoch owner. A signed Host app mirrors route facts into this domain through its verified runtime child. It never receives route credentials. Pending epochs are committed only after the signed Host app reports mutual relay completion; an ambiguous restart is repaired locally instead of guessing a higher epoch.

<a id="private-remote-wire-contract"></a>

## Private Remote Wire contract

`createRemoteHostV3InheritedWireProvider()` opens only descriptor `198`, which the signed Host.app duplicated into its verified child. It does not connect, listen, or discover a socket. The stream is the Swift `RemoteHostWire` format: big-endian `u32 body length`, `u8 kind`, `u16 UTF-8 JSON metadata length`, metadata, then opaque payload. Body length is at most 8 MiB and metadata at most 16 KiB.

The runtime emits empty `runtime.ready` first. An FD199 hosted child then requires one public empty-payload `enrollment.seed` before it accepts `device.enroll` or `route.upsert`; its metadata is exactly `{ deviceId, label, signingPublicKey, agreementPublicKey, deviceEnrollmentId, hostEnrollmentId }`, and it preserves that local-confirmation receipt in the configured device directory and route allocator. The Host may then send public `device.enroll`, `route.upsert` or `route.revoked`, `epoch.begin` or `epoch.commit`, `connection.open`, `connection.frame`, `connection.closed`, or empty `host.stopping`. `device.enroll` has exact empty-payload metadata `{ deviceId, label, signingPublicKey, agreementPublicKey }`; it is an exact idempotent confirmation of the seeded tuple and replies `device.enrolled` with the exact empty-payload public metadata `{ deviceId, label, signingPublicKey, agreementPublicKey, deviceEnrollmentId, hostEnrollmentId }`. The receipt carries the device incarnation and the allocator's sole Host-incarnation authority. The signed Host must bind its later route and phone invitation to that exact receipt, never an independently supplied Host incarnation. The seed and receipt never carry a relay token, private key, shared secret, or invitation capability. The runtime otherwise replies only with `epoch.begun`, `epoch.committed`, `connection.send`, and `connection.close`. Route and epoch metadata use exact schemas; `connection.open` carries the authenticated device id, enrollment id, public signing and agreement keys, route id, generation, and epoch, and is admitted only after that exact durable route epoch has committed. `connection.frame` carries exactly one bounded `dsh-remote-wire` v3 JSON envelope. A frame is never yielded before its matching open. A send or close names only that opaque connection id and has no arbitrary operation field.

Malformed UTF-8/JSON, unknown or wrong-direction kinds, metadata or payload overflow, unknown connection ids, epoch mismatch, partial-record EOF, and normal EOF close the complete private pipe. The adapter then yields no more connections. Before parsing, the serialized descriptor dispatcher checks a raw chunk's length before copying it, retains at most 32 raw chunks and one 8 MiB record plus its four-byte length prefix, and streams no more than 1,024 complete records from any one raw chunk by offset view, compacting only its trailing partial record. A dense valid chunk therefore cannot allocate an unbounded decoded-record array or repeatedly copy its shrinking suffix. Overflow closes the pipe instead of retaining an unbounded pending task list. Each opened connection retains at most 32 unconsumed frames and 8 MiB of their original payload bytes; a slow consumer that exceeds either budget is closed with `protocol-rejected` while unrelated connections remain bounded and live. Every queued send captures that specific connection lifetime and checks both that lifetime and the gateway fence immediately before its physical pipe write. Peer close, local close, overflow, and revocation invalidate that lifetime before later output can overtake them. A locally closed, overflowed, revoked, or peer-closed-with-pending-send connection leaves at most one of 64 tombstones; it blocks id reuse until its old queued sends settle and any local close write and Host acknowledgement have completed. Outbound records are serialized through a global budget of 64 records and one 8 MiB record plus prefix; each user-controlled send reserves bounded capacity before JSON serialization, so a concurrent burst cannot allocate unbounded payload strings. A stalled descriptor over either budget closes the pipe and rejects every pending write. `committed-before-fence` means the record entered this inherited Host-app pipe while the gateway fence remained active; it does not claim mobile delivery.

<a id="configuration"></a>

## Configuration

Hosted FD199 connections project the signed native transport's finalized epoch with `epoch.synchronize` (kind 17) and wait for durable `epoch.synchronized` (kind 18) before `connection.open`. Both carry exactly `{ routeId, deviceId, deviceEnrollmentId, hostDeviceId, hostEnrollmentId, generation, connectionEpoch }` and an empty payload. Only a native-seeded provider accepts synchronization; the entire route and current device identity must match and no device connection may be open. Epoch rollback, unresolved child reservations above the finalized epoch, missing or revoked identities, and malformed fields fail closed. An identical finalized epoch is idempotent; forward progress reflects native finalization without synthetic intermediate connections. Native pending reservations remain in the native ledger. Ordinary `epoch.begin` and `epoch.commit` semantics remain unchanged. The built-artifact smoke is `node scripts/smoke-native-finalized-epoch.mjs` after building this package and its dependencies; it uses temporary JSON stores, never the live Host profile.

```ts
import type * as RemoteHostV3 from '@deepseek-ai/dsh-remote-host-v3'

const config: RemoteHostV3.Config = {
  enabled: false,
  hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
}
```

`enabled` defaults to `false`. An enabled composition rejects a missing provider, non-absolute Host-app path, path mismatch, or a provider that is not an inherited private-pipe handoff before it starts the gateway receive loop.

<a id="model-experience"></a>

## Model Experience

### Host V3 transport

#### What the model sees

This package registers no model prompt section, tool, session event, or remote instruction. Its public `remote_host_v3` route state is available only to host-side consumers and is never inserted into an agent request.

#### Token effect

Zero tokens.

#### KV Cache effect

The package neither creates nor rewrites model-visible request content, so it does not invalidate a model KV-cache prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The signed persistent DSH Host packages and verifies its hosted runtime child, implements the fixed Remote Wire counterpart, and passes the typed private pipe. This package still fails closed in an ordinary source-launched `dsh web` process.
- Route credentials, pairing approval, relay activation, rotation, repair, and revocation remain native Host operations. This package receives only authenticated connection facts and public route state.
- The Host menu and mobile app provide first pairing, QR/code transfer, explicit activation, reconnect, revocation, and local forget flows. Production acceptance still requires the notarized Host and processed TestFlight build on different networks.
- Computer-use capture and native control remain outside this transport and require their own macOS permission owner.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
