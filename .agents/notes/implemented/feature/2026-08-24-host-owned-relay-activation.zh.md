# Agent Note: 已签名 Host 保留一个 FD199 生命周期且仅在激活后打开 relay

Status: implemented

[English](2026-08-24-host-owned-relay-activation.md) | 中文

## 问题

即使托管子进程打包正确，也不能因为 Host 已启动就打开公开 relay socket。配对、已配置运行时所有权、路由激活、重启恢复和撤销需要一个保留的原生 owner 以及显式用户控制。

## 决策

`DSHHost.app` 在应用生命周期内保留一个 `HostedRuntimeController`。**Start hosted runtime** 验证完整已签名安装，启动或恢复 FD199 已配置 Web owner，并保持 relay 关闭。**Activate paired phone** 消费已签名 FD199 activation，核对原生确认的公开注册 seed 与 receipt，只有随后才启动一个由 `HostedRelaySession` 持有的已认证 V3 路由 socket。

互联网配对也由 Host 持有。**Pair iPhone from anywhere…** 创建短期公开代码，获取一个公开手机 offer，显示完整指纹，并要求 Host 本地批准。生成的邀请会加密给该手机身份。relay 绝不接收仅 Host 持有的路由凭据或明文邀请。本地 offer 导入仍可使用，**Copy fresh iPhone invitation** 只会为活动路由重新签发手机安全邀请。

激活后的 relay bridge 只通过 descriptor 198 转发已认证 connection record 和直接应用 JSON 字节。设备、路由、epoch、私钥和凭据状态仍由原生侧持有。停止或退出会断开 bridge，取消接收与写入 task，关闭并清零 transport 状态，并停止子进程。重启后选择 **Start hosted runtime** 只会在同一个密封安装和凭据检查通过后恢复已活动 journal 与路由。

**Revoke paired phone…** 会记录持久 cleanup intent、撤销公开路由、使任何子进程副本退出、停止 relay 和托管子进程，并且只在幂等清理成功后删除原生凭据。模糊远程清理保持失败关闭。手机端 **Forget invitation** 有意与撤销分离，不能撤销 Host 路由。

## 验证

聚焦 Swift 测试覆盖 inert start、单一保留 controller、精确 seed 与 receipt 核对、两代 FD199 activation、直接 frame 保真、FIFO 子进程输出、重启恢复、路由与 epoch 所有权、模糊清理、revoke fence 和 teardown。relay 与移动测试覆盖短期互联网配对、加密邀请传输、显式连接与重连、撤销拒绝和本地忘记。分发验收仍由已公证 Host 和不同网络 TestFlight 矩阵完成。

## 考虑过的替代方案

**在 Host 启动时打开 relay。** 拒绝，因为启动本地 Web owner 不应暗示公开网络激活。

**让托管子进程持有路由凭据。** 拒绝，因为这样 JavaScript 会控制用于认证已签名 Host 的凭据与注册生命周期。

**把手机忘记视为撤销。** 拒绝，因为本地删除无法证明持久 Host 和 relay 授权已删除。

## 后果

启动、激活、重启、撤销和忘记具有不同可观察含义。Host 可以在手机 relay 保持关闭时提供浏览器会话。缺少已确认活动路由、有效已签名 journal、精确公开注册 receipt 或已认证 relay 握手时，激活会失败关闭。生产声明要求打包候选版本在一次最终公证前通过迁移，且已处理 TestFlight 构建通过完整实体设备矩阵。
