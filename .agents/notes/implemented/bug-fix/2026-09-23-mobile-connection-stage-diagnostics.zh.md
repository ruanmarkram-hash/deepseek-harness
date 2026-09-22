# Agent Note: 移动端连接阶段诊断

Status: implemented

[English](2026-09-23-mobile-connection-stage-diagnostics.md) | 中文

## Problem

通用连接错误无法区分手机认证、relay 打开或加密握手失败。Host 没有收到首帧并不能证明手机上的哪个操作失败，也不能证明存储的邀请已过期。

## Decision

每次移动端连接尝试都拥有一个封闭的诊断阶段集合。失败和 deadline 提示只显示固定阶段标签与固定指导。socket 包装器只在第一次 carrier 发送成功返回后，才从 hello 准备或发送阶段进入 Host 握手阶段；它原样转发帧内容，绝不解析或记录。消息被本地发送接口接受不代表远端已收到。receipt 持久化与 workspace 加载共用已认证初始化阶段。

## Alternatives considered

**显示原生或 relay 异常文本**可能暴露凭据、标识符或 transport 细节，而且定位失败操作并不需要这些信息。

**根据 Host 沉默推断配对过期**会混淆认证、transport 和路由失败，并鼓励在缺乏证据时执行破坏性恢复。

## Consequences

下一次物理设备尝试可以指出失败的本地阶段，而不改变线上消息、验证、deadline、原生认证、密钥、持久 epoch 或重试规则。诊断有意不确定某一阶段内部的根因。网络拒绝细节仍需独立的 relay 证据。

## Verification

故障注入通过生产移动客户端覆盖每个阶段，包括 hello 准备之前、发送过程中、发送成功之后，以及实际加密 workspace 初始化期间的失败。异常中的哨兵细节绝不进入可见状态。加密 transcript 超时快照保留确切阶段，同时现有取消和下一 epoch 重试测试仍然有效。物理 iOS 网络与 Face ID 仍属于发布检查。
