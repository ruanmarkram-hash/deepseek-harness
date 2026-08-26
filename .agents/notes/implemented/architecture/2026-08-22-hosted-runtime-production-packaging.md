# Agent Note: Hosted runtime production packaging

Status: implemented

English | [中文](2026-08-22-hosted-runtime-production-packaging.zh.md)

## Problem

The signed Host must launch the configured Web runtime without resolving Node, JavaScript, packages, or native modules from PATH, environment variables, an external checkout, or a mutable symlink farm. The release must also survive relocation from its build directory.

## Decision

`assemble-host-app.sh` copies the complete hosted runtime closure into `DSHHost.app/Contents/Resources/HostedChild`: the pinned Node binary, bundled `dsh-web.mjs` entrypoint, runtime files, package closure, presets, and install-specific `HostedWebConfiguration.plist`. It signs Node and every hosted Mach-O artifact with the selected identity, records strict requirements and SHA-256 digests in sealed manifests, and finally seals the complete outer app. The runtime launcher receives no `NODE_PATH`, `DSH_HOSTED_ROOT`, PATH lookup, shell, or external module root.

The release input is the official Node.js v24.19.0 macOS arm64 archive `node-v24.19.0-darwin-arm64.tar.gz`, whose published and locally verified SHA-256 is `27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1`. The extracted `native/remote-host-app/dist/pinned-node` tree and generated `dist/dsh-web.mjs` are ignored build inputs and must never be committed.

An accepted installation is one canonical, non-symlinked app at root-owned `/Applications/DSHHost.app` or current-user-owned `~/Applications/DSHHost.app`. Runtime validation derives the expected installation owner from that location, rejects extended ACLs and group or world writers, validates every manifest entry and digest, checks nested designated requirements, and verifies the strict whole-app code seal. XPC client authorization is derived from the helper's fixed nested location rather than a persisted build path.

Release order is part of the packaging contract. A clean candidate is assembled once, copied to a supported canonical location, and smoke-tested through XPC, hosted-child startup, browser session creation, prompting, and restart recovery before notarization. That tested candidate then receives exactly one final notarization submission, is stapled and reassessed, and is not rebuilt or re-signed afterward.

## Verification

Packaging and Swift tests cover manifest bounds, digest changes, symlinks, ownership and mode changes, ACLs, missing artifacts, invalid nested requirements, unsupported install locations, relative XPC authorization, and hosted Web configuration mismatch. The private-runtime smoke assembles and relocates a signed app, starts the hosted child through the production entry path, and verifies fail-closed behavior for tampered or unavailable artifacts.

## Alternatives considered

**Keep an external symlink farm and trust the checkout behind it.** Rejected because a signed release cannot make mutable external JavaScript and native modules part of its code integrity claim.

**Resolve Node or modules through environment variables.** Rejected because ambient process state would become executable release configuration outside the sealed app.

**Notarize before relocation and hosted-runtime smoke.** Rejected because it could spend the final submission on a candidate whose XPC or hosted closure fails outside the build directory.

## Consequences

The app is larger and native dependencies must be re-signed as part of assembly, but the distributable closure is self-contained and reviewable. Install-specific Web configuration and provisioning activation are sealed release inputs held outside source. The owning account can replace a user-owned installation, so the claim excludes protection from that account while retaining strict signed-code and peer isolation.
