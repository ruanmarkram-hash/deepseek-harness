# Agent Note: 钥匙串 Host 远程身份

Status: implemented

[English](2026-08-20-keychain-host-remote-identity.md) | 中文

## 问题

持久 DSH Host 需要不受浏览器和 Desktop 生命周期影响的签名与协商密钥，同时不能把远程私有身份放在会话、公开设备 metadata、relay 凭据或 JavaScript 旁边。

## 决策

`native/remote-host-keychain` 是密封在 `DSHHost.app` 内的 XPC service。它在登录钥匙串中持有独立 Ed25519 签名私钥和 X25519 协商私钥，只暴露 typed public-identity、签名、精确 32-byte 协商及路由 epoch 协调调用。私钥字节绝不离开 helper，API 不含通用 operation、任意 profile、钥匙串读取或 route-token surface。

helper 从固定的 `Contents/XPCServices/DSHRemoteHostKeychain.xpc` 位置推导外层 Host app 和 executable。其已签名授权资源包含 Host identifier、version 和 designated requirement，但不包含构建机器路径。helper 在接受连接前验证完整已签名 bundle、精确规范嵌套、推导出的 Host 路径、实时 peer 路径、metadata 和严格 code requirement。Host 反向固定 helper 的密封 service requirement。因此，在受支持规范安装位置之间移动完整已签名应用仍保留授权，而 symlink、修改后的资源、替换的 binary、无效签名或不同 peer 都会失败关闭。

已签名 Host 使用 helper 获取公开 Host 身份、执行即时原生 KDF、生成钥匙串绑定 FD199 proof，并持有崩溃可回收的路由 epoch lease 和 transaction。JavaScript 只通过继承的有界 Remote Wire descriptor 接收公开注册和已认证 connection fact。普通源码启动的 `dsh web` 不是授权 XPC peer。

## 验证

聚焦 Swift 测试覆盖身份创建竞争、公钥分离、X25519 协商、损坏记录拒绝、精确迁移推导、规范嵌套、symlink 拒绝、epoch lease 恢复和撤销 fence。组装与私有运行时 smoke 检查会拒绝含路径的授权资源，验证双向 designated requirement 和完整应用 seal，在启动前迁移已组装应用，并拒绝未授权 peer 与被篡改的已签名资源。

## 考虑过的替代方案

**把 Host 私钥存入 DSH storage domain。** 拒绝，因为普通 Host store 包含产品数据和公开设备事实，不是 macOS 受保护身份材料。

**用同一个密钥完成签名与协商。** 拒绝，因为 Ed25519 认证和 X25519 协商具有不同目的与密钥类型。

**使用命令行 helper 或 Electron client。** 拒绝，因为同一用户调用者可把 CLI 变成 oracle，而 Electron 不拥有持久 Host 生命周期。

**把绝对构建路径密封进授权。** 拒绝，因为有效发布必须作为一个完整已签名应用迁移后仍可运行，且不能信任其构建目录。

## 后果

受保护身份和 epoch 权威只能通过严格校验的已签名 Host/XPC 对使用。发布打包必须把 helper 保持在固定嵌套位置，保留完整应用 seal，并在公证前通过迁移 smoke。登录用户可替换其拥有的 `~/Applications` 安装，因此安全声明是从其他进程隔离已签名代码，而不是防护拥有该账户的人。
