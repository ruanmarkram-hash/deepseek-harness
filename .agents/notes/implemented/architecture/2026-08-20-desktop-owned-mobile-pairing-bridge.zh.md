# Agent Note: 桌面端拥有的移动端配对 bridge

Status: implemented

[English](2026-08-20-desktop-owned-mobile-pairing-bridge.md) | 中文

## 问题

Cloudflare relay 可以创建短时 rendezvous，但若允许渲染出的本地 DSH 页面创建它，就会向不受信任的 Web 内容暴露 relay 凭据路径。桌面端也需要在手机获准接收加密 session frame 之前具有清晰的 lifecycle。

## 决定

[`apps/desktop/src/mobile-pairing.ts`](../../../../apps/desktop/src/mobile-pairing.ts) 是一个仅 Electron 主进程使用的单次 Cloudflare 配对创建器。它的 constructor 接收 build-owned HTTPS relay origin，不接受渲染器提供的值。每次创建会生成彼此独立的 32-byte base64url pairing 与 desktop id，以及独立的 desktop 和 mobile relay credential；它在四分钟后过期，并使用 authorization header 中的 desktop credential 发送精确的第二版创建 body。

Bridge 只在规范的 `dsh-pairing:v2:` bootstrap 中返回 mobile credential，并包含 desktop ephemeral public key、推导出的 `wss:` relay URL 以及固定的 read、subscribe 和 send capability。它的普通 state snapshot 不含任一 credential 或 bootstrap。仅主进程的 desktop connection accessor 只会把 desktop role credential 与 X25519 key 提供给 live transport；推导 directional frame key 后会清除 private key。

[`apps/desktop/src/mobile-live-transport.ts`](../../../../apps/desktop/src/mobile-live-transport.ts) 拥有一个 relay socket 和一个明确选定的现有本地 session。它验证 `mobile-init`，请求 native desktop approval，发送 `desktop-accept`，并使用 protocol package 的有序加密 closed envelope。它的 loopback adapter 只命名 `session.list`、`session.history` 与纯文本 queued `session.prompt`；没有调用方提供的 URL、path、mode、attachment、raw event stream 或 session id。Native picker 只在 Electron 主进程保留真实 session id，并将选定 session 映射成 opaque mobile handle。每个 mobile prompt 都需要独立的 native confirmation，默认拒绝。Mobile cancellation 被刻意禁用，因为本地 runtime 只有 session-wide cancellation，缺少可信的 mobile turn identity 或 ownership boundary；加密的 `cancel-turn` 会被拒绝，并且不会触及本地 DSH。

专用 pairing window 是 sandboxed，并且只有狭窄 preload 用于本地 session alias、开始、关闭、pairing-code display 和非秘密 state。普通 DSH renderer 没有 pairing IPC。`src/mobile-relay-config.ts` 会把唯一受信任的公开 relay origin 编译进 package，因此 Finder launch 不依赖可变的 process environment。任何 socket/local failure、close、expiry、denial 或 revocation 都会清除 connection material 并关闭 pairing，而不会在后台重连。

## 考虑过的替代方案

**从本地 Web renderer 创建配对。** 已否决，因为本地页面没有宿主凭据权限，且由 renderer 发起的创建会削弱 Electron privilege boundary。

**让两个 peer 复用一个 relay credential。** 已否决，因为角色分离的 credential 可阻止 QR 接收方在 relay 创建或连接时冒充 desktop。

**添加通用 mobile DSH API tunnel。** 已否决，因为配对创建器不能成为隐藏的 session 或 computer-control transport。Live transport 保持为 closed text-only adapter。

## 后果

Relay 确认精确的 expiry 后，桌面端即可展示 QR bootstrap；network failure 或 malformed acknowledgment 不会在其普通 state 或 error text 中泄露 credential。Desktop disconnect 现在会撤销 relay authority，并强制未来进行前台 pairing。手机不会收到本地 DSH session id、tool result、filesystem path、credential、setting、workspace data、attachment、raw event 或 computer-use authority。由于 snapshot polling 无法证明本地 turn 属于手机 request，因此它刻意不报告 active mobile turn；composer 不会在已完成的本地 response 后持续锁定。只有本地 runtime 提供可信的 per-turn identity 与 ownership boundary 后，才可恢复 cancellation。该 desktop transport 等待匹配的已部署 v2 relay；不得针对当前 v1 deployment 发布。
