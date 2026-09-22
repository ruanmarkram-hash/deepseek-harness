# Agent Note: 无手机时启动托管运行时

Status: implemented

[English](2026-09-23-hosted-startup-without-phone.md) | 中文

## 问题

已恢复且已激活的 ownership journal 确定谁有权服务手机 session，并不表示手机在线。让本地启动等待手机 handshake，会使浏览器可用性依赖无关的网络 deadline，也与显式激活控制项矛盾。

## 决策

Production controller 使用同一个[生命周期 owner](../../../../native/remote-host-app/Sources/RemoteHostApp/HostedRuntimeLifecycle.swift) 管理本地启动、显式激活和 teardown。启动只恢复 child。激活根据保留的 coordinator phase 选择新的 ownership transfer 或 resume。单一 operation reservation 防止并发激活及清理期间的 owner 替换。Stop 分离 pending session，并等待被取消的 operation 完成，包括同步 child 启动，随后才返回。

## 考虑过的替代方案

**延长 timeout 并自动 resume** 仍使本地可用性依赖手机，并改变安全时序，却没有解决 ownership 意图的问题。

**激活失败后重试同一个 child** 会重复使用一次性的 enrollment seed。因此，激活失败会退役 child，但保留已签名 journal、配对 credential 和原生 ledger；再次显式 Start 会恢复未连接手机的 child。

## 影响

启动 hosted Web runtime 不要求手机在线。Stop 可能等待有界启动或 handshake 工作完成清理；期间不允许替代 owner。构造 session 之前的 credential 验证失败会保留可用且未 seeded 的 child。Mobile protocol、handshake deadline、epoch 同步和修复资格规则均保持不变。

## 验证

六个确定性测试通过注入 child 和 phone operation 执行 production 生命周期：恢复与新建激活、handshake 失败及重启、启动与激活取消、并发激活排除，以及修复 reservation 排除。测试断言 Stop 在挂起的工作被释放前保持等待，且迟到工作不能保留 owner。这些测试不能替代已签名 bundle 的浏览器验证或实体手机 handshake。
