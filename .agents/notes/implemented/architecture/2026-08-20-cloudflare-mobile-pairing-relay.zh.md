# Agent Note: Cloudflare mobile pairing relay

Status: implemented

[English](2026-08-20-cloudflare-mobile-pairing-relay.md) | 中文

## Problem

无账户移动端词汇需要一个可达的 rendezvous service，但 DSH session、permission、credential 和 computer-use authority 必须留在桌面端。能看到 plaintext 或在桌面端撤销后仍存活的 relay 会成为远程 control plane。

## Decision

[`apps/mobile-relay/`](../../../../apps/mobile-relay/README.md) 为每个公开 pairing id 使用一个 Cloudflare Durable Object。Worker 会在 object dispatch 前过滤 path 和 request structure。它使用仅限桌面端的凭据接纳桌面端，并使用独立的 QR 移动端凭据接纳手机，然后只保存带 salt 的单向 verifier、五分钟 expiry、route identity、mobile capability request 和每个 direction 的 sequence counter。它不保存 QR token 或 ciphertext。

WebSocket connection 使用 Durable Object hibernation attachment 保存 peer identity 和 rate-window state。桌面端先标识自己，移动端请求固定 allowlist，只有明确的桌面端接受才能启用 frame forwarding。object 验证共享 relay envelope、recipient direction、严格连续 counter、message size 和 rate limit，而不解密 ciphertext。桌面端断开、桌面端撤销和过期会关闭所有 socket 并抹除 pairing state。

公开边缘会在 room dispatch 前拒绝超过 4 KiB 的流式创建主体，并施加每网络创建限制。专用 allocator Durable Object 提供全局创建预算。一个 pairing 只允许一个桌面端和一个移动端 connection，从而使每角色 message budget 和 socket scan 保持有界。

## Alternatives considered

**通用 remote DSH API proxy。** 被拒绝，因为它会让 relay 成为本地 DSH authority 的第二个 owner，并暴露超出手机 session client 范围的 privileged route。

**relay-visible session protocol。** 被拒绝，因为 plaintext session data、prompt 和 result 会让 relay 成为持久 data owner。

**长期 mobile bearer token。** 被拒绝，因为带有桌面端确认的短期 QR rendezvous 限制了被捕获 bootstrap token 的影响。

## Consequences

Worker 不需要 runtime secret 或 user account database，idle socket 可以 hibernate 而不丢失 connection identity。桌面端断开、撤销或过期后，手机必须重新配对。桌面端和 Expo application 仍拥有经过审计的 encryption、key verification、secure storage，以及将固定 mobile capability 映射到安全 DSH session operation 的职责。
