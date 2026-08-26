# dsh-remote-host-keychain

[English](README.md) | 中文

`dsh-remote-host-keychain` 是供 DSH Host 受保护远程身份使用的 macOS XPC helper。它拥有长期 Ed25519 签名密钥和独立 X25519 协商密钥。其已签名 XPC client 只能打开公开身份，或使用一个 32-byte peer public key 请求一次精确的 X25519 agreement。JavaScript 不会收到私钥值。

helper 会在读取 authorization resource 或访问 Keychain 前验证其封闭的已签名 XPC bundle、严格 code signature 和固定 identifier。它在登录 Keychain 中为每个请求的 Host profile 保存一个二进制 property-list 身份，使用从 helper 已签名 executable 创建的 `SecAccess` trusted-application ACL。因此 Keychain 识别的是 helper 的 designated code requirement，而不是共享的 `/usr/bin/security` 程序。畸形 row、已变更 designated requirement、已变更已签名 resource、无效签名或无效 CryptoKit 密钥都会 fail closed，不会 rekey。

service 还会读取一个经签名 bundle resource，其中只包含唯一获授权 Host client 的 designated requirement、identifier 和 build version。它从规范的 `Contents/XPCServices/DSHRemoteHostKeychain.xpc` 嵌套位置推导 Host app 与 executable，因此整体移动已签名 app 不会使授权失效，也不会持久化 build-machine path。然后它检查 live peer 的精确派生 process path、严格 code requirement、identifier 和 bundle version。macOS 会在 service 看到请求前拒绝其他所有 XPC peer。Host client 必须在 activation 前于自己的 `NSXPCConnection` 上设置 service 的 designated requirement，以便单独注册的 service 无法冒充 bundled helper。executable 没有标准输入协议，直接运行时不会执行签名或协商，因此它不是 same-user signing oracle。

同一 sealed service 还是每条 V3 route 的 epoch coordinator。signed Host connection 可以获取一条 route lease，并进入短暂的 Keychain read-modify-write interval。两者都绑定到已认证的 XPC connection，而不是用户可替换的 filesystem pathname 或导出的 token。显式关闭或 XPC invalidation 都会释放 lease，因此 crash 的 Host 不会遗留 epoch ownership。即使另一 Host 持有 connection lease，revocation 仍可进入短 interval 并持久化 revocation fence；该 owner 的下一次 admission check 会失败。

CryptoKit 在 macOS 上不会将 Ed25519 或 X25519 私钥作为不可导出的 `SecKey` 对象暴露。helper 只在 Keychain row 内保存它们的 raw representation，只在短生命周期的已签名进程中加载，并在退出前完成请求的密码操作。源码会在使用后擦除其拥有的 mutable copy；CryptoKit 内部密钥表示会在进程退出时释放。

## 组装已签名 XPC service

```sh
native/remote-host-keychain/scripts/assemble-xpc-service.sh \\
  --signing-identity "Apple Development: Name (TEAMID)" \\
  --authorized-client /absolute/path/to/signed-dsh-host-client \\
  --output /absolute/path/to/DSHRemoteHostKeychain.xpc
```

组装脚本需要显式非 ad-hoc Apple Development signing identity。它会解析所选 certificate 的 Team ID，然后验证所提供的 Host client 和每个已签名 output 都具有该 Team ID、Apple anchor 和其 designated requirement 中所选 certificate constraint。只有在这之后，它才会读取 client 的精确 designated requirement，将其封存到 service bundle 中，用 hardened runtime 签名 bundle，并验证签名。`assemble-host-owner.sh` 是唯一支持的 deployment path：它将完成的 service 嵌入这个精确的 Host bundle location。

## XPC 方法

sealed Host 可以调用 `openHostPublicIdentity`，它会创建或打开固定的 Host profile 并返回公开身份。它还可以用恰好一个 canonical raw 32-byte X25519 peer key 调用 `deriveHostSharedSecret(withPeerPublicKey:)`。helper 会在回复前派生 secret，并仅返回它的精确 32 bytes；畸形 key、无效 point 或 all-zero result 都不会返回 secret。其他调用仅为已验证 route identifier 的固定 epoch lease 和 transaction admission。这里没有 JSON operation envelope、request identifier、signing method、任意 profile selector、generic derive API、Keychain read API 或 route-token API。

此源码不会把 helper 组合进 Web Host 或安装任何 standalone service。当前 `dsh web` source execution 未签名，不能满足 service 的 client requirement。signed Host 会在每个 XPC connection 上设置 sealed service requirement，并立即将返回的 secret 用于 native KDF。
