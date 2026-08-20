# Agent Note: 移动端配对密钥确认

Status: implemented

[English](2026-08-20-mobile-pairing-key-confirmation.md) | 中文

## 问题

无账户配对 rendezvous 需要让桌面端和手机在 relay 允许 session traffic 之前证明它们导出了相同的新鲜 secret。QR relay credential 只证明可访问 rendezvous，不能证明目标桌面密钥或 peer。

## 决定

[dsh-pairing-protocol](../../../../packages/mobile/pairing-protocol/README.md) 使用版本二的临时 X25519 密钥确认。桌面端 QR 绑定规范的 32 字节公钥。手机发送新的公钥和 XChaCha20-Poly1305 mobile-init proof。HKDF-SHA-256 从 X25519 shared secret 与一个绑定 identity、公钥、版本、pairing id 和请求能力的 transcript 导出每个 proof key。桌面端在明确批准前验证该 proof，然后返回 desktop-accept proof。手机在打开可撤销的本地 application-frame gate 前验证该 proof。

在本地确认之后，包会从同一份已绑定的 transcript 派生方向分离的 XChaCha20-Poly1305 会话信封密钥。每个 frame 都认证其中继路由字段，并且必须是该方向下一个连续的序列号。其封闭的明文 grammar 仅限文本：桌面端到手机端携带快照、文本增量、轮次状态和安全错误；手机端到桌面端只携带文本提交与轮次取消。活跃 private key、方向密钥和序列状态只在前台活跃配对期间保留于内存。`destroyPairingEphemeralKeyPair()` 和 `MobileSessionCipher.erase()` 会在关闭、过期或撤销时清除 secret 并撤销本地确认。

每个平台注入 randomness。共享模块没有默认 random provider、network client、secret storage、已接入的应用，或批准手机的权限。它不会选择 DSH 会话、连接实时桌面端或手机端会话，或授权通用 DSH API。

Cloudflare relay 校验精确 control 字段和 proof bounds，但把两个 proof 作为不透明值转发。它从不存储 proof、plaintext、raw token 或 application ciphertext。它仅在 desktop-accept 后允许 frame，而每个 endpoint 仍负责本地 proof verification。该决定部分取代了 [无账户移动端配对词汇](2026-08-20-accountless-mobile-pairing-protocol.md) 中把 cryptography 延后的内容；无账户归属、固定能力和不透明 relay routing 不变。

## 考虑过的替代方案

**仅使用平台 WebCrypto。** 已否决，因为 Electron 和 Expo 需要一致、可审阅的行为，不能依赖不同的 subtle-crypto adapter 或平台 key-format 差异。

**由 relay 验证 proof。** 已否决，因为它需要 relay 拥有或导出 pairing secret，会使 rendezvous 成为 security authority。

**没有返回 proof 的 acceptance。** 已否决，因为手机无法以密码学方式确认接受方拥有 QR 绑定的 desktop key。

## 后果

该协议增加了三个固定版本的纯 JavaScript dependency：Noble curves、hashes 和 ciphers。确定性 vector 固定了 key、transcript、nonce、ciphertext、tamper rejection、gate revocation、secret erasure、方向加密、路由认证、replay rejection 和封闭消息行为。桌面端和移动端集成仍必须把已验证的仅限前台信封连接到一个由桌面端选择的 DSH 会话的安全适配器；本 note 不授权计算机使用、文件系统访问、凭据、workspace 访问、创建会话、附件、任意会话访问或通用 remote DSH API。
