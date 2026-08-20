# DSH mobile relay

[English](README.md) | 中文

`@deepseek-ai/dsh-mobile-relay` 是用于一次短时、无账户 DSH 手机配对的 Cloudflare Workers 与 Durable Objects rendezvous。DSH 留在桌面端。中继没有通往 DSH web server、SDK、计算机使用权限、凭据、文件系统或通用 API 的 route。

## 运行契约

桌面端以独立 bearer credential 创建 `POST /v1/pairings/:pairingId`，并发送精确的版本二 JSON：桌面 id、规范的 32 字节 `desktopEphemeralPublicKey`、移动端 relay credential 和过期时间。中继校验但不保留该公钥。它只存储加盐单向 token verifier、过期时间、桌面路由 id、移动端 id 与能力请求，以及 frame sequence counter。它从不存储原始 credential、加密 proof 或 application ciphertext。

桌面端和移动端使用精确的 `dsh-pairing-v2` WebSocket subprotocol 和带角色的 token subprotocol 连接。桌面端先发送 `desktop-hello`。手机随后发送 `mobile-init`，其中有其公钥和不透明的加密 proof。中继在不改变对象的前提下校验大小、id、能力名称和规范 encoding，并将其转发给在线桌面端。桌面端必须验证 proof 并明确批准，然后发送不透明的 `desktop-accept` proof。中继将该 acceptance 原样转发给手机，再允许有界的不透明 frame。

Durable Object 仍校验一个桌面端和一个移动端连接、peer direction、持久化连续 sequence、64 KiB frame ciphertext、96 KiB message 和每秒 30 条 message。它不解密、记录、持久化、重放、变换或排队 proof 或 frame。桌面端断开、桌面端 revoke 和过期会关闭所有 socket 并删除配对状态。手机必须在发送 application frame 之前本地验证桌面端 proof。

## 验证与部署

运行 `pnpm --filter @deepseek-ai/dsh-mobile-relay run check` 和 `pnpm --filter @deepseek-ai/dsh-mobile-relay run test`。 `pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy:dry-run` 只 bundle，不发出 API request。部署需要已认证的 Wrangler session 或窄权限 Cloudflare token。不要把 Cloudflare、relay、QR 或桌面 credential 放入 source、log 或 Wrangler variable。
