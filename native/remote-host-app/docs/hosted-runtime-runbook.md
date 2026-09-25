# Hosted runtime packaging reference

## Summary

Use this reference to check native package inputs, installation trust, and complete-history ownership transfer before releasing the Host. The [remote-pairing release cookbook](../../../docs/cookbook/releasing-dsh-remote-pairing.md) owns the clean-build, signing, notarization, TestFlight, and different-network iPhone acceptance sequence. Source tests do not replace signed-build or physical-phone acceptance.

## Table of Contents

- [Reproducible inputs](#reproducible-inputs)
- [Assembly boundary](#assembly-boundary)
- [Installation trust](#installation-trust)
- [Legacy test helpers](#legacy-test-helpers)
- [FD199 streamed history handoff](#fd199-streamed-history-handoff)

## Reproducible inputs

- `scripts/acquire-pinned-node.sh` downloads the official Node.js v24.19.0 darwin-arm64 archive from `nodejs.org` and verifies SHA-256 `8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d` before publishing `dist/pinned-node`.
- `scripts/bundle-dsh-web.mjs` derives the repository root from its own URL and generates `dist/dsh-web.mjs` from the checked-out source.
- Both `dist` outputs are ignored build inputs. They are regenerated and verified for each release, never committed.

## Assembly boundary

Use `scripts/assemble-host-owner.sh`, not the lower-level Host assembler. The owner wrapper embeds and signs the XPC Keychain service after assembling the Host, sealed gateway, hosted child, complete copied module closure, manifests, and install-specific Web configuration. The hosted child arguments are a single set and must include:

- the pinned Node executable and generated Web entrypoint;
- an absolute DSH state home containing the declared patch file;
- the patch path relative to that state home;
- the fixed loopback Web port and trusted Host name.

The assembler requires an Apple Development identity for a local pre-release smoke or a Developer ID Application identity for distribution. It rejects an existing output path and verifies every signature it produces.

## Installation trust

The production runtime accepts exactly one canonical, non-symlinked `DSHHost.app` at either `/Applications` with root ownership or the current user's `~/Applications` with current-user ownership. Every app descendant must be a regular file or directory owned by that installation owner, have no extended ACL, and have no group or world write bit. The whole app code seal, sealed designated requirement, manifests, digests, nested Node binary, native addons, and XPC service are verified before hosted code runs.

The logged-in owner is an explicit trust principal for the user-level install. Mutable session state remains outside the app in the configured DSH home. No runtime dependency or executable is loaded from the source checkout after assembly.

Before any notarization submission, run the developer-signed relocation smoke, launch the relocated app from `~/Applications`, start the hosted runtime, and prove the Keychain service does not prompt when an existing provisioning item is updated. A release that has not passed those checks is not a notarization candidate.

## Legacy test helpers

[OfflineWebOwnerHandoff](../GatewayRuntime/offline-web-owner-handoff.ts) and the [configured-graph handoff helpers](../GatewayRuntime/native-owned-configured-dsh-handoff.ts) have test callers only. Their version-2 capabilities, whole-file arrays, 8 MiB file limit, and `files: {name, sha256, bytes}` journal remain frozen. They neither implement the production streaming protocol nor decode the Swift `manifest: {name, sha256, size}` journal. The shared version number does not imply schema compatibility. Production uses the [remote-host-fd199 package](../../../packages/mobile/remote-host-fd199/README.md) and [Swift authority](../Sources/RemoteHostFd199/Fd199AuthorityService.swift).

## FD199 streamed history handoff

The co-packaged Host and child must use FD199 wire version 2 without downgrade. The stopped Web owner exports every durable session as complete canonical JSONL, including the terminal newline. Begin/chunk/end exchanges carry one logical file at a time; chunks contain at most 256 KiB decoded bytes. The sender waits for the write callback and the matching name/offset/completion acknowledgement before reading the next chunk. Native incrementally hashes the received bytes and keeps completed manifest entries, not complete file buffers.

The complete export remains limited to 128 MiB decoded bytes and 8,192 files. A logical file may consume the aggregate byte budget; new exports have no separate 8 MiB logical-file ceiling. The 16 MiB frame limit remains unchanged. Native must also bound queued and buffered ingress, including peers that ignore acknowledgements. Missing, duplicated, reordered, corrupt, incomplete, or over-quota exports must fail closed without staging a partial journal or reopening desktop writes.

Streaming bounds transport and additional export buffering, not the existing persistence cache. Paged `SessionHandle.read()` still reads and caches complete parsed session logs; one serialized event may also exceed the transport chunk size. This release does not change persistence formats, omit history, or promise byte-bounded phone history responses. FD198 and the phone's encrypted message limits remain separate.

### Ownership and deadlines

Complete verification precedes the exported journal. Native then records releasing, authorizes the former child to close its store, and waits for actual PID exit/reap before prepared promotion. The adopter requires explicit activation before serving. Cancellation, timeout, or disconnect must abort export work, close active readers, stop the authority and child, and retain the journal for verified recovery. No interrupted transaction resumes by retransmitting chunks.

The ownership-transfer wait is bounded at 120 seconds, including quiescence, export, release, and reap. Ordinary child readiness remains bounded at 15 seconds. Per-exchange write/acknowledgement timeouts remain 20 seconds; the initial handshake remains 10 seconds. Expiry must not promote or activate an ownership record.

### Journal compatibility and rollback

New complete exports write Swift journal/proof version 3. Recovery accepts versions 2 and 3 with each record's exact signed version. Version 2 retains its 8 MiB file admission rule; activating an already prepared version-2 record signs and persists version 2. Only a fresh export writes version 3. Both versions retain the aggregate/file-count budgets and private journal checks. A forged version change must fail verification.

An older Host rejects every version-3 journal, including a small export. Never relabel, delete, truncate, or replace that journal with an older activated record to make rollback start. Operational rollback is allowed only before new user writes: stop and reap all owners, preserve the candidate and pre-upgrade journals privately, verify that the pre-upgrade journal and quiesced store checkpoint match, then restore the old binary with that matching checkpoint. If new writes occurred or checkpoint equivalence cannot be established, refuse rollback and retain history for forward recovery. No automatic backup-selection or downgrade path is added.

### Release evidence

Release acceptance requires a real TypeScript-to-Swift synthetic export above 10 MiB, including one line above 256 KiB, with identical canonical lengths/digests and unchanged durable history after adoption. Verify exact aggregate limits, interruption and malicious ordering, bounded ingress, version-2 proof recovery/activation, older-reader version-3 refusal without mutation, deadline cleanup, and activation only after actual reap. The assembled temporary-profile Host must pass the existing phone list/prompt/approval regression. This is a Host-only release; the handoff change does not require an iOS release, re-enrollment, key rotation, or relay change.

For the real-peer Swift test, set `DSH_FD199_NODE` to the absolute Node executable and `DSH_FD199_NODE_FIXTURE` to the absolute path of [fd199-stream-peer.ts](../Tests/Fixtures/fd199-stream-peer.ts) before running `swift test --package-path native/remote-host-app` from the repository root. Install workspace dependencies first. A run that skips this fixture is not cross-language release evidence.
