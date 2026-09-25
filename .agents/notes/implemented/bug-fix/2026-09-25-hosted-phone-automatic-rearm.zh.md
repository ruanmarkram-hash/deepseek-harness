# Agent Note: 自动重新监听 hosted 手机路由

Status: implemented

[English](2026-09-25-hosted-phone-automatic-rearm.md) | 中文

## 问题

iOS 将手机应用置于后台时，手机会关闭仅限前台的 relay transport。过去 Host 保留已终止的手机会话，却不再监听。即使本地 Web child 健康、邀请有效，手机显式重试仍会遇到无人监听的路由，并在 Host handshake 阶段停止。

## 决策

Host 显式激活已配对手机路由后，transport 结束会清理 socket receiver 和 writer，向已 seeded 的 child 确认 `connection.closed`，并在同一路由重新等待。只要 child 健康且上一连接正常关闭，child 和本地 Web runtime 就保持运行。Host 通过现有 ledger 签发下一个确切 epoch。手机仍须通过所有者认证显式发起每次连接；进入后台并不会赋予 Host 自动连接手机的权限。

[先前的恢复决策](2026-09-23-hosted-phone-session-recovery.zh.md)仍适用于 child 已停止或不再安全的情况。Host 仅在已结束的 transport 清理完成后替换该 child。重连等待失败时会重试，而不会丢弃可复用的 child。Host Stop 和撤销会取消监听；Host 正常重启后仍需显式激活路由。

## 考虑过的替代方案

**每次手机断开都替换 child。** 普通 iOS 后台切换也会中断本地 Web workspace，并在新进程中无谓地重复一次性 enrollment seed。

**自动重连手机。** 后台手机无法在没有用户操作的情况下安全完成所有者在场认证，因此只有 Host 端的连接等待是自动的。

## 影响

正常手机重试会保留本地 Web 会话和已验证邀请。在重新打开之前先关闭 child 中的连接，可防止陈旧连接状态拒绝新的连接 ID。如果 child 在 Host 的存活检查后停止，手机仍可能先失败一次，随后 Host 才会替换 child；因此实体设备重连必须由发布测试验证，不能仅根据单元测试推断。
