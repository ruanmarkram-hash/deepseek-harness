---
description: "选择移动传输、受信任设备和签名 Host 集成包。"
kind: "package-group"
---

# mobile/：共享移动端产品词汇

[English](README.md) | 中文

## 概述

这些包连接已签名 DSH Host、原生移动客户端和远程中继。协议库定义传输值；Host 插件把已授权的手机请求适配到已配置的 Host 服务。配对本身不会独立授予本地计算机、文件系统、凭据或 workspace 访问权限。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>

## 包

| 包 | 职责 |
|---|---|
| [`pairing-protocol/`](pairing-protocol/README.zh.md) | 校验无账户加密配对 bootstrap 数据、移动端能力声明和不透明中继帧的顺序 |
| [`remote-api/`](remote-api/README.zh.md) | 通过当前 Host controller 保持已发布移动端的请求与事件契约 |
| [`remote-devices/`](remote-devices/README.zh.md) | 持有 Host 的持久公开受信设备目录与注册 incarnation |
| [`remote-gateway/`](remote-gateway/README.zh.md) | 通过注入的受信连接分派经过认证的 remote-wire 请求与有序 Host 事件 |
| [`remote-host-fd199/`](remote-host-fd199/README.zh.md) | 通过继承 descriptor 199 执行经过认证的托管运行时所有权交接 |
| [`remote-host-identity/`](remote-host-identity/README.zh.md) | 定义已签名原生 Host 身份 provider 与本地注册 controller |
| [`remote-host-v3/`](remote-host-v3/README.zh.md) | 将已签名 Host 的继承 descriptor 198 接入已配置 V3 Host gateway |
| [`remote-relay-protocol/`](remote-relay-protocol/README.zh.md) | 实现双向认证、加密的 V3 relay 握手和 frame transport |
| [`remote-wire/`](remote-wire/README.zh.md) | 定义有界 V3 owner API、事件流、审批、action card 和 cursor vocabulary |

<a id="related-documentation"></a>

## 相关文档

[移动子系统参考](../../docs/subsystems/mobile.zh.md)负责共用服务和事件定义。

<a id="dev-note"></a>

## 开发备注

<details>
<summary>维护者工作备注</summary>

无。

</details>
