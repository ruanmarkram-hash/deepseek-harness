# Agent Note: 托管 frame 连接引用

Status: implemented

[English](2026-09-23-hosted-frame-connection-references.md) | 中文

## Problem

已认证的连接打开信息和逐消息连接引用具有不同的 schema。在普通 frame 中复用 open metadata 会导致托管 child 拒绝首条应用消息。将 child 引用与序列化的 open metadata 比较，也会拒绝合法响应并漏掉关闭通知。

## Decision

原生 frame pump 从精确的八字段 open record 派生单字段连接引用。完整 open record 只用于连接准入。Send 和 close metadata 使用已有的拒绝重复键 JSON 解析器、精确字段集合及当前不透明连接 ID；close 还要求白名单内的 gateway 原因。成员顺序和等价 JSON 转义不影响身份。[原生 Host](../../../../native/remote-host-app/README.zh.md) 不会放宽 [child wire](../../../../packages/mobile/remote-host-v3/README.zh.md) schema。

## Alternatives considered

**允许每个 child frame 携带完整 open metadata**会削弱本来正确的协议解析器，并在普通消息上重复不必要的权限信息。

**比较序列化引用**会拒绝等价的 JSON 编码。解析严格 metadata 可保持身份匹配，同时拒绝额外或重复字段。

## Consequences

认证后的首条应用请求和响应可以通过而不关闭 FD198。畸形发送仍采用失败关闭，陈旧或无效关闭消息不能停止当前连接。不需要更改凭据、邀请、原生 epoch、relay 协议或 child 可执行文件。

## Verification

`swift test --filter hostedFramePump` 覆盖完整 open metadata、严格引用、重复与转义键、关闭原因、陈旧关闭隔离及停止状态。其跨语言用例生成实际 Swift bridge 字节，在有界子进程中运行 TypeScript inherited-wire provider 和 gateway，再将真实响应 record 通过 Swift bridge 和 frame pump 返回。临时测试数据仅包含合成公开身份及会话列表请求；子进程不继承任何凭据。此组装后的应用交换补充原生单元测试；实体手机验收仍属于发布检查。
