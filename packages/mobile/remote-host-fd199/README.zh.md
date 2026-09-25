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

描述符 199 的版本 2 帧协议使用严格 JSON、u32 大端长度前缀、方向互斥消息和重复键拒绝；`hello`/`ready` 必须明确携带 `protocolVersion: 2`，版本 1 对端失败即关闭。上限仍为单消息体 16 MiB、8192 个逻辑文件、解码总字节数 128 MiB。每个文件依次发送 `prepare-file-begin {name}`、偏移连续且解码长度为 1–256 KiB 的 `prepare-file-chunk {offset,bytesBase64}`，以及 `prepare-file-end {size,sha256}`。原生增量计算整个逻辑文件的摘要。每次请求后，发送者等待写入回调及字段完全匹配的 `prepare-file-ack {name,offset,complete}`，才继续读取字节。分块边界不会拆分会话或改变 JSONL 字节。

全部文件结束后，`prepare-complete` 暂存已验证导出，`releasing` 记录不可撤回的拆除意图，子进程等待 `release-authorized`。原生先记录 `exported` 再记录 `releasing`，在两种状态都拒绝激活；观察并回收退出子进程后才提升到 `prepared` 并启动采纳者。权威也可推送 `instruct {prepare|activate}`。所有权交接总期限为 120 秒；单次响应或写入期限仍为 20 秒，握手为 10 秒。失败不会重新打开旧写栅栏。

新原生日志和签名证明载荷使用版本 3，允许单个逻辑文件使用既有的 128 MiB 总预算。恢复版本 2 时按原始载荷字节验证，并保留单文件 8 MiB 规则；已准备好的版本 2 记录在激活时仍写版本 2。不支持的记录是错误，而非空日志。旧 Host 拒绝版本 3；回滚不得改版本、删除或静默替换其日志。操作回滚必须先停止所有所有者、确保没有新用户写入，并持有相匹配的升级前存储及日志检查点；否则须向前恢复。

`CurrentWebFd199Lifecycle` 是桌面写栅栏。API 网关按次惰性解析可选服务 `fd199DesktopWriteFence`：无该服务时一切不变；有该服务时，每个一元操作与 `respond()` 都经过 `runDesktopOperation()`。托管子进程启动时栅栏关闭（状态 `released`），恢复解析后放行桌面操作（`none` → 放行；`exported`、`releasing` 和 `prepared` → 保持关闭直至激活），prepare 事务期间永久关闭，并在激活消费成功后通过 `admitHostedService()` 每周期恰好放行一次。事件流不受栅栏约束：它们是读取侧，静默阶段排空活动写入者而不是切断读取者。

`remote-host-fd199-web-owner` 提供 `fd199WebOwner`：它冲刷已附加会话和持久化 provider，列出包含冷会话的全部持久会话，并通过持有的只读句柄逐一读取。当前会话格式 catalog 惰性编码完整规范 `sessions/<id>.jsonl` 条目，保留所有头部、事件及末尾换行。客户端持有导出取消控制，计算流式字节的 SHA-256，关闭时等待迭代器和句柄清理。它不提供单存储关闭确认。原生授权不可激活的 `releasing` 状态后，子进程等待启动器仅限托管模式的 `fd199HostedExit` 完成整个根级拆除，关闭持久化句柄和描述符 199。Host 回收该进程后才写入 `prepared` 并重新启动采纳者；采纳者仅在后续激活消费成功后重绑中继。

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- Swift 侧 FD199 权威、已签名托管子进程 supervisor 和钥匙串支持的 proof 身份位于已签名 Host 应用中。普通源码启动的 `dsh web` 不具有任一继承 descriptor，无法进入此生命周期。
- 导出总量超过 128 MiB 或文件数超过 8192 时失败即关闭。版本 3 记录不再受旧的单逻辑会话 8 MiB 上限约束，但仍拒绝超限分块。
- 流式传输避免拼接整个导出。既有持久化后端仍缓存完整解析会话，单个事件序列化也可能需要事件大小的缓冲区。分页不代表持久化内存有界。不支持取消的后端操作可能延迟句柄清理；取消后不再发送帧。
- 本适配器不导出附件；同存储采纳无需传输，但已认证清单仅覆盖会话。FD199 是本地所有权验证，不是向手机上传全部历史。FD198、手机封包和历史响应上限不变，无需发布 iOS 或中继更新。
- 描述符验证会检查 198/199 是继承 socket；生产信任根中不可伪造的部分是严格校验的已签名 Host supervisor 及其密封子进程启动。本地进程可以把 argv 后缀用于自身 socket，但不会因此获得已签名 Host 路由或受保护身份的权限。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作备注</summary>

无。

</details>
