---
description: "列出已签名 Host 的内置插件，并通过 hostPlugins Remote 持久化经过审查的可选条目开关。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hosted-plugin-controls

[English](README.md) | 中文

## 概述

Mac Host 可以展示内置插件，并在不修改已签名可执行文件的情况下切换经过审查的可选功能。`hostPlugins/list` 包含锁定条目，便于客户端解释为何不能切换。`hostPlugins/setEnabled` 接受一个精确的条目 ID，先调整运行中的 Host，再保存选择。本包不安装或激活下载的可执行插件包。

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

已签名的 `dsh` Host 启动器在验证固定的 bundle 组合后挂载此服务。客户端通过已认证的 Remote 连接调用 `hostPlugins/list()` 和 `hostPlugins/setEnabled({ id, enabled })`。普通 profile 使用独立的[插件管理器](../../boot/plugin-manager/README.zh.md)。

### 可切换条目

原生计算机使用策略和进度播报可以切换。策略关闭时，计算机使用注册服务保持加载；策略负责原生工具注册及每次调用的批准。其他所有已签名条目，包括连接、认证、存储和原本禁用的条目，均为固定条目，并返回 `required: true` 及原因。

### 持久化与失败

Host 只在仅所有者可读写的 `hosted-plugins.json` 中保存版本和已禁用的条目 ID。未知 ID、额外字段、重复项、符号链接、不安全权限及外部修改会阻止启动或编辑。成功切换会先更新运行中的 Loader，再原子保存数据；失败时恢复先前组合且不更改文件。插件编辑与 Hosted Settings 编辑共用一个组合锁，避免彼此覆盖运行中的条目。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

启动器向 `HostedPluginState` 提供固定的补丁列表；该状态对象用预期的已签名模块名称检查每个可选 ID。状态变化只在固定 bundle 和设置补丁之后添加 `{ id, disabled: true }` 补丁。`HostedPluginControls` 发布受限的 Typert Remote；其目录读取 Loader 状态，不从可写的 Harness home 加载包。不发布运行时 invariant 配套项：目录直接投影自 Loader 和已保存的 ID 集合。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 仅所有者可读写的数据、重新组合与 `hostPlugins` Remote |
| [`src/types.ts`](src/types.ts) | 目录与请求载荷 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [CLI 启动器](../../../apps/cli/README.zh.md) — 已签名 Host 的组合与启动。
- [插件清单](../plugin-inventory/README.zh.md) — 普通客户端的只读 Loader 状态。
- [插件管理器](../../boot/plugin-manager/README.zh.md) — 可变 profile 中的下载包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此 Host 控制服务不注册面向模型的工具或提示文本。切换进度播报条目会改变该条目单独贡献的提示内容。

#### KV 缓存影响

本包没有影响；提示内容变化遵循所属插件的缓存行为。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些控制仅覆盖已签名 Host 构建中经过审查的模块。

- **下载的包** — Host 不读取可写的 profile 清单，也不导入下载的可执行代码，因此此目录没有下载条目。
- **没有订阅** — 客户端再次调用 `list()` 才能看到其他客户端的更改。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
