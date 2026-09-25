---
description: "The zero-config progress-message policy that keeps users informed during tool work while preserving one distinct final answer, for composition authors and maintainers."
kind: "package-reference"
---

# @deepseek-ai/dsh-progress-narration

English | [中文](README.zh.md)

## Summary

`dsh-progress-narration` tells an agent to keep the user informed while it works: one short message before the first tool call, then updates only at meaningful phase changes, findings, or blockers. It explicitly separates observable progress from hidden reasoning, tells the agent to continue after each update, and reserves one final answer for the completed outcome. Mount it globally for every agent or inside an agent preset for one scoped composition. The package adds a fixed prompt section and no tools, events, timers, or configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row wherever its policy should apply. A deployment-level row reaches every agent; a row mounted inside an agent preset reaches only agents created from that scoped composition.

### When to choose it

Choose this package when users should see useful progress during multi-step tool work without seeing a line for every command or any private reasoning. Skip it for unattended agents whose transcript should contain only tool activity and the final answer, or when a deployment persona already owns an equivalent policy.

### Minimal configuration

No configuration fields exist; mount the row directly:

```yaml
- id: progress-narration
  name: '@deepseek-ai/dsh-progress-narration'
```

Inside an agent preset, use the same row in that preset's plugin list. Removing or unloading the row removes the section from subsequent prompt assemblies.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals: click to expand</summary>

`apply` registers the static `interaction:progress-narration` section through `ctx.systemPrompt.section()`. Its first-party order is 400, after deployment persona text and before plan or team policies. The prompt registry applies the mounting context's scope, rejects duplicate names within that scope, and removes the contribution when the plugin fiber unloads.

**Runtime invariant:** No companion is published. The package retains no mutable state or independent event stream; the system-prompt registry owns section uniqueness, scope, and disposal, while package tests assert the fixed contribution directly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, exported section constants, and fixed progress policy |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Persona package](../persona/README.md): compose a per-agent identity beside this behavioral policy.
- [Agent presets package](../agent-preset/README.md): mount the row for selected agent compositions.
- [System prompt subsystem](../../../docs/subsystems/system-prompt.md): section ordering, scopes, rendering, and lifecycle.
- [Adding a package](../../../docs/cookbook/adding-a-package.md): repository rules for prompt plugins and package docs.

-----

<a id="model-experience"></a>
## Model Experience

### Progress narration policy

#### What the model sees

Every request in an effective mount scope includes this fixed system-prompt section:

##### Verbatim progress policy

```markdown
Keep the user informed while you work:
- Before your first tool call, send a short user-facing progress message that states the action you are taking.
- Send another short progress message only when you begin a meaningful new phase, discover an important finding, or encounter a blocker. Do not narrate every routine tool call.
- State observable actions and findings. Never reveal hidden chain-of-thought, private reasoning, or internal deliberation.
- A progress message does not end the turn. Continue working after sending it.
- After the work is complete, send exactly one final answer that summarizes the outcome and any remaining blockers.
```

#### Token effect

Fixed while mounted: the five-rule policy is included in every model request for each effective scope. The package adds no tool schema, tool result, or dynamic context tokens.

#### KV Cache effect

The section is static at first-party order 400 for the life of the mount, so repeated requests from the same agent preserve it in the reusable prompt prefix. Agents with different scoped compositions may diverge from this section onward.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the policy can guarantee.

- **Advisory rather than enforced:** the package guides the model but does not reject a tool call that lacks a preceding progress message or merge multiple final answers.
- **No elapsed-time reminder:** the static section cannot detect a long silent operation; a separate lifecycle plugin is required if time-based reminders become necessary.
- **No semantic activity summary:** the model emits ordinary assistant messages under this policy; transcript grouping and tool-count summaries belong to the client conversation projection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers: click to expand</summary>

None.

</details>
