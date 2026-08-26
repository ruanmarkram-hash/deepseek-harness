# dsh-remote-gateway

[English](README.md) | 中文

`@deepseek-ai/dsh-remote-gateway` 是由 Host 拥有的 v3 远程分发服务。经认证的连接提供者可以将受信任设备附加到与浏览器和 Desktop 渲染器相同的 DSH Host。它不开放 HTTP 路由、不创建或连接中继路由、不注册设备，也不持有私钥。

## Surface

Web Host bundle 在 `ctx.apiProxy` 和 `ctx.remoteDevices` 之后组合 `ctx.remoteGateway`。中继实现为一个已完成双向认证和解密的连接调用 `attach(connection)`，或用 `serve(provider, signal)` 运行接受循环。提供者必须在附加前证明不可变的 `peer` 身份 `{ deviceId, enrollmentId, signingPublicKey, agreementPublicKey }` 和路由新鲜度。`enrollmentId` 是 Host 生成的设备目录 incarnation，不是客户端时间戳。网关会再次通过 `ctx.remoteDevices` 检查精确元组，记录认证存在，拒绝过期的路由 generation 和 epoch，在每次 Host 分发前立即重新检查授权，并在目录撤销设备时立即关闭其活动连接。撤销会丢弃运行中的重放和幂等状态，但保留旧 incarnation 的新鲜度 fence，因此延迟的旧连接不能在同一 id 重新注册后重新激活。

每个远程 API 请求都使用 `invokeApiProxyMethod`，即浏览器 API carrier 使用的同一张经过 schema 检查的分发表。网关为每个设备分别保留已完成的幂等结果，并拒绝用在不同输入上的重试键。批准结果和问题回答会以原始 Host 请求 id 进入 `ctx.apiProxy.respond`，因此当前待处理交互仍归 Host 所有。每次发送响应或事件前，网关都会再次检查当前授权和连接关闭状态；撤销后才完成的结果会被丢弃。每个 carrier write 都收到可变的 `{ active, generation, abortSignal }` close fence，并且只能返回 `committed-before-fence`（最终 fence 检查前本地 carrier 已接受 bytes）或 `not-committed`。网关绝不把前者当作远端送达，且当撤销在提供者解析 write 时关闭 fence，不会把输出记录为已送达。

两个现有 Host 事件流被保留为一个有序的设备 cursor 流。客户端发送不带 `payload.cursor` 的 `device.describe` 以请求 Host 快照（`host.describe`、`session.list` 和 `workspace.list`）；保留的 cursor 请求重放。快照或重放响应先于事件发送。`stream-ack` 只接受不晚于保留尾部的单调 cursor。每个设备的幂等和事件数量由配置限制，以限制运行中 Host 的内存。

`remote-gateway/audit` 发出认证设备 id、路由事实、操作类型、结果和稳定原因。它不发出请求负载、会话内容、凭据、共享秘密或私钥。

## Connection provider requirement

```ts
interface TrustedRemoteConnectionProvider {
  accept(signal: AbortSignal): AsyncIterable<TrustedRemoteConnection>
}
```

每个 `TrustedRemoteConnection` 都标识已认证的 `peer` 公开身份和已认证的 `{ routeId, generation, connectionEpoch }`，接收已解析的 v3 envelope，在提供的 close fence 下发送 v3 envelope，并关闭一个物理连接。提供者拥有双向认证、加密字节、中继路由 token、重连传输和路由轮换。它绝不能产生未认证或明文连接，也不能从本地 socket write 声称 peer delivery。

## Known Limitations and Deferred Work

- 该包已组合，但尚无连接提供者。未来由 Keychain 支持的 Host 身份和加密中继提供者必须显式附加连接。在此之前，它不能接收远程流量。
- 重放和幂等保留被运行中 Host 进程限制。未来的安全保留提供者可以让重试跨 Host 重启保留，而不会将敏感结果复制到公开设备目录。
- 计算机使用的屏幕流和原生计算机控制刻意不包含。它们需要单独的 macOS helper 和明确的操作系统权限模型。
