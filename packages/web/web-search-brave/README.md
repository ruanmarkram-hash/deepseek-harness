---
description: "Brave Web Search for deployments choosing, configuring, or debugging a Host search provider with per-search credential resolution."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brave

English | [中文](README.zh.md)

## Summary

Search the web through Brave's dedicated Web Search endpoint and return URLs, titles, and descriptions as citeable sources. Choose Brave when you need a search provider that makes no separate model request. Supply a Brave API key through the credentials service or launch environment; the key is resolved for each search. A missing key fails the search, and redirects are rejected before their targets are contacted.

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

Mount Brave beside the Host web service, then select it by provider id when your composition has multiple search providers.

### When to choose it

Choose Brave when you have a Brave Search API key and want a dedicated search endpoint. If you instead want DeepSeek's native server-side search, use [dsh-web-search-deepseek](../web-search-deepseek/README.md); that provider uses a separate model request.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-brave'
  config:
    apiKeyEnv: BRAVE_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `BRAVE_API_KEY` | Credential reference resolved on each search through `ctx.credentials`, or from the launch environment when that service is absent |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-brave) lists every accepted field. Keep the key value out of `cordis.yml`. When multiple search providers are mounted, set `searchProvider: brave` on the `@deepseek-ai/dsh-web` service configuration, or set `DSH_WEB_SEARCH_PROVIDER=brave` in the Host launch environment.

### Results and failures

Brave receives a `count` of at most 20; the web service applies the request's `maxResults` limit to returned sources. A missing key raises `WEB_PROVIDER_CREDENTIAL_MISSING`; cancellation raises `WEB_ABORTED`; credential lookup, HTTP, response, and transport failures raise `WEB_PROVIDER_ERROR`. Errors omit credential values and raw transport exceptions. HTTP redirects fail before the target in `Location` is followed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers provider `brave` on `ctx.web`. Each search resolves its credential reference, sends one HTTP request to Brave, and maps Web results into portable source fields. The web service selects providers and bounds returned sources; `dsh-tool-web` owns the model-facing `web_search` tool.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema, credential lookup, and provider registration |
| [`src/provider.ts`](src/provider.ts) | Brave request, response mapping, and errors |
| — | No runtime invariant companion is published: the adapter owns no independent committed state whose observations can diverge. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the shared web types, provider selection, and model-facing consumer.

- [Web subsystem](../../../docs/subsystems/web.md) — search requests, sources, and error codes.
- [Web package map](../README.md) — the packages in this capability family.
- [dsh-web](../web/README.md) — provider selection and result limits.
- [dsh-tool-web](../tool-web/README.md) — the model-facing search tool.

-----

<a id="model-experience"></a>

## Model Experience

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees source URLs, optional titles, and optional description snippets. The consumer owns the error wrapper.

#### Token effect

No separate model request is made. Source count and snippet lengths determine the ordinary tool-result tokens.

#### KV Cache effect

The result follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints affect provider selection and the information returned from Brave.

- Brave response fields beyond Web results, including images and infoboxes, are ignored.
- A selected provider with no stored key fails on its first search because `available()` cannot await credential lookup.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
