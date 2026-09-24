---
description: "在不改变线路契约的前提下，将已发布移动客户端与轻量 Desktop 发现包装器连接到当前 Host controller。"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-api

[English](README.md) | 中文

## 概述

已发布移动客户端可以列出会话、提交提示、接收已提交文本，并回答与桌面浏览器相同的审批。已配置 Host 继续持有会话、agent、持久化和待决交互。本适配器保持移动端请求与事件契约，不暴露第二套通用 HTTP API。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

已签名 Host 启动器把本插件与已认证移动网关一同挂载。它提供网关消费的进程内 `apiProxy` 契约；它不认证设备，也不授予能力。普通浏览器客户端使用当前 [API Gateway](../../api/gateway/README.zh.md)。

独立安装的轻量 Desktop 包装器可以把现有发现信封 POST 到 `/api/host.describe`。该精确路由仅接受内核观测到的回环调用方，要求回环 Host 标头且不带 Origin 标头。它拒绝其他方法与过大消息体。不挂载任何旧版变更端点。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制，点击展开</summary>

[适配器](src/adapter.ts) 将已发布移动端信封映射到当前 controller 调用，并提供稳定请求标识。[事件适配器](src/events.ts) 为已发布手机渲染器投影已提交消息文本，并对审批与问题使用 Gateway 现有的待决交互所有者。提交响应前会校验会话和审批标识。可选的托管写栅栏覆盖完整一元操作与交互响应；所有权交接期间仍可读取事件流。

运行时不变量：不发布 companion。本包不维护第二套权威会话或审批存储；controller 调用重新读取当前服务，待决投递记录随所属流的生命周期移除。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Remote Gateway](../remote-gateway/README.zh.md)：已认证远程分派。
- [Remote Wire](../remote-wire/README.zh.md)：有界手机请求契约。
- [FD199 所有权](../remote-host-fd199/README.zh.md)：已签名 Host 交接与写栅栏。

<a id="model-experience"></a>
## 模型体验

无，因为本包分派已有 controller 调用，不自行提供提示、工具 schema 或模型可见事件。

#### KV Cache effect

无直接影响；被调用的 controller 及其模型侧所有者决定上下文和缓存行为。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

兼容契约仅覆盖已发布手机行为。

- 不提供预设复制、文档打开和移除，并返回明确能力错误。会话日志下载返回未找到。
- 冷历史使用当前分页会话查询，不激活 agent。适配器不增加持久事件重放存储。
- 发现路由不使用浏览器 bootstrap cookie，因为轻量 Desktop 包装器在打开浏览器连接前调用它。其仅限回环且不带 Origin 的只读路由不会替代任何当前 API 的 Connection 认证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景，点击展开</summary>

无。

</details>
