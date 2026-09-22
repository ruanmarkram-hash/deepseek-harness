# Agent Note: Native finalized epoch projection

Status: implemented

[English](2026-09-23-native-finalized-epoch-projection.md) | 中文

## 问题

Signed native transport 在受保护 ledger 中提交 relay handshake epoch；托管 gateway 则要求公开 route table 已提交相同 epoch，才接受应用流量。仅完成 enrollment 和 route 创建会让该表停留在零。因此，加密握手成功并不等于移动端可用。

## 决定

私有 FD198 协议提供专用的 native-finalization 请求与持久化 acknowledgment。完成 FD199 seed 的 gateway 检查完整 route、enrollment 身份、generation 与已完成 epoch，并拒绝回退、未解决的未来 reservation、撤销身份和替换活动连接。Host 等待精确 acknowledgment 后才打开应用连接。Stop 与 acknowledgment admission 串行执行。两个 record 均不携带 credential，也不改变 mobile protocol。

## 考虑过的替代方案

**普通 begin/commit 调用**会预约 gateway 的下一 epoch，即使 native handshake 正在丢失 receipt 后协调较早的已提交 epoch。反复增加计数器会伪造连接，无法安全恢复 native 进度。

**放宽连接 admission 或重置计数器**会掩盖状态分歧并削弱 replay protection。显式单调投影保留严格连接 admission，不改动受保护 native ledger。

## 后果

Native Host/runtime executable 与动态加载的 gateway package 必须一起发布。旧 gateway 会拒绝新 record，而不会接受未提交连接。定向 provider 测试覆盖拒绝路径及 frame 传递；native 测试覆盖编码 acknowledgment 验证、取消和 supervisor 转发。构建产物 smoke 检查 JSON 持久化重载、相同 epoch 重试，以及独立 provider instance 之间的 native 进度。这些检查不能替代 signed bundle 和真实手机连接验证。
