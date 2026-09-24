---
description: "Transfer signed Host runtime ownership over inherited descriptor 199."
kind: "package-reference"
---

# dsh-remote-host-fd199

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-remote-host-fd199` implements the hosted-runtime half of the authenticated FD199 ownership handoff. When the signed Host application launches `dsh web` as its supervised child, it passes two inherited kernel-private socketpair descriptors: 198 for the V3 relay wire and 199 for this handoff authority channel. This package turns that launch into one configured Host that serves desktop browsers and the paired phone from the same process, store, model graph, approvals, and event stream.

## Table of Contents

- [Surface](#surface)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="surface"></a>

## Surface

The launcher (`apps/cli`) owns the invocation contract. A trailing argv suffix of exactly `--private-relay-fd 198 --private-authority-fd 199` marks a hosted runtime; the launcher validates both descriptors are inherited sockets before any boot effect, strips the suffix from app-visible arguments, and adds the overlay that mounts `remote-host-fd199`, `remote-host-fd199-web-owner`, and enables `@deepseek-ai/dsh-remote-host-v3`. An ordinary `dsh web` invocation carries neither the suffix nor the descriptors and keeps its exact existing behavior.

The framed protocol on descriptor 199 is strict JSON with a u32 big-endian length prefix, direction-exclusive message vocabularies, duplicate-key rejection, and shared byte bounds (16 MiB body, 8192 files, 8 MiB per file). The child proves the handshake (`hello`/`ready`), recovers the native journal snapshot (`recover`/`snapshot`), streams digest-verified export entries (`prepare-file`/`prepare-complete`), records its irrevocable disposal intent (`releasing`), and waits for native disposal authorization (`release-authorized`). Native journals `exported` then `releasing`, rejects activation in either state, observes/reaps the exiting child, and only then promotes to `prepared` and starts the adopter. The authority may also push `instruct {prepare|activate}`.

`CurrentWebFd199Lifecycle` is the desktop write fence. The API gateway resolves the optional `fd199DesktopWriteFence` service lazily per dispatch: without it nothing changes; with it, every unary operation and `respond()` runs through `runDesktopOperation()`. The fence starts closed in a hosted child (state `released`), admits desktop work once recovery resolves (`none` → admitted; `exported`, `releasing`, and `prepared` → stay fenced until activation), closes permanently during a prepare transition, and reopens exactly once per cycle via `admitHostedService()` after the activated consume. Event streams stay unfenced: they are read-side, and quiesce drains active writers instead of cutting readers.

`remote-host-fd199-web-owner` provides `fd199WebOwner`: it flushes attached sessions and the persistence provider, lists every durable session including cold sessions, and reads each through an owned read handle. The current session format catalog encodes canonical `sessions/<id>.jsonl` entries with real SHA-256 digests. It has no per-store close acknowledgement. After native authorizes the unactivatable `releasing` state, the child awaits the launcher's hosted-only `fd199HostedExit` whole-root disposal, which closes persistence handles and descriptor 199. The Host reaps that process before writing `prepared` and relaunching the adopter, which rebinds the relay only after a later activated consume.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- The Swift-side FD199 authority, signed hosted-child supervisor, and Keychain-backed proof identity live in the signed Host app. Ordinary source-launched `dsh web` has neither inherited descriptor and cannot enter this lifecycle.
- Export bounds fail closed: a durable store exceeding 128 MiB total or 8 MiB per session artifact cannot enter this v1 transition.
- Attachments are not exported by the v1 adapter; same-store adoption needs no transfer, but the attested manifest covers sessions only.
- Descriptor validation checks that 198/199 are inherited sockets; the unforgeable part of the production trust root is the strictly validated signed Host supervisor and its sealed child launch. A local process can apply the argv suffix to its own sockets, but gains no authority over a signed Host route or protected identity.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
