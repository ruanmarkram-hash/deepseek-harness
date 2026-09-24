---
description: "每次原生桌面调用均需单独批准，并将桌面保留给一个活动 Agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-computer-use-policy

[English](README.md) | 中文

## 概述

每次桌面观察或操作前都需要批准。首次获准调用将原生提供方保留给该 Agent，直到其 Agent 或 Session 被释放。所有者仍然活动时，其他 Agent 会收到错误，回合之间也不例外。缺少批准支持时拒绝访问。卸载此包也会移除并关闭原生提供方。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将此可选配置项挂载在 computer-use、工具和系统提示服务旁边。组合批准服务和交互式应答器以允许调用。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-computer-use-policy'
```

此配置项不接受配置字段。它自行挂载官方原生提供方；请勿单独挂载该提供方。[编写用覆盖层](../../../apps/cli/config/examples/native-computer-use-policy.cordis.yml) 添加此配置项和可选的进度说明。

批准按每次调用执行，包括观察。缺少应答器、请求被拒绝或取消、应答器抛出异常、缺少批准服务时，均不会分派原生调用。Session 批准策略 `never` 同样拒绝调用。首次调用被拒绝会释放预留；获准调用会保留所有权直到 Agent 或 Session 被释放。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节：点击展开</summary>

策略在等待批准前预留所有权。即使其他预执行监听器返回允许，注册表守卫仍要求该次执行的批准。分派包装器合并调用方、策略和租约的取消信号。终止所有权会中止每个待处理调用，并在全部调用结束前保持预留。策略清理完成前，原生子插件释放会移除工具并等待 SDK 关闭。

此包不发布 invariant 配套模块：租约和批准证据是私有执行状态，没有需要对账的独立注册表或持久化投影。Loader 测试通过生产服务验证拒绝、并发所有权、取消、释放和持久化批准事件。

| 文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | 策略和原生子插件所有权 |
| [tests/loader-composition.spec.ts](tests/loader-composition.spec.ts) | 真实组合和生命周期回归测试 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

以下包负责底层能力。

- [原生提供方](../computer-use-cua-driver-native/README.zh.md)：原生工具、图像和关闭。
- [用户批准](../../interaction/user-approval/README.zh.md)：可审计的单次决定。
- [进度说明](../../preset/progress-narration/README.zh.md)：同一 Session 中的进度消息。
- [工具运行时](../../core/tools/README.zh.md)：执行守卫。

-----

<a id="model-experience"></a>
## 模型体验

### 受保护的原生调用

#### 模型看到的内容

原生提供方提供未修改的指导和工具目录。策略失败返回工具错误。未获得批准的调用报告 `Computer Use requires approval before this call can observe or control the live desktop.` 竞争的 Agent 收到 `Computer Use is already owned by another live Agent. Close that Agent before using the desktop here.`

#### Token 影响

此策略不添加提示段落或工具 schema。错误会添加普通工具结果文本；批准审计事件不进入模型历史。原生提供方负责其目录和结果的 token 成本。

#### KV 缓存影响

静态原生目录保持不变。策略结果追加到现有 Session 历史，不替换提示前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

所有权仅涵盖此插件的原生提供方。

- 其他进程、应用和人工输入仍可改变桌面。
- 取消无法回滚原生 SDK 已提交的输入。
- 长期空闲的 Agent 仍持有租约；其他 Agent 接管前需将其关闭。
- 批准需要开放的回合以持久化审计事件对。回合外的直接调用会被拒绝。
- 原生平台权限与批准相互独立；安装不会授予桌面访问权。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文：点击展开</summary>

无。

</details>
