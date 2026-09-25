---
description: "Brave Web Search：供部署方选择、配置或排查逐次解析凭据的 Host 搜索提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brave

[English](README.md) | 中文

## 概述

通过 Brave 专用的 Web Search 端点搜索网页，并将 URL、标题和描述作为可引用来源返回。如果需要不发起独立模型请求的搜索提供方，可选择 Brave。通过凭据服务或启动环境提供 Brave API 密钥；每次搜索都会重新解析该密钥。缺少密钥时搜索失败，重定向目标也会在访问前被拒绝。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Host web 服务旁挂载 Brave；当组合中有多个搜索提供方时，按提供方 id 选择它。

### 何时选择

如果持有 Brave Search API 密钥，并希望使用专用搜索端点，可选择 Brave。如果希望使用 DeepSeek 的原生服务端搜索，请使用 [dsh-web-search-deepseek](../web-search-deepseek/README.zh.md)；该提供方会发起独立的模型请求。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-brave'
  config:
    apiKeyEnv: BRAVE_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | `BRAVE_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用；没有该服务时从启动环境读取 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-brave) 列出所有接受的字段。不要将密钥值写入 `cordis.yml`。当挂载多个搜索提供方时，在 `@deepseek-ai/dsh-web` 服务配置中设置 `searchProvider: brave`，或在 Host 启动环境中设置 `DSH_WEB_SEARCH_PROVIDER=brave`。

### 结果与失败

发送给 Brave 的 `count` 最大为 20；web 服务对返回来源执行请求中的 `maxResults` 限制。缺少密钥抛出 `WEB_PROVIDER_CREDENTIAL_MISSING`；取消抛出 `WEB_ABORTED`；凭据查询、HTTP、响应及传输失败抛出 `WEB_PROVIDER_ERROR`。错误不包含密钥值或原始传输异常。HTTP 重定向会在访问 `Location` 目标前失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件在 `ctx.web` 上注册 `brave` 提供方。每次搜索先解析凭据引用，再向 Brave 发出一次 HTTP 请求，并将 Web 结果映射为通用来源字段。web 服务负责选择提供方并限制返回来源；`dsh-tool-web` 提供面向模型的 `web_search` 工具。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema、凭据查询与提供方注册 |
| [`src/provider.ts`](src/provider.ts) | Brave 请求、响应映射与错误 |
| — | 不发布运行时不变量入口：此适配器没有可产生不同观测的独立已提交状态。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面介绍共享 web 类型、提供方选择和面向模型的消费者。

- [Web 子系统](../../../docs/subsystems/web.zh.md)——搜索请求、来源与错误码。
- [Web 包映射](../README.zh.md)——此能力家族中的各个包。
- [dsh-web](../web/README.zh.md)——提供方选择与结果限制。
- [dsh-tool-web](../tool-web/README.zh.md)——面向模型的搜索工具。

-----

<a id="model-experience"></a>

## 模型体验

### 对话工具结果，间接呈现

#### 模型看到什么

对话模型通过 `dsh-tool-web` 看到来源 URL、可选标题及可选描述片段。消费者负责错误包装。

#### Token 影响

不产生单独的模型请求。来源数量与片段长度决定普通工具结果的 token 数。

#### KV 缓存影响

结果接在可复用的请求前缀后，不会使现有 KV 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制影响提供方选择及 Brave 返回的信息。

- 忽略 Web 结果之外的 Brave 响应字段，包括图片和信息框。
- 由于 `available()` 无法等待凭据查询，缺少存储密钥的已选提供方在第一次搜索时失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
