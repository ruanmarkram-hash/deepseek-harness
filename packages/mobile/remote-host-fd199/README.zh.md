---
description: "通过继承的描述符 199 转交签名 Host 运行时所有权。"
kind: "package-reference"
---

# dsh-remote-host-fd199

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-remote-host-fd199` 实现有签名宿主应用启动被监管 `dsh web` 子进程时的 FD199 认证所有权交接的运行时一侧。签名宿主向子进程传入两条内核私有的继承套接字描述符：198 用于 V3 中继线路，199 用于本交接权威通道。该包把这次启动变成单一已配置宿主：桌面浏览器与已配对手机共享同一进程、存储、模型图、审批与事件流。

## 目录

- [Surface](#surface)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="surface"></a>

## Surface

启动契约由启动器（`apps/cli`）持有。命令行末尾精确的 `--private-relay-fd 198 --private-authority-fd 199` 标记托管运行时；启动器在产生任何启动效果前验证两条描述符都是继承的套接字，从应用可见参数中剥离该后缀，并加入挂载 `remote-host-fd199`、`remote-host-fd199-web-owner` 且启用 `@deepseek-ai/dsh-remote-host-v3` 的覆盖层。普通 `dsh web` 调用既无后缀也无描述符，行为保持完全不变。

描述符 199 上的帧协议是严格 JSON：u32 大端长度前缀、方向互斥的消息词表、重复键拒绝，以及共享字节上限（16 MiB 消息体、8192 个文件、单文件 8 MiB）。子进程完成握手证明（`hello`/`ready`）、恢复原生日志快照（`recover`/`snapshot`）、流式传输摘要校验的导出项（`prepare-file`/`prepare-complete`）、记录不可撤回的拆除意图（`releasing`），并等待原生拆除授权（`release-authorized`）。原生先记录 `exported` 再记录 `releasing`，在这两种状态都拒绝激活，观察并回收退出子进程后才提升到 `prepared` 并启动采纳者。权威也可推送 `instruct {prepare|activate}`。

`CurrentWebFd199Lifecycle` 是桌面写栅栏。API 网关按次惰性解析可选服务 `fd199DesktopWriteFence`：无该服务时一切不变；有该服务时，每个一元操作与 `respond()` 都经过 `runDesktopOperation()`。托管子进程启动时栅栏关闭（状态 `released`），恢复解析后放行桌面操作（`none` → 放行；`exported`、`releasing` 和 `prepared` → 保持关闭直至激活），prepare 事务期间永久关闭，并在激活消费成功后通过 `admitHostedService()` 每周期恰好放行一次。事件流不受栅栏约束：它们是读取侧，静默阶段排空活动写入者而不是切断读取者。

`remote-host-fd199-web-owner` 提供 `fd199WebOwner`：它冲刷已附加会话和持久化 provider，列出包含冷会话的全部持久会话，并通过持有的只读句柄逐一读取。当前会话格式 catalog 将其编码为带真实 SHA-256 摘要的规范 `sessions/<id>.jsonl` 条目。它不提供单存储关闭确认。原生授权不可激活的 `releasing` 状态后，子进程等待启动器仅限托管模式的 `fd199HostedExit` 完成整个根级拆除，关闭持久化句柄和描述符 199。Host 回收该进程后才写入 `prepared` 并重新启动采纳者；采纳者仅在后续激活消费成功后重绑中继。

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- Swift 侧 FD199 权威、已签名托管子进程 supervisor 和钥匙串支持的 proof 身份位于已签名 Host 应用中。普通源码启动的 `dsh web` 不具有任一继承 descriptor，无法进入此生命周期。
- 导出上限失败即关闭：持久存储总量超过 128 MiB 或单会话工件超过 8 MiB 时无法进入本 v1 事务。
- v1 适配器不导出附件；同存储采纳无需传输，但已认证清单仅覆盖会话。
- 描述符验证会检查 198/199 是继承 socket；生产信任根中不可伪造的部分是严格校验的已签名 Host supervisor 及其密封子进程启动。本地进程可以把 argv 后缀用于自身 socket，但不会因此获得已签名 Host 路由或受保护身份的权限。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作备注</summary>

无。

</details>
