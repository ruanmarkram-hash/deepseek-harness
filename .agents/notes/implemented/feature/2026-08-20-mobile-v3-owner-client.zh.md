# Agent Note: 移动端 V3 owner 客户端

Status: implemented

[English](2026-08-20-mobile-v3-owner-client.md) | 中文

## 问题

首个手机客户端是连接单个 Desktop 所选会话的前台 V2 bridge。它无法与浏览器共同使用同一个长期 Host、创建 Host 会话、保留已认证重连状态，也无法区分本地忘记和 Host 撤销。

## 决策

DSH Mobile 是 V3 Host owner 客户端。其原生模块把独立 Ed25519 签名身份和 X25519 协商身份保存在要求用户在场且仅限本设备的 iOS 钥匙串 item 中。TypeScript 只接收公开身份和协商操作，绝不接收私钥字节。Expo Go 不含该模块，因此需要自定义原生构建或 TestFlight 构建。

应用同时支持物理本地传输和互联网配对。互联网配对会扫描或接受已签名 Host 显示的短期 `dsh3` 代码，把精确公开手机 offer 发送到固定 relay origin，在 Host 批准期间保持显示指纹，并且只用受保护手机身份解密返回邀请。严格邀请绑定路由、设备凭据、Host agreement pin、两个注册 incarnation、预期设备密钥、过期时间和确切下一 epoch。相机权限只用于配对代码，仍可手动输入代码。

一个已验证邀请、持久事件 cursor 和下一 epoch 存储在不渲染的原生钥匙串记录中。导入不会打开连接。显式用户操作会打开生产 V3 socket，并且只在双向认证和加密 Host commit 完成后报告已连接。应用列出并创建会话，投影 Host snapshot 和有序事件，并发送文本提示，不会虚构本地消息或持久化已渲染对话内容。

进入后台、断开连接、畸形 traffic 或替换 transport 都会关闭物理 socket 并清除内存中的在场会话。只有旧 transport 已退出后才允许显式重试，并且只使用 Host 签发的确切下一 epoch。**Forget invitation** 会清除本地钥匙串路由、epoch、cursor 和投影，但不会撤销 Host 路由。Host 撤销会使路由失效并要求重新配对。

## 验证

聚焦 TypeScript 测试覆盖严格邀请和配对代码解析、加密互联网邀请传输、持久状态串行化、确切 epoch 重连、abort 与 socket 退出竞争、snapshot 与 replay cursor 顺序、请求分派和忘记行为。原生 Swift 测试覆盖受保护身份生命周期和在场会话清除。生产验收还要求已处理 TestFlight 构建在实体 iPhone 上通过与已公证 Host 不同的网络运行。

## 考虑过的替代方案

**保留 V2 Desktop bridge。** 拒绝，因为单个 Desktop 所选前台会话无法实现共享持久 Host owner 模型。

**直接连接公开 Host HTTP endpoint。** 拒绝，因为这会绕过 relay 角色凭据、Host pin、精确 epoch 和加密 remote wire。

**把 X25519 钥匙串密钥称为 Secure Enclave 密钥。** 拒绝，因为 iOS 不提供 Secure Enclave X25519 密钥类型；实现采用更窄且准确的钥匙串声明。

**让忘记操作撤销 Host。** 拒绝，因为删除手机本地状态和持久 Host 授权是两个具有不同失败与恢复语义的操作。

## 后果

手机可以通过相机或代码配对、显式重连、使用共享浏览器 Host，并忘记本地邀请。它仍只在前台运行，没有本地 fallback 对话，也不提供 macOS computer-use 捕获或控制。分发声明要求 TestFlight 可用，并通过完整的不同网络提示、重连、重启、撤销和忘记矩阵。
