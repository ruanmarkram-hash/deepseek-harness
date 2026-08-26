# dsh-remote-gateway

English | [中文](README.zh.md)

`@deepseek-ai/dsh-remote-gateway` is the Host-owned v3 remote dispatch service. It lets an authenticated connection provider attach a trusted device to the same composed DSH Host used by the browser and Desktop renderer. It does not open an HTTP route, create a relay route, connect to a relay, enroll a device, or hold a private key.

## Surface

The Web Host bundle composes `ctx.remoteGateway` after `ctx.apiProxy` and `ctx.remoteDevices`. A relay implementation calls `attach(connection)` for one mutually-authenticated, decrypted connection, or `serve(provider, signal)` for its accept loop. The provider proves immutable `peer` identity `{ deviceId, enrollmentId, signingPublicKey, agreementPublicKey }` and route freshness before attachment. `enrollmentId` is the Host-minted device-directory incarnation, not a client timestamp. The gateway checks the exact tuple against `ctx.remoteDevices` again, records authenticated presence, rejects stale route generations and epochs, rechecks authorization immediately before every Host dispatch, and closes an active connection immediately when the directory revokes its device. Revocation drops live replay and idempotency data but retains an old-incarnation freshness fence, so a delayed old connection cannot reactivate after a same-id re-enrollment.

Every remote API request uses `invokeApiProxyMethod`, the same schema-checked dispatch table as the browser API carrier. The gateway retains completed idempotency results separately for each device and rejects a retry key reused for different input. Approval outcomes and question answers enter `ctx.apiProxy.respond` with the original Host request id, so current pending interaction ownership remains with the Host. Before every response or event send, the gateway checks both current authorization and connection closure again; a result that completes after revocation is dropped. Every carrier write receives a mutable `{ active, generation, abortSignal }` close fence and must return only `committed-before-fence` (local carrier accepted bytes before its final fence check) or `not-committed`. The gateway never treats the former as remote delivery, and never records an output as delivered if revocation closes the fence while the provider is resolving the write.

The two current Host event streams are retained as one ordered device cursor stream. A client sends `device.describe` without `payload.cursor` for a Host snapshot (`host.describe`, `session.list`, and `workspace.list`); a retained cursor requests replay. The snapshot/replay response is sent before event delivery. `stream-ack` accepts only monotonic cursors no later than the retained tail. The configured per-device idempotency and event counts bound live Host memory.

`remote-gateway/audit` emits authenticated device id, route facts, operation kind, result, and a stable reason. It never emits request payloads, session content, credentials, shared secrets, or private keys.

## Connection provider requirement

```ts
import type * as RemoteGateway from '@deepseek-ai/dsh-remote-gateway'
import type * as RemoteWire from '@deepseek-ai/dsh-remote-wire'

interface TrustedRemoteConnection {
  readonly peer: RemoteGateway.TrustedRemotePeerIdentity
  readonly route: RemoteGateway.TrustedRemoteRoute
  receive(signal: AbortSignal): AsyncIterable<RemoteWire.RemoteWireEnvelope>
  send(
    envelope: RemoteWire.RemoteWireEnvelope,
    fence: RemoteGateway.TrustedRemoteSendFence,
  ): Promise<
    | { readonly status: 'committed-before-fence' }
    | { readonly status: 'not-committed' }
  >
  close(reason: RemoteGateway.RemoteGatewayCloseReason): Promise<void>
}

interface TrustedRemoteConnectionProvider {
  accept(signal: AbortSignal): AsyncIterable<TrustedRemoteConnection>
}
```

Each yielded `TrustedRemoteConnection` identifies authenticated `peer` public identity and an authenticated `{ routeId, generation, connectionEpoch }`, receives parsed v3 envelopes, sends v3 envelopes under the supplied close fence, and closes one physical connection. The provider owns mutual authentication, encrypted bytes, relay route tokens, reconnection transport, and route rotation. It must never yield an unauthenticated or plaintext connection, and it must not claim peer delivery from a local socket write.

## Known Limitations and Deferred Work

- The package is composed but has no connection provider. The future Keychain-backed Host identity and encrypted relay provider must explicitly attach connections. Until then, it cannot receive remote traffic.
- Replay and idempotency retention is bounded in the live Host process. A future secure retention provider can make retries survive Host restart without copying sensitive result data into the public device directory.
- Computer-use screen streaming and native computer control are intentionally absent. They require a separate macOS helper and explicit OS permission model.
