---
description: "零配置的进度消息策略，使 agent 在使用工具期间向用户同步进展，同时保留一条独立最终答复，供组合作者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-progress-narration

[English](README.md) | 中文

## 概述

`dsh-progress-narration` 指示 agent（智能体）在工作期间让用户了解进展：首次工具调用前发送一条简短消息，之后仅在重要阶段变化、发现或阻塞时更新。它明确区分可观察进展与隐藏推理，要求 agent 在每次更新后继续工作，并为完成后的结果保留一条最终答复。全局挂载可覆盖所有 agent，也可在 agent preset 内挂载以仅覆盖一个作用域组合。本包只增加一个固定提示词段，不增加工具、事件、计时器或配置。

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

在需要应用此策略的位置挂载该行。部署级挂载覆盖每个 agent；在 agent preset 内挂载的行只覆盖由该作用域组合创建的 agent。

### 何时选择

当用户应在多步骤工具工作期间看到有用进度，同时不希望每条命令都有解说，也不应看到任何私有推理时，选择本包。对于只应记录工具活动与最终答复的无人值守 agent，或部署人设已经拥有等效策略时，请跳过本包。

### 最小配置

不存在配置字段；直接挂载该行：

```yaml
- id: progress-narration
  name: '@deepseek-ai/dsh-progress-narration'
```

在 agent preset 中，将同一行放入该 preset 的插件列表。删除或卸载该行后，后续提示词组装不再包含此段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节：点击展开</summary>

`apply` 通过 `ctx.systemPrompt.section()` 注册静态 `interaction:progress-narration` 段。它的第一方顺序为 400，位于部署人设文本之后、计划或团队策略之前。提示词注册表应用挂载上下文的作用域，拒绝该作用域内的重复名称，并在插件 fiber 卸载时删除此贡献。

**运行时不变式：**不发布 companion。本包不保留可变状态，也没有独立事件流；system-prompt 注册表负责 section 唯一性、作用域与释放，而包测试直接断言固定贡献。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、导出的段常量与固定进度策略 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。

- [Persona 包](../persona/README.zh.md)：在此行为策略旁组合每个 agent 的身份。
- [Agent presets 包](../agent-preset/README.zh.md)：为选定的 agent 组合挂载该行。
- [系统提示词子系统](../../../docs/subsystems/system-prompt.zh.md)：段顺序、作用域、渲染与生命周期。
- [新增包](../../../docs/cookbook/adding-a-package.zh.md)：提示词插件与包文档的仓库规则。

-----

<a id="model-experience"></a>
## 模型体验

### 进度解说策略

#### 模型看到什么

有效挂载作用域中的每次请求都包含以下固定系统提示词段：

##### 进度策略原文

```markdown
Keep the user informed while you work:
- Before your first tool call, send a short user-facing progress message that states the action you are taking.
- Send another short progress message only when you begin a meaningful new phase, discover an important finding, or encounter a blocker. Do not narrate every routine tool call.
- State observable actions and findings. Never reveal hidden chain-of-thought, private reasoning, or internal deliberation.
- A progress message does not end the turn. Continue working after sending it.
- After the work is complete, send exactly one final answer that summarizes the outcome and any remaining blockers.
```

#### Token 影响

挂载期间保持固定：每个有效作用域的每次模型请求都包含这五条规则。本包不增加工具 schema、工具结果或动态上下文 token。

#### KV Cache 影响

该段在挂载生命周期内以第一方顺序 400 保持静态，因此同一 agent 的重复请求会把它保留在可复用提示词前缀中。采用不同作用域组合的 agent 可能从此段开始产生差异。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定该策略能够保证的范围。

- **提供指引而非强制执行：**本包引导模型，但不会拒绝前面没有进度消息的工具调用，也不会合并多条最终答复。
- **没有按耗时触发的提醒：**静态段无法检测长时间静默操作；若将来需要按时间提醒，必须使用单独的生命周期插件。
- **没有语义活动摘要：**模型依照该策略发送普通 assistant 消息；记录分组与工具计数摘要归客户端会话投影所有。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文：点击展开</summary>

无。

</details>
