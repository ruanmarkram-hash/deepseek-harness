# DSH 移动端 relay

[English](README.md) | 中文

`@deepseek-ai/dsh-mobile-relay` 是用于 DSH 手机配对和加密远程 transport 的 Cloudflare Workers 与 Durable Objects 盲转发会合点。DSH 留在 Host 上。relay 无法访问 DSH Web server、SDK、computer-use 权限、凭据、文件系统或通用 API。

## V3 路由约定

已签名 Host 使用仅 Host 持有的凭据创建、轮换和撤销一个私有路由。Durable Object 只存储 Host 和设备角色凭据的加盐单向 verifier，以及公开路由 metadata、generation、过期时间和有界握手状态。它绝不存储私钥、shared secret、明文应用消息或可用路由凭据。

Host 和手机只能使用 `dsh-remote-v3` 以及角色绑定凭据 subprotocol 连接 `/v3/routes/:routeId/connect`。relay 在转发不透明握手或密文消息前验证确切路由、generation、epoch、角色、方向、消息 vocabulary、大小和 sequence。它不能完成密码学握手、解密 frame、声称 peer delivery 或授权 DSH 操作。轮换和撤销会立即关闭两端并使旧凭据失效。成功删除路由返回 `204`；路由 metadata 已不存在时的重试返回 `404` 缺失路由结果，供 Host 的持久撤销恢复使用。

已认证的 Host socket 可等待手机首个有效 hello 最多 125 秒，即原生 Host 的 120 秒会合预算加五秒 relay 调度余量。未绑定的设备 socket 仍在 30 秒后过期。首个被接受的 hello 启动保持不变的 30 秒密码学握手预算，其中包括尚未发送 welcome 的 Host。alarm、转发前过期检查和过期连接所有者替换使用相同的角色特定截止时间；有效状态转换会重新计算最早的 alarm。这些等待不会放宽认证、独占对端所有权、撤销或 epoch 验证。

## 互联网配对约定

`/v3/pairings/:pairingId` 提供独立的短期 QR 或文本代码会合点。它接受一个公开手机注册 offer，只向持有代码的 Host 暴露该 offer，并且只返回由 Host 加密给该手机受保护身份的邀请。配对对象存储代码 verifier 以及有界公开值或加密传输值；它不是路由 relay，也绝不接收活动 Host 路由凭据。offer、批准、获取、确认、过期和重放都采用失败关闭。

## V2 兼容性

隔离的 `/v1` surface 保留版本二桌面配对约定。桌面端和移动端使用精确的 `dsh-pairing-v2` WebSocket subprotocol 及角色绑定凭据。relay 转发 `mobile-init`、`desktop-accept` 和有界不透明 frame，不会解密、记录、持久化、重放或变换 proof 或应用密文。桌面断开、撤销或过期会关闭 socket 并删除配对状态。

## 验证与部署

运行 `pnpm --filter @deepseek-ai/dsh-mobile-relay run check`、`pnpm --filter @deepseek-ai/dsh-mobile-relay run test` 和 `pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy:dry-run`。部署需要已认证 Wrangler 会话或最小范围 Cloudflare token。已检入的生产自定义域路由不含秘密。绝不将 Cloudflare、relay、配对、Host 或设备凭据放入源码、日志、URL 或 Wrangler 变量。

生产部署顺序和实体设备验收矩阵见[远程配对发布指南](../../docs/cookbook/releasing-dsh-remote-pairing.zh.md)。
