---
description: "使用受保护的原生 Host 签名和密钥协商身份而不暴露私钥。"
kind: "package-reference"
---

# dsh-remote-host-identity

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-remote-host-identity` 定义了长期 Ed25519 签名身份和独立 X25519 密钥协商身份的 Host facade。已签名的原生 provider 持有私钥；JavaScript 只会收到受保护的 handle，绝不会收到私钥字节、`$DSH_HOME` 记录、设备目录条目或日志值。

## 目录

- [接口](#surface)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="surface"></a>

## 接口

当已签名的原生 Keychain provider 组合本包后，`ctx.remoteHostIdentity` 会返回公开 Host 元数据、签署已经绑定 transcript 的 payload，并从一个已验证的 X25519 远程公开密钥派生 shared secret。调用方必须立即把该 secret 交给 KDF，不得持久化或记录它。

`ctx.remoteEnrollment.issueRoute()` 会为未来本地 QR 交换创建有效期五分钟的 route id，以及不同的 Host 与 client relay token。它只在进程内保存最多 32 个完全一致的 route，直到过期或一次 `confirm()` 消耗其中一个，并把复制的已本地确认远程公开身份传给 `ctx.remoteDevices.enroll()`。本包不会写入 route token，也不会创建 HTTP endpoint、QR 界面、relay request 或远程注册 listener。

本包不附带 Keychain 实现，Web Host 也不会挂载它。未来的已签名 provider 必须在自身受限制的 macOS access policy 下创建和使用受保护的密钥，在状态缺失或损坏时 fail closed，并且只暴露这个受保护的 handle。

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- **Host Devices UI and QR exchange** — a local UI must display and transfer the ephemeral enrollment route before a phone can be confirmed; this package exposes only the Host-local controller API.
- **Signed native Keychain provider** — shipped Web Host 不会挂载本包。任何 Host 拥有远程连接前，都需要带限制性 application access policy 的已签名 helper。
- **Authenticated relay and encryption runtime** — the controller mints relay-ready values but does not transmit them. The remote connection runtime owns mutual authentication, KDF use, ciphertext transport, reconnect, and revocation enforcement.

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作备注</summary>

无。

</details>
