---
description: "通过描述符 198 将签名 Host 传输连接到已配置的远程网关。"
kind: "package-reference"
---

# dsh-remote-host-v3

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-remote-host-v3` 在 `remote_host_v3` storage domain 中保存公开 V3 route 坐标、Host 和 device incarnation、中继 generation，以及已提交或待定的连接 epoch。它不保存中继 token、私钥、shared secret、明文 frame、会话内容或移动端凭据。

## 目录

- [已签名 Host-app handoff](#signed-host-app-handoff)
- [私有 Remote Wire 合约](#private-remote-wire-contract)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="signed-host-app-handoff"></a>

## 已签名 Host-app handoff

不发布运行时不变量 companion，因为路由变更经过串行处理和存储 schema 验证，不存在独立从事件派生的路由状态。

Web bundle 保持禁用此包。只有由已签名持久 DSH Host.app 启动的 runtime child 才可进行 live composition。该 app 是 Keychain XPC helper 的唯一 client，拥有所有私钥操作、route token、中继 provision call、WebSocket upgrade、加密 handshake 与 ciphertext carrier。它仅通过 inherited private pipe 向已验证 runtime child 传递已认证、已解密的 `TrustedRemoteConnection`。该 pipe 没有路径、port、发现协议、signing method、derivation method、route-token operation 或通用 request interface。

控制器验证注入 provider 证明配置的绝对 Host-app executable path，并将 handoff 命名为 `inherited-private-pipe`；然后把 typed provider 交给 `ctx.remoteGateway`。gateway 会在每次 DSH 操作前独立将不可变 peer tuple 与本地 device directory 重新核对。普通 `dsh web` source execution 没有 provider，启用时会 fail closed。

存在两条挂载路径。`start()` 消挂载即存在的 provider，与之前相同。托管 FD199 启动插件（`@deepseek-ai/dsh-remote-host-fd199`）则在其权威握手与日志消费成功后调用 `startWithNative()`；延迟挂载每进程只接受一次，验证绝对宿主应用路径与 `inherited-private-pipe` 种类，并拒绝重复或处置后的再次挂载。`createInheritedNativeProvider(descriptor, hostAppPath)` 基于本部署的持久路由分配器与设备目录构建该 provider，且只接受描述符 198；描述符 198 在实际服务返回的管道前保持未读。

`RemoteHostV3RouteAllocator` 仍是持久公开 route 和精确 epoch 所有者。已签名 Host app 会通过已验证 runtime child 将 route 事实镜像到此 domain。它从不接收 route credential。只有在已签名 Host app 报告相互 relay completion 后才提交待定 epoch；模糊 restart 应在本地修复，而不是猜测更高 epoch。

<a id="private-remote-wire-contract"></a>

## 私有 Remote Wire 合约

`createRemoteHostV3InheritedWireProvider()` 只打开 signed Host.app 复制给已验证 child 的 descriptor `198`。它不会 connect、listen 或发现 socket。stream 使用 Swift `RemoteHostWire` format：big-endian `u32 body length`、`u8 kind`、`u16 UTF-8 JSON metadata length`、metadata，然后是 opaque payload。body length 最大 8 MiB，metadata 最大 16 KiB。

runtime 先发送空的 `runtime.ready`。FD199 托管 child 随后必须先接收一条公开、payload 为空的 `enrollment.seed`，才会接受 `device.enroll` 或 `route.upsert`；其 metadata 必须精确为 `{ deviceId, label, signingPublicKey, agreementPublicKey, deviceEnrollmentId, hostEnrollmentId }`，并把该本地确认 receipt 保存在已配置的 device directory 和 route allocator 中。随后 Host 可发送公开的 `device.enroll`、`route.upsert` 或 `route.revoked`、`epoch.begin` 或 `epoch.commit`、`connection.open`、`connection.frame`、`connection.closed` 或空的 `host.stopping`。`device.enroll` 的 payload 必须为空，metadata 必须精确为 `{ deviceId, label, signingPublicKey, agreementPublicKey }`；它是对 seeded tuple 的精确幂等确认，并以 `device.enrolled` 回复，payload 为空且公开 metadata 精确为 `{ deviceId, label, signingPublicKey, agreementPublicKey, deviceEnrollmentId, hostEnrollmentId }`。该 receipt 包含 device incarnation 和 allocator 唯一的 Host-incarnation authority。signed Host 必须将后续 route 和 phone invitation 绑定到这个精确 receipt，而不能使用独立提供的 Host incarnation。seed 和 receipt 都绝不携带 relay token、私钥、shared secret 或 invitation capability。除此之外 runtime 只会回复 `epoch.begun`、`epoch.committed`、`connection.send` 和 `connection.close`。route 和 epoch metadata 使用精确 schema；`connection.open` 带有已认证 device id、enrollment id、公开 signing 与 agreement key、route id、generation 和 epoch，只有在该精确 durable route epoch 已提交后才会被接纳；`connection.frame` 只携带一个有界 `dsh-remote-wire` v3 JSON envelope。frame 在其匹配的 open 之前绝不会 yield。send 或 close 只命名该 opaque connection id，不带任意 operation field。

畸形 UTF-8/JSON、未知或方向错误 kind、metadata 或 payload overflow、未知 connection id、epoch mismatch、partial-record EOF 和普通 EOF 都会关闭完整 private pipe。adapter 此后不会再 yield connection。在 parse 之前，serialized descriptor dispatcher 会在 copy 前检查 raw chunk 的长度，最多保留 32 个 raw chunk，以及一条 8 MiB record 加其 four-byte length prefix；它按 offset view 从单个 raw chunk 流式分派最多 1,024 条完整 record，并只 compact 其 trailing partial record。因此密集的有效 chunk 不会分配无界 decoded-record array，也不会反复 copy 逐渐缩小的 suffix。overflow 会关闭 pipe，而不会保留无界 pending task list。每个 opened connection 最多保留 32 个未消费 frame 和它们原始 payload byte 的 8 MiB；超过任一 budget 的 slow consumer 会以 `protocol-rejected` 被关闭，而无关 connection 保持有界且存活。每个 queued send 都会捕获该具体 connection lifetime，并在物理 pipe write 前立即检查该 lifetime 和 gateway fence。peer close、local close、overflow 与 revoke 都会先使该 lifetime 失效，随后 output 不会越过它们。local close、overflow、revoke，或有 pending send 的 peer-closed connection 最多保留 64 个 tombstone 中的一个；它会阻止 id reuse，直到旧 queued send settled，且所有 local close write 与 Host acknowledgement 完成。outbound record 通过全局 budget 串行化：64 条 record 以及一条 8 MiB record 加 prefix；每个 user-controlled send 会在 JSON serialization 前 reserve 有界容量，因此 concurrent burst 不会分配无界 payload string。descriptor 在任一 budget 上 stalled 会关闭 pipe 并拒绝所有 pending write。`committed-before-fence` 只表示在 gateway fence 仍有效时 record 已进入该 inherited Host-app pipe；它不声称 mobile delivery。

取消待完成的接收操作会在后续帧分派前移除该读取方，因此替代读取方可以接收下一帧。出站容量预留属于创建它的提供方；其他提供方不能释放或使其失效。如果排队发送在最终检查发送许可时抛出异常，提供方会以 `REMOTE_HOST_V3_WIRE_WRITE_FAILED` 关闭私有管道并拒绝待完成的写入。如果该检查同步关闭管道，则不会再向描述符写入。

<a id="configuration"></a>

## 配置

托管 FD199 连接通过 `epoch.synchronize`（kind 17）投影 signed native transport 已完成的 epoch，并在 `connection.open` 前等待持久化的 `epoch.synchronized`（kind 18）。两者的 metadata 必须精确为 `{ routeId, deviceId, deviceEnrollmentId, hostDeviceId, hostEnrollmentId, generation, connectionEpoch }`，payload 为空。只有完成 native seed 的 provider 接受同步；完整 route 和当前设备身份必须匹配，且该设备不能有已打开的连接。Epoch 回退、高于已完成 epoch 的未解决 child reservation、缺失或撤销的身份及非法字段均 fail closed。相同已完成 epoch 的重试是幂等的；向前推进反映 native finalization，不伪造中间连接。Native pending reservation 保留在 native ledger 中。普通 `epoch.begin` 与 `epoch.commit` 语义不变。构建此 package 及其依赖后，可运行 `node scripts/smoke-native-finalized-epoch.mjs` 验证构建产物；它使用临时 JSON store，绝不使用真实 Host profile。

```ts
import type * as RemoteHostV3 from '@deepseek-ai/dsh-remote-host-v3'

const config: RemoteHostV3.Config = {
  enabled: false,
  hostAppPath: '/Applications/DSH Host.app/Contents/MacOS/DSH Host',
}
```

`enabled` 默认 `false`。启用的组合会在启动 gateway receive loop 前拒绝缺失 provider、非绝对 Host-app path、路径不匹配，或并非 inherited private-pipe handoff 的 provider。

<a id="model-experience"></a>

## 模型体验

### Host V3 transport

#### 模型看到的内容

该包不注册模型提示词段落、工具、session event 或远程指令。它的公开 `remote_host_v3` route 状态只提供给 host-side consumer，绝不会插入 agent request。

#### Token 影响

零 token。

#### KV Cache 影响

该包既不创建也不改写 model-visible request content，因此不会使模型 KV-cache prefix 失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 已签名持久 DSH Host 会打包并验证其托管 runtime child、实现固定 Remote Wire counterpart，并传入 typed private pipe。普通源码启动的 `dsh web` 进程仍会让此包失败关闭。
- 路由凭据、配对批准、relay 激活、轮换、修复和撤销仍是原生 Host 操作。此包只接收经过认证的 connection fact 和公开路由状态。
- Host 菜单和移动应用提供首次配对、QR 或代码传输、显式激活、重连、撤销和本地忘记流程。生产验收仍要求已公证 Host 与已处理 TestFlight 构建在不同网络上通过。
- 计算机使用采集与原生控制不属于此 transport，需要单独的 macOS 权限所有者。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作备注</summary>

无。

</details>
