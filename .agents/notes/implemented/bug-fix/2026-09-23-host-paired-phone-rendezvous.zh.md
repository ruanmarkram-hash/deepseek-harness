# Agent Note: Host 等待已配对手机

Status: implemented

[English](2026-09-23-host-paired-phone-rendezvous.md) | 中文

## 问题

Host 的首个加密 deadline 在手机发送 frame 之前就开始计时。设备所有者认证以及两端独立用户操作的间隔，可能在尚未发生任何加密交换时耗尽该期限。通用 timeout 无法区分手机未到场与 handshake 停滞。

## 决策

显式激活在保留唯一原生 route owner 和 epoch reservation 的同时，最多等待首个 frame 120 秒。只有该 frame 原样到达后，supervisor 才构造加密 transport，并使用不变的 10 秒 flight deadline。Transport 正常的解码、route、enrollment、epoch 和 handshake 顺序检查只消费一次缓存的首个 frame。无效输入直接失败关闭，不重试。Deadline 错误只包含固定 phase 名称，绝不包含 route 坐标或 secret。

即使 continuation 尚未安装，Stop 也会取消 pending read。已完成的 rendezvous timer 不能关闭后续 handshake。每次挂起后都会重新检查状态及持久化准入，因此 Stop 或 revocation 后的迟到读取不能构造 transport 或提交 epoch。

Host 区分精确且有界的 relay control envelope 与加密 flight。只有固定服务器原因获得 `relay-reported` 诊断；它们均终止连接，但绝不将 relay 视为撤销原生 credential 的授权方。畸形输入以及 route、epoch 或 key 验证失败保留原有拒绝行为，只附加固定类别和 phase。被拒绝的值及任意服务器字符串不会进入诊断。

## 考虑过的替代方案

**延长所有 handshake deadline** 会为停滞的加密交换提供更多时间，却仍混淆人工交互与协议进展。

**无限等待首帧或自动重试** 会无限保留资源或掩盖失败。单独的有界等待为认证提供时间，同时保留显式连接 ownership 和现有 epoch 恢复规则。

## 影响

此修改只涉及原生 Host，无需改变 mobile wire 或替换 invitation。两分钟等待保留一个 socket 和独占 route lease；Stop 会释放它们，失败尝试保留精确的未提交 pending epoch 以供重试。重复的手机认证提示仍是单独的 mobile 问题。

## 验证

聚焦 supervisor 测试在等待 119 秒后完成真实加密 hello-to-receipt transcript，越过已失效的 rendezvous timer，并验证每个后续 flight 仍在 10 秒后到期。其他用例覆盖首帧 timeout、畸形及已撤销首帧、独占 ownership、Stop 后不配合取消的迟到读取，以及 continuation 安装前的取消。现有 transport timeout-fence 和应用 I/O teardown 测试也同时通过。已签名 bundle 和实体手机验证仍属于单独发布检查。

诊断测试拒绝未知原因、布尔或错误 version、额外字段、过大输入和重复 key。Production supervisor 路径区分 hello 前与 welcome 后的 relay timeout，保留 credential 和 pending epoch，并报告畸形、tuple、epoch 与 key 失败，且描述不含用于泄漏检测的 secret 标记或 route ID。
