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

The version 2 framed protocol on descriptor 199 is strict JSON with a u32 big-endian length prefix, direction-exclusive messages, duplicate-key rejection, and explicit `protocolVersion: 2` in `hello`/`ready`; version 1 peers fail closed. Limits remain 16 MiB per body, 8192 logical files and 128 MiB total decoded bytes. Each file uses `prepare-file-begin {name}`, contiguous `prepare-file-chunk {offset,bytesBase64}` chunks of 1–256 KiB, and `prepare-file-end {size,sha256}`. Native incrementally hashes the complete logical file. After each request, the sender waits for its write callback and exact `prepare-file-ack {name,offset,complete}` before pulling more bytes. Chunk boundaries do not split sessions or alter JSONL bytes.

After all files finish, `prepare-complete` stages the verified export and `releasing` records irrevocable disposal intent. The child awaits `release-authorized`. Native journals `exported` then `releasing`, rejects activation in either state, observes/reaps the exiting child, and only then promotes to `prepared` and starts the adopter. The authority may also push `instruct {prepare|activate}`. Ownership transfer has a bounded 120-second deadline; per-response/write deadlines remain 20 seconds, handshake 10 seconds. Failure never reopens the old write fence.

New native journals and signed proof payloads use version 3 and allow a logical file to consume the existing 128 MiB aggregate budget. Recovery verifies old version 2 payload bytes with their original 8 MiB-per-file rule; activation of an already prepared version 2 record remains version 2. Unsupported records are errors, not empty journals. Old Hosts reject version 3: rollback cannot relabel, delete, or silently replace its journal. Operational rollback requires all owners stopped, no new user writes, and a preserved matching pre-upgrade store/journal checkpoint; otherwise use forward recovery.

`CurrentWebFd199Lifecycle` is the desktop write fence. The API gateway resolves the optional `fd199DesktopWriteFence` service lazily per dispatch: without it nothing changes; with it, every unary operation and `respond()` runs through `runDesktopOperation()`. The fence starts closed in a hosted child (state `released`), admits desktop work once recovery resolves (`none` → admitted; `exported`, `releasing`, and `prepared` → stay fenced until activation), closes permanently during a prepare transition, and reopens exactly once per cycle via `admitHostedService()` after the activated consume. Event streams stay unfenced: they are read-side, and quiesce drains active writers instead of cutting readers.

`remote-host-fd199-web-owner` provides `fd199WebOwner`: it flushes attached sessions and the persistence provider, lists every durable session including cold sessions, and reads each through an owned read handle. The current session format catalog encodes complete canonical `sessions/<id>.jsonl` entries lazily, preserving every header, event and terminal newline. The client owns export cancellation, computes SHA-256 over the streamed bytes, and waits for iterator/handle cleanup when closing. It has no per-store close acknowledgement. After native authorizes the unactivatable `releasing` state, the child awaits the launcher's hosted-only `fd199HostedExit` whole-root disposal, which closes persistence handles and descriptor 199. The Host reaps that process before writing `prepared` and relaunching the adopter, which rebinds the relay only after a later activated consume.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- The Swift-side FD199 authority, signed hosted-child supervisor, and Keychain-backed proof identity live in the signed Host app. Ordinary source-launched `dsh web` has neither inherited descriptor and cannot enter this lifecycle.
- Export bounds fail closed above 128 MiB total or 8192 files. The former 8 MiB logical-session limit does not apply to version 3 records; oversized chunks are still refused.
- Streaming avoids whole-export concatenation. The existing persistence backend still caches a whole parsed session, and one event can require an event-sized serialization buffer. Paging is not a bound on persistence memory. Backend operations without cancellation support can delay handle cleanup; no further frames are sent after cancellation.
- Attachments are not exported by this adapter; same-store adoption needs no transfer, but the attested manifest covers sessions only. FD199 is local ownership verification, not full-history upload to the phone. FD198, phone envelopes and history-response bounds are unchanged, with no iOS or relay release required.
- Descriptor validation checks that 198/199 are inherited sockets; the unforgeable part of the production trust root is the strictly validated signed Host supervisor and its sealed child launch. A local process can apply the argv suffix to its own sockets, but gains no authority over a signed Host route or protected identity.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
