---
description: "Require one approval for each native desktop call and reserve the desktop for one live Agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-computer-use-policy

English | [中文](README.zh.md)

## Summary

Require approval before each desktop observation or action. The first admitted call reserves the native provider for that Agent until its Agent or Session is disposed. Other Agents receive an error while the owner remains live, including between turns. Missing approval support denies access. Unloading this package also removes and shuts down the native provider.

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

Mount this optional row beside the computer-use, tool, and system-prompt services. Compose the approval service and an interactive answerer to allow calls.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-computer-use-policy'
```

The row accepts no configuration fields. It mounts the official native provider itself; do not mount that provider separately. The [package-owned authoring overlay](examples/native-computer-use-policy.cordis.yml) adds this row and optional progress narration after the deployment installs these optional packages.

Approval is per call, including observations. A missing answerer, rejected request, cancelled request, throwing answerer, or absent approval service never dispatches the native call. The session approval policy `never` also rejects calls. A refused first call releases its reservation; an admitted call retains ownership until Agent or Session disposal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals: click to expand</summary>

The policy reserves ownership before awaiting approval. A registry guard requires the exact execution's approval even when another pre-execute listener returns allow. The dispatch wrapper combines caller, policy, and lease cancellation. Retiring ownership aborts every pending call and remains reserved until all calls settle. Native child disposal removes tools and awaits SDK shutdown before policy cleanup completes.

No invariant companion is published: the lease and approval evidence are private execution state with no independent registry or persisted projection to reconcile. The Loader tests exercise denial, concurrent ownership, cancellation, disposal, and durable approval events through production services.

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Policy and native child ownership |
| [tests/loader-composition.spec.ts](tests/loader-composition.spec.ts) | Real composition and lifecycle regressions |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These packages own the underlying capabilities.

- [Native provider](../computer-use-cua-driver-native/README.md): native tools, images, and shutdown.
- [User approval](../../interaction/user-approval/README.md): audited one-shot decisions.
- [Progress narration](../../preset/progress-narration/README.md): same-Session progress messages.
- [Tool runtime](../../core/tools/README.md): execution guards.

-----

<a id="model-experience"></a>
## Model Experience

### Guarded native calls

#### What the model sees

The native provider supplies its unchanged guidance and tool catalog. Policy failures return tool errors. Calls without an approval grant report `Computer Use requires approval before this call can observe or control the live desktop.` A competing Agent receives `Computer Use is already owned by another live Agent. Close that Agent before using the desktop here.`

#### Token effect

This policy adds no prompt section or tool schemas. Its errors add ordinary tool-result text; approval audit events do not enter model history. The native provider owns its catalog and result-token costs.

#### KV Cache effect

The static native catalog remains unchanged. Policy outcomes append to the existing Session history and do not replace the prompt prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Ownership covers this plugin's native provider only.

- Other processes, applications, and human input can still change the desktop.
- Cancellation cannot roll back input already delivered by the native SDK.
- A long-lived idle Agent retains the lease; close it before another Agent takes ownership.
- Approval needs an open turn so its audit pair can be persisted. Bare calls outside a turn fail closed.
- Native platform permissions remain separate from approval; installation grants no desktop access.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers: click to expand</summary>

None.

</details>
