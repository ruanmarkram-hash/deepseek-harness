# dsh-remote-host-fd199

English | [中文](README.zh.md)

`@deepseek-ai/dsh-remote-host-fd199` implements the hosted-runtime half of the authenticated FD199 ownership handoff. When the signed Host application launches `dsh web` as its supervised child, it passes two inherited kernel-private socketpair descriptors: 198 for the V3 relay wire and 199 for this handoff authority channel. This package turns that launch into one configured Host that serves desktop browsers and the paired phone from the same process, store, model graph, approvals, and event stream.

## Surface

The launcher (`apps/cli`) owns the invocation contract. A trailing argv suffix of exactly `--private-relay-fd 198 --private-authority-fd 199` marks a hosted runtime; the launcher validates both descriptors are inherited sockets before any boot effect, strips the suffix from app-visible arguments, and adds the overlay that mounts `remote-host-fd199`, `remote-host-fd199-web-owner`, and enables `@deepseek-ai/dsh-remote-host-v3`. An ordinary `dsh web` invocation carries neither the suffix nor the descriptors and keeps its exact existing behavior.

The framed protocol on descriptor 199 is strict JSON with a u32 big-endian length prefix, direction-exclusive message vocabularies, duplicate-key rejection, and shared byte bounds (16 MiB body, 8192 files, 8 MiB per file). The child proves the handshake (`hello`/`ready`), recovers the native journal snapshot (`recover`/`snapshot`), streams digest-verified export entries (`prepare-file`/`prepare-complete`), records its irrevocable disposal intent (`releasing`), and waits for native disposal authorization (`release-authorized`). Native journals `exported` then `releasing`, rejects activation in either state, observes/reaps the exiting child, and only then promotes to `prepared` and starts the adopter. The authority may also push `instruct {prepare|activate}`.

`CurrentWebFd199Lifecycle` is the desktop write fence. The API gateway resolves the optional `fd199DesktopWriteFence` service lazily per dispatch: without it nothing changes; with it, every unary operation and `respond()` runs through `runDesktopOperation()`. The fence starts closed in a hosted child (state `released`), admits desktop work once recovery resolves (`none` → admitted; `exported`, `releasing`, and `prepared` → stay fenced until activation), closes permanently during a prepare transition, and reopens exactly once per cycle via `admitHostedService()` after the activated consume. Event streams stay unfenced: they are read-side, and quiesce drains active writers instead of cutting readers.

`remote-host-fd199-web-owner` provides `fd199WebOwner`: it exports every durable session artifact through the store's own flush barrier and raw-artifact reads as canonical `sessions/<id>.jsonl` entries with real SHA-256 digests. It has no pretend per-store close acknowledgement. After native authorizes the unactivatable `releasing` state, the child awaits the launcher's whole-root disposal, which closes persistence handles and descriptor 199. The Host reaps that process before writing `prepared` and relaunching the adopter, which rebinds the relay only after a later activated consume.

## Known Limitations and Deferred Work

- The Swift-side FD199 authority lives in `native/remote-host-app/Sources/RemoteHostFd199`; production signing must bind to the protected Host identity Keychain handle before any real activation.
- Export bounds fail closed: a durable store exceeding 128 MiB total or 8 MiB per session artifact cannot enter this v1 transition.
- Attachments are not exported by the v1 adapter; same-store adoption needs no transfer, but the attested manifest covers sessions only.
- Descriptor validation checks only that 198/199 are inherited sockets; the unforgeable part of the trust root is the signed Host supervisor itself, whose production spawn path and Keychain-bound signing identity remain deferred work. A local process can self-apply the argv suffix against its own sockets today, which yields no privilege beyond what that local user already has.
