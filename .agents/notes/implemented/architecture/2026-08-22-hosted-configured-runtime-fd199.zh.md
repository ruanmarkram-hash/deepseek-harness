# Agent Note: 托管已配置运行时采用 FD199 提供共享单 Host 服务

Status: implemented

[English](2026-08-22-hosted-configured-runtime-fd199.md) | 中文

## 问题

手机可以对原生路由完成认证，但仍无法使用浏览器所用的已配置 `dsh web` 模型、会话、审批和事件流。loopback API 无法证明所有权，运行另一个 session core 又会拆分 Host 状态。

## 决策

已签名 Host 使用两个继承的私有 socketpair descriptor 启动已配置 Web 运行时：198 携带已认证 V3 连接，199 携带所有权权威。`apps/cli` 只接受精确的尾部 `--private-relay-fd 198 --private-authority-fd 199` 约定，在产生 boot effect 前验证两条 descriptor 都是 socket，从应用参数中移除该后缀，并挂载 FD199 和 V3 overlay。普通 `dsh web` 启动不带任一 descriptor，并保持既有 composition。

descriptor 199 使用有界、带长度前缀的严格 JSON，具有方向专用 vocabulary 和重复键拒绝。子进程证明 ready、恢复原生日志、导出经过 digest 验证的会话工件、排空并释放 store 所有权、退出，然后允许新子进程消费一次已签名激活。原生权威通过 no-follow 相对文件系统操作持有 journal，使用受保护 Host 身份签署规范 export 和 activation proof，并拒绝篡改、重放、symlink 或乱序状态。

`CurrentWebFd199Lifecycle` 在所有权迁移期间 fence 浏览器写入，同时保留读取侧事件流。激活后的子进程消费已签名 journal 后，`RemoteHostV3Controller.startWithNative()` 把 descriptor 198 绑定到同一个已配置进程、store、模型、会话、审批和事件。原生 Host 保留路由凭据和私钥操作；子进程只接收公开路由和已认证 connection fact。

## 验证

聚焦 TypeScript 与 Swift suite 覆盖精确 launcher overlay 解析、socket 验证、protocol 上限、重复键拒绝、journal compare-and-set 与恢复、proof 篡改拒绝、store quiescence、子进程回收、两代 prepare 与 activate choreography，以及延迟 descriptor-198 挂载。发布指南还要求已迁移的签名 Host 在公证前创建并提示浏览器会话，然后由不同网络的 TestFlight 手机证明同一个 Host。

## 考虑过的替代方案

**使用 loopback Web API 作为接管通道。** 拒绝，因为 loopback 可达性不能认证已签名 Host 或授予 store 所有权。

**运行单独的固定会话手机 Host。** 拒绝，因为这会把模型、会话、审批和存储从浏览器 Host 拆开。

**在并发 owner 之间复制会话状态。** 拒绝，因为并发写入者和复制字节无法提供单 owner 持久性保证。

## 后果

浏览器和手机在一次显式已签名所有权迁移后共享同一个已配置 Host。导出总量上限为 128 MiB，单会话工件上限为 8 MiB，首版 adapter 不导出附件。同 store 采纳避免复制这些省略工件。该路径依赖已签名原生 supervisor，不能由只提供自身 socket descriptor 的源码进程激活。
