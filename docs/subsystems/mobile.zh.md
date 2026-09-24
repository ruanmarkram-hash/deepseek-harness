# 移动端远程接入

[English](mobile.md) | 中文

`packages/mobile` 包组定义受信远程接入所需的平台无关协议与 Host 服务。Host 将公开设备注册信息存入持久化存储，只接受经过提供方认证的连接，并发出公开生命周期与审计记录，而不暴露请求 payload、凭据、共享秘密或私钥。这些包不会添加面向模型的上下文。

源码：[`packages/mobile/remote-devices/src/types.ts`](../../packages/mobile/remote-devices/src/types.ts) · [`packages/mobile/remote-gateway/src/types.ts`](../../packages/mobile/remote-gateway/src/types.ts)

## 受信设备变更

`remote-devices/changed` 在持久化注册、在线状态更新或撤销完成后发出。注册与在线状态变更携带当前的公开设备记录；撤销只携带不透明设备 id。消费方按 `type` 切换处理。

```ts type-equiv
/** A post-durability change emitted by the Host-owned device directory. */
type RemoteDeviceChange =
  | { readonly type: 'enrolled'; readonly device: RemoteDeviceRecord }
  | { readonly type: 'seen'; readonly device: RemoteDeviceRecord }
  | { readonly type: 'revoked'; readonly deviceId: RemoteDeviceId }
```

## 网关审计记录

`remote-gateway/audit` 报告经过认证的设备与路由、已决定的操作及其结果、稳定原因，以及可选的请求关联 id。该记录绝不复制远程请求 payload 或 Host 秘密。

```ts type-equiv
/** Post-decision audit record identifying the authenticated requesting device and route. */
interface RemoteGatewayAuditEntry {
  /** Authenticated remote device that caused the operation. */
  readonly deviceId: RemoteDeviceId
  /** Authenticated relay route facts attached to the operation. */
  readonly route: TrustedRemoteRoute
  /** Gateway operation that was accepted, refused, or completed. */
  readonly operation: RemoteGatewayAuditOperation
  /** Remote correlation id when the operation has one. */
  readonly requestId?: RemoteWireId
  /** Final outcome of the gateway decision. */
  readonly outcome: 'accepted' | 'rejected' | 'completed'
  /** Stable implementation-owned reason code. */
  readonly reason: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxapiproxy--apiproxy"></a>

### `ctx.apiProxy` — `ApiProxy`

Root interface of the unified API. New client-request domain = one new file pair + one field here + one map row.

```ts cordis-catalog
/**
 * Response entry for server requests; not a domain method.
 * @param message - Client response carrying the server request's rpcId.
 * @returns Transport receipt for the response delivery.
 */
respond(message: ClientResponse): Promise<RpcReceipt>
```

Source: [`packages/mobile/remote-api/src/api/index.ts`](../../packages/mobile/remote-api/src/api/index.ts)

<a id="ctxremotedevices--remotedevicedirectory"></a>

### `ctx.remoteDevices` — `RemoteDeviceDirectory`

Durable trusted-device directory. All mutation methods are Host-local policy seams: a future local pairing UI invokes `enroll`, authenticated transport invokes `markSeen`, and a Host device manager invokes `revoke`. None accepts a relay token or makes remote enrollment possible by itself.

```ts cordis-catalog
/**
 * List enrolled devices in stable enrollment order.
 * @returns copies of every current trusted-device record.
 */
list(): readonly RemoteDeviceRecord[]

/**
 * Look up one trusted device by opaque id.
 * @param id - Opaque remote device id.
 * @returns a public metadata copy, or `undefined` when revoked or unknown.
 */
get(id: RemoteDeviceId): RemoteDeviceRecord | undefined

/**
 * Enroll a new remote device after local Host confirmation. Ids and either
 * public key are globally unique within this Host profile, preventing one
 * remote identity from being silently assigned to two device labels.
 * @param input - Locally-confirmed public device enrollment material.
 * @returns the durably enrolled public record.
 */
async enroll(input: RemoteDeviceEnrollment): Promise<RemoteDeviceRecord>

/**
 * Records the exact public device enrollment already confirmed by the signed
 * Host. This is the one imported ownership path: callers supply no secret
 * and a retry must match every durable public field.
 * @param input - Locally-confirmed public device enrollment material.
 * @param incarnation - Host-confirmed opaque device enrollment incarnation.
 * @returns the durable public record using that exact incarnation.
 */
async seed(input: RemoteDeviceEnrollment, incarnation: string): Promise<RemoteDeviceRecord>

/**
 * Mark an already authenticated trusted device present. The time is supplied
 * by the connection runtime so reconnect and test clocks stay explicit.
 * @param id - Authenticated remote device id.
 * @param seenAt - Canonical current instant from the Host connection runtime.
 * @returns the updated public metadata.
 */
async markSeen(id: RemoteDeviceId, seenAt: string): Promise<RemoteDeviceRecord>

/**
 * Revoke a trusted device immediately. Deletion is intentional: subsequent
 * mutual-authentication handshakes have no authorization record to match.
 * @param id - Device id to revoke.
 * @returns whether an enrolled device was removed.
 */
async revoke(id: RemoteDeviceId): Promise<boolean>
```

Source: [`packages/mobile/remote-devices/src/index.ts`](../../packages/mobile/remote-devices/src/index.ts)

<a id="ctxremoteenrollment--remoteenrollmentcontroller"></a>

### `ctx.remoteEnrollment` — `RemoteEnrollmentController`

Creates ephemeral relay credentials and persists only a locally-confirmed remote public identity. Routes live only in controller memory until one confirmation consumes them; the device directory never receives tokens.

```ts cordis-catalog
/**
 * Issues one in-memory route carrying separate Host and client relay credentials.
 * @returns the newly issued one-time route and copy-safe client invitation.
 */
issueRoute(): Promise<RemoteEnrollmentRoute>

/**
 * Consumes an exact pending invitation before durably enrolling its public device identity.
 * @param input - Local confirmation containing the issued invitation and remote public identity.
 * @returns the durably enrolled public device record.
 */
async confirm(input: RemoteEnrollmentConfirmation): Promise<RemoteDeviceRecord>
```

Source: [`packages/mobile/remote-host-identity/src/controller.ts`](../../packages/mobile/remote-host-identity/src/controller.ts)

<a id="ctxremotegateway--remotegateway"></a>

### `ctx.remoteGateway` — `RemoteGateway`

Host gateway for remote-wire v3. It owns dispatch, event ordering, retry retention, and response routing. Relay identity proof, encryption, route allocation, and byte transport remain with a connection provider.

```ts cordis-catalog
/**
 * Attach one already-authenticated remote connection. The gateway checks the
 * device directory again, so a revoked device cannot keep or regain access
 * through a stale relay authorization.
 * @param connection - Provider-authenticated and decrypted connection.
 * @returns the active connection controller, or `undefined` after refusal.
 */
async attach(connection: TrustedRemoteConnection): Promise<RemoteGatewayConnection | undefined>

/**
 * Consumes authenticated connections from a relay provider until cancellation.
 * @param provider - Relay provider that yields only authenticated, decrypted connections.
 * @param signal - Owner cancellation signal.
 */
async serve(provider: TrustedRemoteConnectionProvider, signal: AbortSignal): Promise<void>

/** Stop every current connection and drop all in-memory replay and retry state. */
async dispose(): Promise<void>

/**
 * Removes an active controller only when it still owns the device slot.
 * @param connection - Active controller whose endpoint needs removal.
 */
detach(connection: RemoteGatewayConnection): void

/**
 * End an active connection after its local device authorization is revoked.
 * @param deviceId - Revoked device whose process-lifetime state must close.
 */
revoke(deviceId: RemoteDeviceId): void

/**
 * Emits a non-throwing gateway audit record without payload data.
 * @param connection - Authenticated device and route for this operation.
 * @param operation - Decided operation.
 * @param outcome - Gateway outcome.
 * @param reason - Stable reason.
 * @param requestId - Optional correlation id.
 */
audit(connection: TrustedRemoteConnection, operation: RemoteGatewayAuditEntry['operation'], outcome: RemoteGatewayAuditEntry['outcome'], reason: string, requestId?: RemoteWireId): void

/**
 * Invoke the same checked route table that backs the Host HTTP API.
 * @param peer - Authenticated remote identity that must remain trusted.
 * @param method - Public Host RPC method to invoke.
 * @param requestId - Remote-wire request correlation id.
 * @param payload - RPC request payload.
 * @param signal - Cancellation signal for the Host RPC.
 * @returns the wire-safe Host result or a non-sensitive failure result.
 */
async invoke( peer: TrustedRemotePeerIdentity, method: keyof RpcMethodMap, requestId: RemoteWireId, payload: unknown, signal: AbortSignal, ): Promise<RemoteWireResult>

/**
 * Obtain the baseline needed when retained events cannot safely replay.
 * @param peer - Authenticated remote identity that must remain trusted.
 * @param signal - Cancellation signal shared by the baseline requests.
 * @returns the current Host, session, and workspace baseline results.
 */
async snapshot(peer: TrustedRemotePeerIdentity, signal: AbortSignal): Promise<RemoteGatewaySnapshot>

/**
 * Creates a fresh stable remote-wire id.
 * @returns a fresh stable remote-wire id.
 */
newId(): RemoteWireId

/**
 * Checks whether an authenticated device remains trusted by this Host.
 * @param peer - Authenticated remote identity to compare with the local directory.
 * @returns whether the device remains present with the same enrollment identity.
 */
isTrusted(peer: TrustedRemotePeerIdentity): boolean

/**
 * Record authenticated device presence through the Host-owned directory.
 * @param peer - Authenticated remote identity whose presence is recorded.
 * @returns the durable directory write result.
 */
markSeen(peer: TrustedRemotePeerIdentity): Promise<unknown>
```

Types: [RpcMethodMap](typert.zh.md)

Source: [`packages/mobile/remote-gateway/src/index.ts`](../../packages/mobile/remote-gateway/src/index.ts)

<a id="ctxremotehostidentity--remotehostidentity"></a>

### `ctx.remoteHostIdentity` — `RemoteHostIdentity`

Host facade over a signed native protected-key handle.

```ts cordis-catalog
/**
 * Copies the public metadata exposed by the protected identity handle.
 * @returns a caller-owned public identity copy.
 */
publicIdentity(): RemoteHostPublicIdentity

/**
 * Signs exact handshake transcript bytes through the protected handle.
 * @param payload - Exact handshake transcript bytes.
 * @returns detached signature bytes.
 */
sign(payload: Uint8Array): Uint8Array

/**
 * Derives shared-secret input through the protected agreement key.
 * @param remoteAgreementPublicKey - Base64url remote public key.
 * @returns KDF input bytes.
 */
deriveSharedSecret(remoteAgreementPublicKey: string): Uint8Array
```

Source: [`packages/mobile/remote-host-identity/src/identity.ts`](../../packages/mobile/remote-host-identity/src/identity.ts)

<a id="ctxremotehostv3--remotehostv3controller"></a>

### `ctx.remoteHostV3` — `RemoteHostV3Controller`

Host-local V3 coordinator. It creates no HTTP listener, performs no cryptography, and owns no route credential.

```ts cordis-catalog
/**
 * Lists the allocator's durable public routes without credentials or ciphertext.
 * @returns durable public routes without route tokens, private keys, or ciphertext.
 */
listRoutes(): readonly RemoteHostV3Route[]

/** Begin the generic gateway's receive loop over the signed Host app's inherited private pipe. */
start(): void

/**
 * Begins serving over a natively activated handoff that arrived after mount,
 * exactly once. The hosted FD199 startup plugin calls this only after its
 * authority handshake and journal consume succeeded.
 * @param native - Activated signed Host-app handoff for this child process.
 */
startWithNative(native: RemoteHostV3NativeProvider): void

/**
 * Builds the inherited-pipe native provider over this deployment's durable
 * route allocator and device directory. Descriptor 198 stays unread until a
 * caller actually serves the returned pipe.
 * @param descriptor - Inherited relay descriptor; only the fixed value is accepted.
 * @param hostAppPath - Absolute path announced by the proven FD199 authority.
 * @param inheritedPipe - Test-only prebuilt pipe; production always adopts descriptor 198.
 * @param requireEnrollmentSeed - Whether runtime readiness requires the native Host enrollment seed first.
 * @returns the native provider for {@link startWithNative}.
 */
createInheritedNativeProvider( descriptor: number, hostAppPath: string, inheritedPipe?: RemoteHostV3RuntimePipe, requireEnrollmentSeed: boolean = false, ): RemoteHostV3NativeProvider

/** Stop links, provider delivery, and future route activity. */
dispose(): void
```

Source: [`packages/mobile/remote-host-v3/src/index.ts`](../../packages/mobile/remote-host-v3/src/index.ts)

<a id="remote-devices-events"></a>

### `remote-devices/*` events

<a id="remote-deviceschanged--emit"></a>

#### `remote-devices/changed` — emit

A trusted device was durably enrolled, seen, or revoked. The event contains public metadata only and fires after the durable mutation.

```ts cordis-catalog
/**
 * A trusted device was durably enrolled, seen, or revoked. The event
 * contains public metadata only and fires after the durable mutation.
 * @mode emit
 * @param change - Post-durability device-directory change.
 */
'remote-devices/changed'(change: RemoteDeviceChange): void
```

Source: [`packages/mobile/remote-devices/src/index.ts`](../../packages/mobile/remote-devices/src/index.ts)

<a id="remote-gateway-events"></a>

### `remote-gateway/*` events

<a id="remote-gatewayaudit--emit"></a>

#### `remote-gateway/audit` — emit

A trusted remote operation reached a Host gateway decision point. The entry identifies the authenticated device and route and never copies a payload.

```ts cordis-catalog
/**
 * A trusted remote operation reached a Host gateway decision point.
 * The entry identifies the authenticated device and route and never copies a payload.
 * @mode emit
 * @param entry - Completed or rejected gateway audit record.
 */
'remote-gateway/audit'(entry: RemoteGatewayAuditEntry): void
```

Source: [`packages/mobile/remote-gateway/src/index.ts`](../../packages/mobile/remote-gateway/src/index.ts)
<!-- END GENERATED cordis-surface -->
