# dsh-remote-host-fd199

[English](README.md) | 中文

`@deepseek-ai/dsh-remote-host-fd199` 实现有签名宿主应用启动被监管 `dsh web` 子进程时的 FD199 认证所有权交接的运行时一侧。签名宿主向子进程传入两条内核私有的继承套接字描述符：198 用于 V3 中继线路，199 用于本交接权威通道。该包把这次启动变成单一已配置宿主：桌面浏览器与已配对手机共享同一进程、存储、模型图、审批与事件流。

## Surface

启动契约由启动器（`apps/cli`）持有。命令行末尾精确的 `--private-relay-fd 198 --private-authority-fd 199` 标记托管运行时；启动器在产生任何启动效果前验证两条描述符都是继承的套接字，从应用可见参数中剥离该后缀，并加入挂载 `remote-host-fd199`、`remote-host-fd199-web-owner` 且启用 `@deepseek-ai/dsh-remote-host-v3` 的覆盖层。普通 `dsh web` 调用既无后缀也无描述符，行为保持完全不变。

描述符 199 上的帧协议是严格 JSON：u32 大端长度前缀、方向互斥的消息词表、重复键拒绝，以及共享字节上限（16 MiB 消息体、8192 个文件、单文件 8 MiB）。子进程完成握手证明（`hello`/`ready`）、恢复原生日志快照（`recover`/`snapshot`）、流式传输摘要校验的导出项（`prepare-file`/`prepare-complete`）、观察原生释放屏障（`release-now`）、确认句柄释放（`released`/`prepared`），并消费激活（`activate`/`activated`）。权威也可推送 `instruct {prepare|activate}`。

`CurrentWebFd199Lifecycle` 是桌面写栅栏。API 网关按次惰性解析可选服务 `fd199DesktopWriteFence`：无该服务时一切不变；有该服务时，每个一元操作与 `respond()` 都经过 `runDesktopOperation()`。托管子进程启动时栅栏关闭（状态 `released`），恢复解析后放行桌面操作（`none` → 放行；`prepared` → 保持关闭直至激活），prepare 事务期间永久关闭，并在激活消费成功后通过 `admitHostedService()` 每周期恰好放行一次。事件流不受栅栏约束：它们是读取侧，静默阶段排空活动写入者而不是切断读取者。

`remote-host-fd199-web-owner` 提供 `fd199WebOwner`：它通过存储自身的冲刷屏障与原始工件读取，把每个持久会话导出为带真实 SHA-256 摘要的规范 `sessions/<id>.jsonl` 条目。其 v1 `releaseStoreOwnership()` 依赖栅栏已排空准入。只有在收到原生 `prepared` 确认后，子进程才请求启动器的有界退出，使根级拆除释放剩余存储句柄和描述符 199；随后宿主可重启采纳型子进程，并在启动时从 `activated` 日志重绑中继。

## Known Limitations and Deferred Work

- Swift 侧 FD199 权威位于 `native/remote-host-app/Sources/RemoteHostFd199`；生产签名必须绑定受保护宿主身份的钥匙串句柄后才能进行任何真实激活。
- 导出上限失败即关闭：持久存储总量超过 128 MiB 或单会话工件超过 8 MiB 时无法进入本 v1 事务。
- v1 适配器不导出附件；同存储采纳无需传输，但已认证清单仅覆盖会话。
- 描述符验证只检查 198/199 是继承的套接字；信任根中不可伪造的部分是签名宿主监管器本身，其生产生成路径与钥匙串绑定签名身份仍是延后工作。本地进程今天可以对自有套接字自行附加 argv 后缀，但除该本地用户既有权限外不产生任何额外特权。
