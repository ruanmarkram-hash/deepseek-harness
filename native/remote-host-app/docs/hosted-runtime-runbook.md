# Hosted runtime packaging reference

The authoritative clean-build, signing, notarization, TestFlight, and
different-network iPhone acceptance sequence is in
[`docs/cookbook/releasing-dsh-remote-pairing.md`](../../../docs/cookbook/releasing-dsh-remote-pairing.md).
This file records only the native package inputs and trust boundaries.

## Reproducible inputs

- `scripts/acquire-pinned-node.sh` downloads the official Node.js v24.19.0
  darwin-arm64 archive from `nodejs.org` and verifies SHA-256
  `8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d`
  before publishing `dist/pinned-node`.
- `scripts/bundle-dsh-web.mjs` derives the repository root from its own URL and
  generates `dist/dsh-web.mjs` from the checked-out source.
- Both `dist` outputs are ignored build inputs. They are regenerated and
  verified for each release, never committed.

## Assembly boundary

Use `scripts/assemble-host-owner.sh`, not the lower-level Host assembler. The
owner wrapper embeds and signs the XPC Keychain service after assembling the
Host, sealed gateway, hosted child, complete copied module closure, manifests,
and install-specific Web configuration. The hosted child arguments are a
single set and must include:

- the pinned Node executable and generated Web entrypoint;
- an absolute DSH state home containing the declared patch file;
- the patch path relative to that state home;
- the fixed loopback Web port and trusted Host name.

The assembler requires an Apple Development identity for a local pre-release
smoke or a Developer ID Application identity for distribution. It rejects an
existing output path and verifies every signature it produces.

## Installation trust

The production runtime accepts exactly one canonical, non-symlinked
`DSHHost.app` at either `/Applications` with root ownership or the current
user's `~/Applications` with current-user ownership. Every app descendant must
be a regular file or directory owned by that installation owner, have no
extended ACL, and have no group or world write bit. The whole app code seal,
sealed designated requirement, manifests, digests, nested Node binary, native
addons, and XPC service are verified before hosted code runs.

The logged-in owner is an explicit trust principal for the user-level install.
Mutable session state remains outside the app in the configured DSH home. No
runtime dependency or executable is loaded from the source checkout after
assembly.

Before any notarization submission, run the developer-signed relocation smoke,
launch the relocated app from `~/Applications`, start the hosted runtime, and
prove the Keychain service does not prompt when an existing provisioning item
is updated. A release that has not passed those checks is not a notarization
candidate.
