# DSH mobile relay

[English](README.md) | 中文

`@deepseek-ai/dsh-mobile-relay` 是用于一次短时、无账户 DSH 手机配对的 Cloudflare Workers 与 Durable Objects 汇合服务。它绝不代理 DSH Web 服务器或 SDK：DSH 仍只在桌面端回环地址运行，且桌面端必须明确接受手机后，任何加密帧才能通过。

## 运行时约定

桌面端以 `Authorization: Bearer <desktopRelayToken>` 创建 `POST /v1/pairings/:pairingId`，并发送完全一致的 JSON 主体：`{ "version": 1, "desktopDeviceId": "…", "mobileRelayToken": "…", "expiresAt": 123 }`。`pairingId` 和 `desktopDeviceId` 是公开不透明标识符。桌面端凭据绝不放入 QR bootstrap；独立的移动端凭据是 bootstrap 的 `relayToken`。两个凭据都不进入 URL、日志或持久化存储。中继生成随机 salt，只持久化单向 `SHA-256(salt + token)` verifier，保存过期和路由元数据，并在过期时间设置 alarm。

桌面端和手机经由 `GET /v1/pairings/:pairingId/connect` 连接，带有 `Upgrade: websocket`。桌面端使用 `dsh-pairing-v1, dsh-desktop.<desktopRelayToken>`；手机使用 `dsh-pairing-v1, dsh-mobile.<mobileRelayToken>`。响应只选择 `dsh-pairing-v1`，绝不回显任一凭据。连接首先发送一个包含 `version: 1` 和其 `pairingId` 的控制对象。

- 桌面端使用 `{ "type": "desktop-hello", "desktopDeviceId": "…" }` 标识自己。
- 手机使用 `{ "type": "mobile-request", "mobileDeviceId": "…", "capabilities": ["session:read", "session:subscribe", "turn:send", "turn:cancel"] }` 请求协议允许列表。
- 中继将该请求转发给在线桌面端。只有 `{ "type": "desktop-accept", "mobileDeviceId": "…" }` 才开始转发。`{ "type": "desktop-revoke" }`、桌面端断开或过期都会发送 `pairing-revoked` 并关闭所有 socket。

接受后，客户端只发送 `@deepseek-ai/dsh-pairing-protocol` relay frame。Durable Object 检查其完全一致的版本化 envelope、桌面/手机方向、单一设备身份、连续的已持久化 sequence counter、64 KiB ciphertext 上限，以及固定的 96 KiB message 和每连接每秒 30 条消息限制。它只将不变的 ciphertext 转发给已连接的接收方，绝不解密、记录、存储、解析、重放或排队该 ciphertext。

移动端 capability 列表是固定的：`session:read`、`session:subscribe`、`turn:send` 和 `turn:cancel`。中继没有用于文件系统访问、凭据、设置、computer-use approval、tool approval、创建 session、附件、原始 DSH event 或通用 API tunnel 的路由。

公开创建路由会在 pairing-room dispatch 前被刻意约束：专用 allocator Durable Object 会在所有 Cloudflare location 中每 10 秒最多允许 20 次创建尝试，而 Cloudflare 边缘 rate limit 允许每个网络地址每分钟最多两次。Worker 会拒绝声明或流式传输中超过 4 KiB 的创建主体。每个配对同时最多接纳一个桌面端和一个移动端 WebSocket，因此每秒 30 条消息的预算属于每个配对角色，而不是无上限 fan-out。这些限制降低了匿名互联网滥用，但不会把无账户中继变成身份服务。

## 验证与部署

运行 `pnpm --filter @deepseek-ai/dsh-mobile-relay run check`、`pnpm --filter @deepseek-ai/dsh-mobile-relay run test` 和 `pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy:dry-run`。测试套件使用 Cloudflare 的本地 Vitest pool 来执行创建、单向存储、桌面端批准、frame forwarding、sequence 拒绝和撤销。最后一条命令会打包并校验 Worker 和 Durable Object 声明，不会发起 Cloudflare API 请求。

`pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy` 需要已认证的 Wrangler 会话，或一个能编辑目标 Worker 和 Durable Object 的最小范围 Cloudflare API token。它不需要运行时 secret 或账户数据库。不要将 Cloudflare token、relay token 或桌面端 pairing bootstrap 放入此仓库或 Wrangler `vars` block。

Worker 名称为 `dsh-mobile-relay`，第一个 Durable Object migration 是 `v1`。将其配置作为 source of truth 部署。后续手机端和桌面端工作必须提供经过审计的 end-to-end encryption、安全的 device-key storage 和 session operation adapter；此中继不创建这些 cryptographic key，也不解释其 payload。
