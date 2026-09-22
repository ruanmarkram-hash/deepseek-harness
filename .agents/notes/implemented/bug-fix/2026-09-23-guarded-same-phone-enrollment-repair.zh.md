# Agent Note: 受保护的同手机 enrollment 修复

Status: implemented

[English](2026-09-23-guarded-same-phone-enrollment-repair.md) | 中文

## Problem

即使手机的公开 identity 匹配，已批准的原生 route 也可能与较早且未使用的公开 device 和 Host enrollment 不一致。重新配对或静默接受冲突 seed 会在未证明记录权威性的情况下改变信任。

## Decision

已签名 Host 提供单独且需要两次确认的离线修复。准入要求单一同手机公开 tuple 的两个 incarnation 均不匹配，key 和 label 匹配，route 引用内部一致，unit 版本受支持，公开和原生 epoch 均未使用。检查 recovery marker 和原生状态期间，原生 route lease 与 transaction 持续控制准入。Host 保留其 runtime-start 状态和配置的 loopback 端口。操作者停止所有外部 writer；端口保留不是通用文件 writer 锁。

私有且基于目录 descriptor 的 journal 只存储精确的公开 preimage、提议 image 及其 hash。文件替换原子、有界、保留权限，并受 preimage 相等检查保护。部分操作只会回滚已识别的原始/目标字节。未知的中途写入会安全拒绝。Prepared 或损坏的 journal 会阻止 hosted 启动和激活，直至显式恢复；已完成 journal 是历史备份，而不是对后续 runtime 数据施加永久相等约束。原生 credential、invitation 和 epoch 记录绝不重写。

## Alternatives considered

**放宽 enrollment seed 检查** 会让普通激活替换可信 lifetime identifier。修复使用单独操作者动作，且准入严格更窄。

**删除 device 或 route 存储** 会丢弃无关元数据并失去可恢复证据。事务保留元数据和精确公开原始内容。

**没有 journal 的双文件编辑** 无法区分两次替换之间的崩溃与有意混合状态。持久化 journal 先于替换，并支持精确回滚。

## Consequences

操作只修复已诊断的同手机、零使用、双 incarnation 不匹配。已使用或含糊 route、其他存储布局、不安全文件 ownership、权限、链接，或任何原生 pending recovery 仍会被拒绝。定向原生测试在不使用真实 credential 的情况下覆盖范围拒绝、原始内容保留、权限、部分失败、中断恢复、并发更改、版本验证、大小增长和原生 lease/epoch 准入。JSON 投影仍依赖操作者满足离线 writer 要求。
