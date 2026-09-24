---
description: "使用调用方管理的套接字认证配对双方并加密有序中继帧。"
kind: "package-library"
---

# dsh-remote-relay-protocol

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-remote-relay-protocol` 通过盲 V3 WebSocket relay 对一个已登记远程设备和一个 DSH Host 进行认证。它不提供 relay deployment、设备登记 endpoint、Host API dispatcher、持久密钥库或 UI。

## 目录

- [Surface](#surface)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="surface"></a>

## Surface

连接开始前，Host 和设备已经知道对方已登记的静态 X25519 public agreement key 以及由 Host 签发的 immutable identity incarnation。设备的 incarnation 会在 re-enrollment 时改变；Host 的 incarnation 标识其当前 protected identity，而不是 device enrollment。每一端提供 `RemoteRelayIdentity.agreement`，即带 public key 和 `deriveSharedSecret(peerPublicKey)` callback 的 protected provider。callback 返回用于立即 KDF consumption 的 fresh shared-secret copy，且从不暴露 private key。每个 handshake 和加密 frame 都认证双方的 device id 与 identity incarnation，因此已撤销或重新登记的 identity 不能通过 stale connection 附着。`connectRemoteRelayDevice()` 发送设备 ephemeral key 和 nonce；`acceptRemoteRelayDevice()` 以 Host ephemeral key 和 nonce 回应。两端从 static-static、static-ephemeral、ephemeral-static 和 ephemeral-ephemeral X25519 值推导方向性 key。加密 `ready`、Host `finish`、device `ack`、Host `commit`、device `confirm` 和 Host `receipt` flight 证明 finality：Host 只会在认证 `confirm` 后调用必需的 durable epoch finalizer，设备只会在认证 finalizer 之后的 `receipt` 后成为 live。每个加密 flight 都将 route id、generation、epoch、device id 和 enrollment id 绑定为 AEAD associated data。ephemeral secret 会在推导后擦除，因此日后 static-key compromise 无法恢复被记录的连接。

已接受的连接只加密和解密精确的 `@deepseek-ai/dsh-remote-wire` envelope。每个 ciphertext 将 route id、generation、connection epoch、sender、recipient 和精确的下一 sequence 作为 authenticated data 绑定。入站 ciphertext 必须是下一个连续 sequence；旧的、跳过的、格式错误的、被改动的或错误 epoch message 都会 fail closed。relay 可以校验并路由相同的外层 message，但无法访问 application envelope 或其 ciphertext plaintext。

调用方提供 cryptographic random source 和小型 `RemoteRelaySocket` adapter。这样 protocol 可用于 Host runtime、browser-compatible mobile runtime、React Native 和 native transport。random source 必须返回 fresh caller-owned buffer：本包会复制并随后 zero 每个返回的 `Uint8Array`，包括 invalid-length result。`connectRemoteRelayDevice()` 和 `acceptRemoteRelayDevice()` 接受 optional `signal`；它会取消每个 pending handshake flight、关闭 socket 并清除 derived key material。caller 必须在 connection resolve 前保留 raw socket close handle。`acceptRemoteRelayDevice()` 需要 idempotent Host epoch finalizer；它必须在函数发送 `receipt` 前持久记录已认证 epoch。新 route 从 epoch 1 开始。Host epoch provider 在 finalization 前返回精确 pending epoch，成功后只返回高一位的 epoch；device 只可接受这两个值，以恢复 finalization 后中断的 receipt。`send(envelope, fence)` 会序列化 close 和 write：只有在最后一次 active-fence check 后本地 WebSocket 接受 bytes 时才报告 `committed-before-fence`。它绝不声称 peer delivery；ambiguous write 会关闭 connection 并报告 `not-committed`。private identity material 属于平台的 protected store；本包只在计算 shared secret 所需的时间内复制它，且从不序列化它。

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- 本包不 mint 或 rotate route capability、不打开 WebSocket、不持久化 identity、不决定 enrollment，也不 dispatch 已解密的 DSH API operation。Host-owned connection provider 提供这些 effect，并在 yield connection 前重新检查 device revocation。
- 它刻意不包含 computer-use video 或 control message。未来的 native macOS helper 需要自己的明确 capability 和 privacy model。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作备注</summary>

无。

</details>
