---
description: "Lists the signed Host's bundled plugins and persists switches for reviewed optional rows through the hostPlugins Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-hosted-plugin-controls

English | [中文](README.zh.md)

## Summary

The Mac Host can show its bundled plugins and switch reviewed optional features without changing signed executable files. `hostPlugins/list` includes locked rows so clients can explain why they cannot be switched. `hostPlugins/setEnabled` accepts one exact row ID and reconciles the live Host before saving the choice. This package does not install or activate downloaded executable packages.

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

The signed `dsh` Host launcher mounts this service after validating its fixed bundle composition. Clients call `hostPlugins/list()` and `hostPlugins/setEnabled({ id, enabled })` through the authenticated Remote connection. Ordinary profiles use the separate [Plugin Manager](../../boot/plugin-manager/README.md).

### Switchable rows

The native computer use policy and progress narration are switchable. Computer use's registry stays loaded when its policy is off; the policy owns the native tool registrations and their per-call approval. All other signed rows, including connection, authentication, storage, and previously disabled rows, are fixed and return `required: true` with a reason.

### Persistence and failure

The Host stores only a version and disabled row IDs in its owner-only `hosted-plugins.json`. Unknown IDs, extra fields, duplicates, symlinks, unsafe permissions, and outside changes stop startup or edits. A successful switch updates the running Loader first and atomically saves the data; a failed switch restores the previous composition and leaves the file unchanged. Plugin edits and Hosted Settings edits share one composition lock so neither can replace the other's live rows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The launcher supplies its sealed patch list to `HostedPluginState`, which checks each optional ID against the expected signed module name. State changes add only `{ id, disabled: true }` patches after the fixed bundle and settings patches. `HostedPluginControls` publishes a narrow Typert Remote; its catalog reads Loader state rather than loading packages from the writable Harness home. No runtime invariant companion is published: the catalog is projected directly from the Loader and the saved ID set.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Owner-only data, reconciliation, and `hostPlugins` Remote |
| [`src/types.ts`](src/types.ts) | Catalog and request payloads |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CLI launcher](../../../apps/cli/README.md) — signed Host composition and startup.
- [Plugin inventory](../plugin-inventory/README.md) — read-only Loader state for ordinary clients.
- [Plugin Manager](../../boot/plugin-manager/README.md) — downloaded packages in mutable profiles.

-----

<a id="model-experience"></a>
## Model Experience

None, as this Host control service registers no model-facing tools or prompt text. Switching the progress narration row changes that row's separate prompt contribution.

#### KV Cache effect

None from this package; a changed prompt contribution follows its owning plugin's cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These controls cover reviewed modules already in the signed Host build.

- **Downloaded packages** — the Host does not read writable profile manifests or import downloaded executable code, so this catalog has no downloaded rows.
- **No subscription** — clients call `list()` again to observe another client's change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
