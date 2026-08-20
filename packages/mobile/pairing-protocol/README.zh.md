# dsh-pairing-protocol

[English](README.md) | 中文

`@deepseek-ai/dsh-pairing-protocol` 是版本二的无账户配对、密钥确认和仅限前台的加密会话信封库，供 Electron 桌面端、Expo 手机端和 Cloudflare 中继共同使用。它提供协议原语，不是已连接的实时应用。

## 接口

桌面端创建新的 X25519 密钥对，并且只把其规范的 32 字节 base64url 公钥放入短时 `dsh-pairing:v2:` QR bootstrap。QR 还包含公开的配对和桌面 id、固定移动端能力集、`wss:` 中继 URL、过期时间和仅供手机使用的中继凭据。桌面端中继凭据和所有临时私钥都不进入 QR。

手机端通过注入的 `PairingRandomSource` 创建自己的 X25519 密钥对，然后发送精确的 `mobile-init` control，其中包含其公钥、允许的请求能力，以及有界的 nonce 前缀 XChaCha20-Poly1305 proof。proof 密钥由 X25519 shared secret 和 HKDF-SHA-256 导出，其 transcript 绑定协议版本、配对 id、两个设备 id、两个公钥和能力。桌面端在明确批准前验证该 proof，然后发送同样绑定的 `desktop-accept` proof。手机端在打开本地 application-frame gate 前验证它。

在本地 proof 验证成功后，`createMobileSessionCipher()` 会为桌面端到手机端和手机端到桌面端的信封分别导出仅存于内存的 XChaCha20-Poly1305 密钥。每个信封都会认证不可变的中继路由字段，只接纳该方向中下一个连续的序列号，并在关闭时清除两把方向密钥。明文 grammar 是封闭且仅限文本的：桌面端到手机端只允许 `session-snapshot`、`text-delta`、`turn-state` 和 `error`；手机端到桌面端只允许 `send-text` 和 `cancel-turn`。快照数量和所有文本字段都会在加密前或解密后受到边界限制。

中继校验字段界限并原样转发 control 和不透明 frame，不能解密 proof 或 frame。桌面端 acceptance 是中继转发 frame 的必要条件，而客户端在创建或打开会话 cipher 前必须验证对应 proof 并调用 `confirmPairingKey().requireConfirmed()`。这是仅限前台的传输基础：活跃 secret、方向密钥和序列状态只保留在进程内存中。在关闭、过期或桌面端撤销时调用 `destroyPairingEphemeralKeyPair()` 并清除 cipher，后者会撤销确认。

唯一的移动端能力是 `session:read`、`session:subscribe`、`turn:send` 和 `turn:cancel`。该包没有计算机使用、文件系统、凭据、workspace、管理、创建会话、附件或任意会话访问能力。

## 限制

该包没有 WebSocket client、安全存储 provider、用户批准 UI、已接入的桌面端或移动端应用，或 DSH session gateway。它不会选择会话、把轮次发送给 DSH、接收实时 DSH stream、在后台重连，或暴露通用 DSH API。桌面端和移动端集成必须提供平台 CSPRNG adapter，只在内存保留活跃 secret，在 application traffic 之前验证 proof，并把固定允许列表映射到一个由桌面端选择的会话的安全操作。中继永远不会成为通用 DSH API proxy。
