# dsh-remote-devices

[English](README.md) | 中文

`@deepseek-ai/dsh-remote-devices` 提供由宿主拥有的持久化目录，用于保存被信任为 DSH owner 的远程设备。它在活动宿主存储 backend 中保存公开身份元数据，并提供本地注册、已认证在线记录、列表和立即撤销操作。

## 接口

插件加载后，`RemoteDeviceDirectory` 作为 `ctx.remoteDevices` 提供。`enroll()` 明确是本地宿主策略操作，供未来物理 QR 确认界面调用。它要求有界的不透明设备 id、标签、彼此不同且为规范 base64url 32-byte 的签名与密钥协商公开密钥，以及规范本地注册时间。它会在持久化前拒绝 padding、替代 base64 写法和任何其他 key length。`seed()` 是更窄的 FD199 child-recovery 路径：它接收相同的公开 tuple 加上已签名 Host 已确认的不透明 enrollment incarnation，持久化该精确值一次，并拒绝冲突重试。两种方法都不接受中继 token、密码或远程 HTTP 请求。

每条记录还有由宿主生成的不透明注册 `incarnation`。它不是时间戳或客户端声明：每一次成功注册都会获得新值，包括撤销后使用相同 id 的再次注册。未来已认证提供者必须证明完整、不可变的 `{ deviceId, incarnation, signingPublicKey, agreementPublicKey }` 元组。只有完成该证明后，`markSeen()` 才会记录时间。时间不能倒退。`revoke()` 会立即删除公开记录，因此之后的握手没有可授权的可信设备条目。`remote-devices/changed` 在每一次持久化注册、在线更新或撤销之后发出，且只包含公开元数据。

记录通过 `dsh-storage-domain` 保存在 `remote_devices` 单元。Web 宿主 bundle 将该插件接入现有的 `$DSH_HOME/storages` JSON backend。此包绝不会写入私钥、共享 secret、中继凭据、会话内容或凭据值。

## Known Limitations and Deferred Work

- 注册尚未接入本地 Devices 界面、QR handshake、macOS Keychain 宿主身份、移动端 Secure Enclave 身份、中继连接或远程 API dispatch。该目录本身不会授予网络访问权限。
- 撤销会立即删除当前授权。未来 audit ledger 和签名 revoke 通知属于宿主 remote-connection runtime，而不属于这个公开元数据目录。
