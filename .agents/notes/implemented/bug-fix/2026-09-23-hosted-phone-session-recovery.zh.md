# Agent Note: 显式恢复已结束的 hosted 手机会话

Status: implemented

[English](2026-09-23-hosted-phone-session-recovery.md) | 中文

## 问题

已建立的手机 transport 可能在本地 Web child 仍然正常时结束。保留这个已终止的会话会阻止再次激活，但仅清除会话又会向同一 child 发送第二次一次性 enrollment seed，并留下已注册的旧连接。

## 决策

[hosted 运行时生命周期](../../../../native/remote-host-app/Sources/RemoteHostApp/HostedRuntimeLifecycle.swift)在所保留手机会话进入单调的结束状态后，允许显式激活。一个 reservation 覆盖等待旧会话清理、停止已经 seeded 的 child、启动替代 child，以及激活新手机会话的整个过程。生产组合复用现有原生 credential、已签名 journal 和已完成提交的 epoch 状态。后台 transport 回调不会重启本地 Web 运行时。

会话关闭会停止转发，并等待 receiver 和 outbound writer 均结束，随后才允许替换。EOF 从独立任务请求清理，因为关闭操作本身需要等待 receiver。并发 stop 调用会共同等待同一次清理完成。Stop 保持生命周期 reservation 的取消状态，直到迟到的 factory 或启动返回并清理其 candidate；替代对象不能与该清理重叠。后续的[自动重新监听决策](2026-09-25-hosted-phone-automatic-rearm.zh.md)不再要求替换健康的已 seeded child。

## 考虑过的替代方案

**只清除已结束的会话。** 这会保留 child，但重复其一次性 seed，并留下旧 child 连接。现有协议要求使用新的 child。

**transport 失败时自动重启 child。** 这会在没有用户显式操作的情况下中断正常的本地 Web 会话。transport 终止只结束手机传输；下次 Activate 负责恢复。

## 影响

用户请求恢复时，本地 Web 服务会短暂中断。活动会话仍拒绝重叠激活。替换失败后仍可启动本地运行时；它不会重置配对 credential、已签名 journal 或原生 epoch。relay 协议和受保护 key 均无变化。

聚焦的 Swift 生命周期回归测试覆盖显式恢复顺序、重试前保留本地所有权、等待清理、旧会话迟到完成、替代 child 启动和会话构造期间的 stop，以及替换失败后的重启。暂停 writer 的回归测试验证 frame pump 完全停稳和队列 frame 的丢弃。现有 Swift 到 TypeScript 网关测试通过真实网关验证未改变的应用 framing。已签名应用恢复和实体手机重连仍属于发布冒烟覆盖；这些单元测试不能证明部署效果。
