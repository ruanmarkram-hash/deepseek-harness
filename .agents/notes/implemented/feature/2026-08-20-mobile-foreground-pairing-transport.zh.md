# Agent Note: Foreground mobile pairing transport

Status: implemented

[English](2026-08-20-mobile-foreground-pairing-transport.md) | 中文

## Problem

移动端伴侣需要实时继续一个 DSH 桌面端会话，但不能成为本地执行、操作系统权限、凭据、文件或 workspace 变更的另一授权方。视觉壳或从手机直连桌面端都无法安全建立这种有限权限。

## Decision

`apps/mobile/transport.ts` 拥有一个仅内存的配对尝试。它解析一个粘贴的版本二 bootstrap，只接受编译进应用的 Cloudflare relay origin，使用 Expo Crypto 的原生 CSPRNG 创建新的 X25519 移动端密钥和不透明 device id，并打开角色绑定的 `dsh-pairing-v2` WebSocket。它发送 `mobile-init`、验证 `desktop-accept` 中的桌面端 proof，然后创建定向加密 session envelope。应用只接受共享 protocol 的 desktop-to-mobile session vocabulary，并且在此仅前台版本中只发送文本提交 vocabulary。

`apps/mobile/App.tsx` 明确展示桌面端接受、连接状态、选定会话可用性、prompt 批准和断开连接状态。它没有示例对话或本地已配对预览。后台切换、过期、socket 结束、relay 拒绝、畸形 traffic 或用户断开连接都会关闭 transport 并清空 UI session。

由于固定生产 relay 已完成版本二 cutover 且 health check 成功，`MOBILE_RELAY_V2_DEPLOYED` 为 true。对于有效且新鲜的桌面端 bootstrap，transport 可以打开固定 origin 的 socket；但 UI 仍只有在桌面端以密码学方式接受手机后，才会将远程会话描述为实时状态。

## Data lifetime and authority

原始 QR 字段会在解析后清空。bootstrap、移动端 relay bearer、临时 secret、confirmation 和 session cipher 只保留在进程内存中。每条终止路径都会关闭 socket、通过共享 protocol 将 key material 清零、撤销 cipher，并丢弃 bootstrap reference。应用不会恢复、重连或持久化配对。

桌面端选定唯一会话并明确批准每个移动端文本提交请求。移动端只接收安全的 text session snapshot、delta、turn state 和安全 error。它没有通往 computer use、tool approval、文件、凭据、workspace 或设置变更、附件、任意会话创建、取消、相机访问或通用桌面端 API 的路径。取消功能被移除，因为会话级取消请求没有可信的本地 DSH run identity，可能会取消不相关的桌面端 turn。它只会在具备真实 run-identity 设计后恢复。

## Alternatives considered

**保留断开连接的预览。** 带标签的预览有助于早期界面工作，但不能验证接受、会话新鲜度、replay protection 或 prompt 权限。实时应用改用如实的空状态和等待状态。

**从手机直连桌面端。** 直接可达性会引入额外的认证、网络暴露和凭据生命周期系统。短时 relay 仍是唯一的 rendezvous。

**持久化 QR credential 或 session cipher。** 持久化会把前台伴侣变成持久的移动端授权方，并使陈旧 session data 看起来能够恢复。每次终止切换后重新配对能保持清晰的桌面端所有权。

**保留会话级取消。** 本地 DSH 会话没有可信的 run identity，因此取消可能会针对不相关的桌面端 turn。仅前台版本会移除该功能而不是猜测；后续的 run-identity 设计可以安全地重新加入它。

**添加相机扫描。** 相机权限会添加设备能力，却不改变配对 protocol。手动粘贴在相机工作获得独立的有界决策和审查前仍然足够。

## Consequences

手机只能在前台运行且桌面端保持连接时继续选定的文本会话。这会失去重连便利，并要求用户在后台切换后重新配对，但它消除了静默 credential 保留，并在不确定的 transport state 中安全失败。官方 DeepSeek mark 出现在移动端图标表面，而面向用户的产品仍为 DSH。
