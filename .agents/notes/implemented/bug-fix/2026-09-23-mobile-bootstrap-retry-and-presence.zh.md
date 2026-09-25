# Agent Note: 移动端初始化重试与在场会话复用

Status: implemented

[English](2026-09-23-mobile-bootstrap-retry-and-presence.md) | 中文

## 问题

经过认证的 receipt 会在 workspace 初始化完成前推进移动端客户端预期的下一 epoch。使用这个可变 epoch 识别连接 deadline，会使初始化期间的 timer 失效。无响应的 Host 因而可能令客户端无限保持 connecting，而未观察连接状态的配对面板仍显示看似无效的 Connect 按钮。所有者认证后再次读取受保护身份数据也会产生不必要的提示。

## 决策

Deadline 属于精确的连接尝试与配置，而非下一持久化 epoch。它在设备描述、会话列表和 snapshot 投影期间持续有效。到期会退役 transport 和发送权限，取消尝试并拒绝 pending request。重试保留 receipt 确认的下一 epoch。配对与连接面板共用连接进度、失败和重试展示；每客户端 action 序列化在 React 渲染 pending 状态之前就排除重复点击。

公开身份查询仅复用当前已认证原生身份的公开投影。不存在该会话时，仍使用不变的受保护 Keychain 加载路径。进入后台、断开连接、timeout 和过期认证结果继续遵守现有清除规则；私有字节不跨越原生接口。

## 考虑过的替代方案

**延长 timeout** 无法修复 receipt 后 ownership 检查失效的 timer。**回滚 epoch** 会产生重放风险，并违背已认证 finality。

**独立于用户在场会话缓存受保护身份** 是通过削弱安全生命周期来避免提示。仅复用现有已授权会话的公开投影，可避免重复读取而不延长该生命周期。

## 影响

无响应的 Host 初始化会成为可见且可重试的错误，而非永久禁用的操作。已认证公开投影需要新的原生 iOS build；仅更新 JavaScript 不会发布这部分修复。现有 Keychain service 名称、bundle identity、invitation 状态和 enrollment 均保持不变。

## 验证

确定性加密 transcript 测试在 receipt 后阻塞各初始化阶段，让原 timer 到期，断言可见重试 snapshot，再以精确下一 epoch 重新连接，并拒绝前次 snapshot 迟到完成的影响。Action 测试排除重复点击。原生在场测试验证已授权公开投影跳过受保护加载、清除后恢复加载，且迟到认证不能恢复已清除的会话。实体 Face ID 和 TestFlight 验证仍属于发布检查。
