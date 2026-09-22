# Agent Note: Relay Host 会合预算

Status: implemented

[English](2026-09-23-relay-host-rendezvous-budget.md) | 中文

## Problem

relay 的未绑定 socket 超时可能在用户等待手机认证期间关闭已认证的 Host。原生 Host 独立的会合预算无法保护被 relay 提前关闭的 socket。

## Decision

[relay](../../../../apps/mobile-relay/README.md) 允许已认证且未绑定的 Host 等待 125 秒，即[原生会合](2026-09-23-host-paired-phone-rendezvous.md)预算加五秒 relay 调度余量。未绑定设备保留 30 秒限制。hello 之后，未绑定 Host 使用握手的 30 秒截止时间，而非较早的连接时间戳。alarm 调度、过期和过期连接所有者驱逐共享此计算。握手状态转换会重新调度最早的 alarm，但不延长握手开始时间。

## Alternatives considered

**增大共享超时**还会延长设备空闲准入和活动密码学握手，而这两者都不需要人工认证时间。

**仅更改 alarm 回调**会使过期连接所有者驱逐与已调度的 alarm 时间戳不一致。共享计算可在全部三个路径上保持相同界限。

## Consequences

单个已认证 Host 可更长时间保留空闲 socket。凭据验证、单对端所有权、轮换、撤销和 epoch 准入保持不变。Durable Object 集成测试覆盖精确空闲边界、提前和临近截止时间的 hello、alarm 重新计算及被替换连接所有者的隔离。实体手机验证仍属于发布检查。
