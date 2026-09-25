# dsh-remote-host-keychain

[English](README.md) | 中文

`dsh-remote-host-keychain` 是嵌入已签名 `DSHHost.app` 的 sealed XPC helper。它在登录 Keychain 中持有长期 Ed25519 signing identity 和独立 X25519 agreement identity。Private key byte 绝不会进入 JavaScript，也不会穿过 XPC interface。

## 已签名 client authorization

helper 会在监听或访问 Keychain 前验证自身 strict code signature 和固定 identifier。其已签名 authorization resource 只包含唯一 Host client 的 designated requirement、bundle identifier 和 build version。helper 从规范的 `Contents/XPCServices/DSHRemoteHostKeychain.xpc` 位置推导 enclosing Host app 和 `Contents/MacOS/dsh-remote-host-app` executable，因此整体移动已签名 app 不会使 authorization 失效，也不会持久化 build-machine path。

每个 connection 都必须匹配精确派生的 live process path、严格 live/static code requirement、Host identifier 和已封存 build version。Host 还会在其 `NSXPCConnection` 上固定 helper 的 designated requirement，防止单独注册的 service 冒充 embedded helper。Symlinked layout、畸形 resource、已变更 bundle、无效签名或未授权 peer 都会 fail closed。

## 固定 operation

XPC interface 只暴露 public identity open、精确 32-byte X25519 agreement、受约束的 FD199 ownership-payload signing，以及 per-route epoch lease 和 transaction call。signing method 只接受两种规范且有界的 FD199 ownership payload form；它不是通用 signing oracle。这里没有 JSON operation envelope、任意 profile selector、Keychain read operation、route-token operation，也没有 generic signing 或 agreement API。

FD199 signing 在打开受保护 identity 前验证完整 payload。Payload 上限为 2 MiB，与生产 journal 上限一致，并且必须精确重现规范的 version-2 或 version-3 export 或 activation byte。Export validation 保留 8,192-file 和 128 MiB aggregate limit、version-2 的 8 MiB file limit，以及 version-3 的名称唯一性要求。验证器检查精确字段、有界整数、名称和 digest；重复 JSON key、非规范编码及不支持的版本都会被拒绝。获准 byte 原样签名，保留现有 version-2 proof。

Epoch ownership 绑定到已认证 XPC connection，而不是 pathname 或导出 token。显式关闭和 XPC invalidation 会在 crash 后释放 lease。即使另一 Host 持有 connection lease，revocation 仍可获取短暂的 serialized Keychain transaction，使 durable revocation fence 拒绝该 owner 的下一次 admission check。

## Keychain 行为

helper 创建 identity row 时使用从其已签名 executable 派生的 `SecAccess` trusted-application ACL。畸形 row、已变更 designated requirement、已变更 public/private-key relationship 或无效 key 都会 fail closed，不会 rekey。本源码持有的 mutable copy 会在使用后清零。

Host 的 relay credential store 遵循相同 ACL-preservation rule。初次创建提供 `kSecAttrAccess`；重复 provisioning、route、cleanup 和 epoch write 只更新 `kSecValueData`。读取、重复更新和删除使用禁止 interaction 的 authentication context，因此意外 authorization requirement 会返回失败，而不会打开 SecurityAgent。

[Host package README](../remote-host-app/README.zh.md) 说明 pairing、activation、reconnect、restart 和 revoke 行为。[远程配对发布 cookbook](../../docs/cookbook/releasing-dsh-remote-pairing.zh.md) 和 [hosted runtime packaging reference](../remote-host-app/docs/hosted-runtime-runbook.md) 是 assembly 与 release operation 的权威来源。
