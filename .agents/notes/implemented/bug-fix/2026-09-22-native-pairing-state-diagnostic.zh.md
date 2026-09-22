# Agent Note: 已签名 Host 配对状态诊断

Status: implemented

[English](2026-09-22-native-pairing-state-diagnostic.md) | 中文

## Problem

缺少 hosted-child enrollment receipt 不能说明是 credential 读取失败，还是原生配对与持久化公开 enrollment 不一致。外部诊断不能假定有权读取已签名 Host 的 Keychain 项，而导出该项会暴露 route capability。

## Decision

已签名 Host 通过现有 noninteractive credential store 提供只读 **Check pairing state** 操作。只有公开 identity 字段进入比较。具有大小上限且基于目录 descriptor 的读取检查已验证 sealed DSH home 下的标准 JSON 公开目录，并拒绝链接、非预期文件类型和其他用户可写的路径。报告只包含固定文本与存在性/相等性布尔值；错误绝不插入底层描述或存储值。启动控制项通过把撤销操作仅保留在 Host 菜单中，维持四个按钮。

## Alternatives considered

**外部 credential 提取** 不能假定具有已签名应用的授权，而且会不必要地暴露 capability。诊断保留在现有已授权进程内。

**修复 enrollment 或自动重新配对** 会在弄清差异前改变信任状态。此操作既不执行这些变更，也不建立网络连接。

**新增 FD198 错误消息** 会扩大 runtime 协议，并要求同步发布 child。本地比较只需要 outer Host executable。

## Consequences

诊断能区分记录缺失、公开 tuple 冲突以及固定的读取/验证失败，而不导出 credential 或改变 runtime ownership。它覆盖标准 JSON 存储布局，不覆盖任意存储后端覆盖配置；并发写入可能在观察后改变状态。记录匹配不是连接成立的证据。定向原生测试固定报告渲染、冲突和失败处理、有界读取、不安全路径拒绝，以及文件内容和修改时间的保留行为。
