# Agent Note: 桌面端拥有的移动端配对 bridge

Status: implemented

[English](2026-08-20-desktop-owned-mobile-pairing-bridge.md) | 中文

## 问题

Cloudflare relay 可以创建短时 rendezvous，但若允许渲染出的本地 DSH 页面创建它，就会向不受信任的 Web 内容暴露 relay 凭据路径。桌面端也需要在手机获准接收加密 session frame 之前具有清晰的 lifecycle。

## 决定

[`apps/desktop/src/mobile-pairing.ts`](../../../../apps/desktop/src/mobile-pairing.ts) 是一个仅 Electron 主进程使用的单次 Cloudflare 配对创建器。它的 constructor 接收一个固定的 HTTPS relay origin，不接受渲染器提供的值。每次创建会生成彼此独立的 32-byte base64url pairing 与 desktop id，以及独立的 desktop 和 mobile relay credential；它在四分钟后过期，并使用 authorization header 中的 desktop credential 发送精确的第一版创建 body。

Bridge 只在内存中保留 desktop credential。它只在规范的 `dsh-pairing:v1:` QR bootstrap 中返回 mobile credential，并包含推导出的 `wss:` relay URL 和固定的 session read、subscribe、send-turn 与 cancel-turn capability list。它的 snapshot 不含任一 credential 或 QR value。`idle`、`creating`、`ready` 与 `failed` state 会拒绝并发创建，并会在关闭时清除保留的 desktop credential。

Bridge 不打开 WebSocket，也没有 renderer IPC、session projection、DSH API proxy、tool approval、file、workspace、credential、settings 或 computer-use 行为。它只是一个宿主拥有的创建边界；key verification、end-to-end encryption、明确的 desktop acceptance 和安全的 session operation adapter 都在其范围之外。

## 考虑过的替代方案

**从本地 Web renderer 创建配对。** 已否决，因为本地页面没有宿主凭据权限，且由 renderer 发起的创建会削弱 Electron privilege boundary。

**让两个 peer 复用一个 relay credential。** 已否决，因为角色分离的 credential 可阻止 QR 接收方在 relay 创建或连接时冒充 desktop。

**添加通用 mobile DSH API tunnel。** 已否决，因为在受限的 mobile capability adapter 存在之前，配对创建器不能成为隐藏的 session 或 computer-control transport。

## 后果

Relay 确认精确的 expiry 后，桌面端即可渲染 QR code；network failure 或 malformed acknowledgment 不会在其 state 或 error text 中泄露 credential。由于该 bridge 刻意尚未打开撤销所需的 desktop WebSocket，创建的 relay room 在本地关闭后仍可能存在至其短时 expiry。未来的宿主工作必须通过 relay 的 role-bound WebSocket 使用保留的 desktop credential，请求明确的本地 device approval，并将经过审计的加密 payload 绑定到固定的 mobile operation set。
