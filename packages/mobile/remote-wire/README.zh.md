---
description: "为受信任的远程客户端解析有界且独立于传输的请求、响应和事件。"
kind: "package-library"
---

# dsh-remote-wire

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-remote-wire` 定义连接到一个由宿主拥有的 harness 的可信远程 DSH 客户端所使用的版本三、传输无关信封词汇。它是解析器和约定包，不是中继、连接、信任存储、加密层或 UI。

## 目录

- [接口](#surface)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="surface"></a>

## 接口

每个信封都携带固定的 `version: 3` 和 `connectionEpoch`。客户端请求携带不透明的 `requestId` 和 `idempotencyKey`；响应回显该请求 id。宿主事件携带不透明投递 `eventId`、原始 Host `requestId` 和连续投递 `cursor`；可回答事件的回复会回显该 Host 请求 id。客户端只会在本地应用了最高连续 cursor 后发送 `stream-ack`。解析器不保留顺序状态，因此未来的连接所有者会执行 epoch 替换、幂等性保留和确认推进。

`REMOTE_WIRE_METHODS` 是一个封闭的允许列表，并会针对公开 API Proxy `RpcMethodMap` 进行检查。它接受当前 DSH 的 session、workspace、model、subagent、configuration、credential 和 host 方法，而不会引入第二个、手工命名的 computer-use API。`REMOTE_WIRE_EVENTS` 保留每个现有公开 host 和 mux 事件名称。批准回答保留当前的 `allowed-once` 和 `rejected` 结果。通用 `client-response` 会回显宿主请求 id，并能回答现有问题请求。device control 仅限于连接生命周期（`device.describe`、`device.heartbeat` 和 `device.disconnect`），绝不执行宿主工具。

解析器拒绝额外或缺少字段、不受支持的版本、未知方法或事件、无效不透明 id、无效 epoch 或 cursor、无边界 JSON，以及格式错误的 result、approval 或 client-response 形状。payload、result 和完整重建的信封上限均为 8 MiB；递归 JSON 还将标量字符串上限设为 1 MiB、深度设为 32、每个容器条目设为 1,024。会拒绝 prototype-poisoning 键。解析器失败使用稳定代码且不会回显不可信内容。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制和延期工作

- 此包不会验证设备、绑定传输、持久化幂等性记录、排序或重放 stream、分发 DSH 方法，或应用批准和 device-control policy。未来由宿主拥有的连接 runtime 会拥有这些效果，并把已验证的词汇映射到现有 DSH API Proxy。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作备注</summary>

无。

</details>
