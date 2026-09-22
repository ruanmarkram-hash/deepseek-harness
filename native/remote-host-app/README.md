# dsh-remote-host-app

English | [中文](README.zh.md)

`dsh-remote-host-app` is the signed persistent macOS owner for DSH remote pairing and the hosted Web runtime. It is separate from the Electron Desktop renderer. The Host validates its own signed container before it reads trust resources and owns relay credentials and transport state in native code. The native owner exposes no inbound public listener, token, private key, or generic identity API; the sealed hosted child serves only its configured loopback Web origin.

## Installation and packaged runtime trust

The release runs only as a canonical, non-symlinked `DSHHost.app` at `/Applications` when root-owned or at the current user's `~/Applications` when owned by that user. The logged-in owner is an explicit trust principal for the user installation. Both locations require the sealed designated Host requirement, a strict whole-app code seal, one permitted owner throughout the app, no extended ACL, no group or world writer, verified embedded manifests and digests, and valid nested-code requirements.

The app contains the signed native children, `DSHRemoteHostKeychain.xpc`, the pinned Node executable, the bundled `dsh web` entrypoint, and its complete copied runtime closure. Production never resolves Node from `PATH`, follows a source-checkout path, or executes an external symlink farm. The outer app signature seals the fixed resource-relative layout and install-specific hosted-Web configuration before any hosted code runs.

`CFBundleIconFile` selects the shared `DeepSeek.icns` resource, copied into the Host before signing. The [Desktop icon packaging reference](../../apps/desktop/README.md) owns artwork generation and verification.

## Pairing and activation

**Pair iPhone from anywhere…** creates a short-lived pairing code and presents it as both a QR code and selectable manual text. The phone submits only its public enrollment offer. The Host displays the complete fingerprint and device label; the person at the Mac must compare that fingerprint with the phone and approve it before provisioning can create a route or return the protected invitation. The file-import action applies the same bounded public-offer parsing and Host confirmation rule.

The pairing dialog reserves space for the complete QR code, including its white scanning margin, and wraps the full manual code without truncation. The selectable manual code remains available if QR rendering fails.

**Check pairing state**, available in the startup controls and Host menu, compares the existing native pairing with the standard JSON public device and Host directories under the signed hosted-Web configuration's DSH home. It reports only presence and equality booleans or fixed read/validation failures, never identifiers, keys, tokens, or arbitrary error text. Reads are bounded and reject symbolic links, nonregular files, and paths writable by other users. The check cannot repair enrollment, change Keychain authorization, copy an invitation, or start a runtime or network connection; matching records do not establish connectivity. **Revoke paired phone…** remains in the Host menu.

**Repair matching pairing records…** is a separate, twice-confirmed local action for the single already-approved phone when both durable enrollment incarnations disagree with its native credential. All external writers, including Desktop and the Web service, must be stopped first. The Host refuses retained runtime ownership, an occupied Web port, a native route lease, provisioning/revocation recovery, or any used, pending, revoking or missing native epoch. The existing public records must form one consistent same-phone device/Host/route tuple at epoch zero with matching public keys and label. Repair projects only the current native public route coordinates, preserving unrelated metadata, file permissions, credentials, invitations and native epochs. It never weakens normal enrollment admission.

The private `storages/.pairing-repair/journal.json` retains exact original and target public bytes with hashes before any replacement. Each file replacement is atomic and checks its preimage; partial failure rolls back only known bytes. An interrupted journal requires explicit recovery, and an unexpected third-party write is never overwritten. Hosted startup and activation reject prepared or invalid journals. Completed journals remain recoverable backups without preventing later legitimate runtime writes. The port reservation excludes a network listener, not arbitrary external file writers.

After pairing, **Start hosted runtime** launches the sealed hosted child and recovers an eligible signed FD199 journal. The hosted child receives relay records on fixed descriptor 198 and authority handoff records on fixed descriptor 199; it receives neither the Host token nor private agreement material. **Activate paired phone** completes the signed FD199 ownership transition before the native Host opens the authenticated V3 relay WebSocket. The browser and phone then use the same hosted runtime.

After the authenticated native handshake finalizes an epoch, the Host waits for the child's exact durable epoch-synchronization acknowledgment before forwarding the phone connection. This public, route-bound synchronization does not change the native ledger or mobile handshake.

The native epoch ledger permits one live Host route owner, commits an epoch only after the authenticated handshake, and reconciles a lost receipt without skipping the next epoch. A phone network interruption can reconnect through the retained route at the Host-issued next epoch. After a clean Host restart, **Start hosted runtime** restores the verified journal, active route, and hosted state before phone activation resumes.

**Revoke paired phone…** requires a second Host confirmation. It retires the hosted child's public route state, installs the durable native revocation fence, stops the retained relay, performs idempotent remote deletion and local Keychain cleanup, clears the hosted owners, and permits a later fresh pairing. Ambiguous remote or local cleanup remains recoverable and never restores a usable invitation.

## Native security boundaries

The FD198/FD199 channels use bounded Remote Wire records and fixed direction-specific vocabularies. The Host closes unrelated descriptors before spawning a child, sets close-on-exec where ownership transfers require it, validates strict record order and public metadata, and tears down and reaps children on malformed input, overflow, timeout, EOF, or shutdown. Route secrets and private keys never cross either channel.

The V3 WebSocket transport pins the production origin, route path, Host-token subprotocol, enrollment lifetime, route generation, and connection epoch. Its authenticated eight-flight handshake derives directional X25519 material through the protected agreement service, authenticates canonical per-message data, rejects replay or substitution, and zeroizes native key material on teardown.

Relay credentials are created with a trusted-application Keychain ACL for the signed Host executable. Replacing an existing provisioning, route, cleanup, or epoch value updates only `kSecValueData`; it never replaces `kSecAttrAccess`. Reads, duplicate updates, and deletes use a noninteractive authentication context, so unexpected authorization fails instead of opening SecurityAgent.

## Release and package references

The [remote-pairing release cookbook](../../docs/cookbook/releasing-dsh-remote-pairing.md) is the authoritative clean-build, signing, relocation, notarization, TestFlight, different-network pairing, reconnect, restart, and revoke procedure. The [hosted runtime packaging reference](docs/hosted-runtime-runbook.md) records the pinned inputs, assembly boundary, and installation trust checks. Do not duplicate those operations here.
