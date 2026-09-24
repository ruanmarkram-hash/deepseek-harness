# Release DSH remote pairing

English | [中文](releasing-dsh-remote-pairing.zh.md)

This cookbook releases the production relay, signed macOS Host, and TestFlight iPhone app as one remote-pairing candidate. It deliberately excludes DSH Desktop. The release is accepted only after a browser and a TestFlight iPhone use the same hosted runtime from different networks.

## Prerequisites

- A clean release checkout at the intended commit, with no staged, unstaged, or untracked source files.
- A Developer ID Application certificate, a configured `notarytool` Keychain profile, and the app-specific Host provisioning activation plist held outside the repository.
- An authenticated Wrangler environment authorized for the production Worker and an authenticated EAS environment authorized for the production iOS app.
- The install-specific DSH home, patch-relative path, loopback port, and trusted Host name used by the hosted Web runtime.
- A Mac that can install the Host at `/Applications/DSHHost.app` or the current user's `~/Applications/DSHHost.app`, and a physical iPhone enrolled for the TestFlight build.

Never place credentials, signing material, provisioning plists, submission identifiers, or release evidence in the repository.

## 1. Freeze and verify clean source

Set shell variables outside the repository. The signing identity value must be the exact Developer ID Application identity from Keychain, and `RELEASE_TMP` must be a fresh temporary directory.

```sh
repo=$(git rev-parse --show-toplevel)
cd "$repo"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git diff --check
RELEASE_TMP=$(mktemp -d)
```

Generated and cache directories are release inputs, never source. The following paths must be ignored and absent from `git ls-files`; stop if either condition fails.

```sh
git check-ignore -q native/remote-host-app/dist/pinned-node
git check-ignore -q native/remote-host-app/dist/dsh-web.mjs
git check-ignore -q native/remote-host-app/.build
git check-ignore -q native/remote-host-keychain/.build
git check-ignore -q apps/mobile/.expo
! git ls-files | rg '(^|/)(\.build|\.expo|DerivedData|node_modules|dist)(/|$)'
```

Run source gates before producing any release artifact.

```sh
pnpm --filter @deepseek-ai/dsh-mobile-relay run check
pnpm --filter @deepseek-ai/dsh-mobile-relay run test
pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy:dry-run
pnpm --filter @deepseek-ai/dsh-mobile run check
pnpm exec vitest run apps/mobile/tests
pnpm run doc-sync
```

## 2. Deploy the production relay

The checked-in Wrangler configuration binds the Worker to its production custom domain. Inspect the dry-run bundle, then deploy from the frozen commit. Do not add secrets to `wrangler.jsonc` or command history.

```sh
pnpm --filter @deepseek-ai/dsh-mobile-relay run deploy
```

Confirm the deployment reports the expected Worker, custom domain, Durable Object migrations, and commit. Do not continue if the route is absent or points at another Worker.

## 3. Build the signed Host candidate

The hosted runtime uses the official Node.js v24.19.0 macOS arm64 release. The acquisition script downloads `node-v24.19.0-darwin-arm64.tar.gz` only from `https://nodejs.org/dist/v24.19.0/`, verifies the archive SHA-256 is exactly `8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d`, checks the extracted executable and version, and then publishes the ignored pinned tree.

```sh
native/remote-host-app/scripts/acquire-pinned-node.sh
node native/remote-host-app/scripts/bundle-dsh-web.mjs
```

Assemble once with the full hosted-Web configuration. The output must not already exist. `RelayProvisioningActivation.plist` remains outside source and must be sealed only into the candidate.

```sh
native/remote-host-app/scripts/assemble-host-owner.sh \
  --signing-identity "$DEVELOPER_ID_APPLICATION" \
  --output "$RELEASE_TMP/DSHHost.app" \
  --provisioning-activation "$RELAY_PROVISIONING_ACTIVATION" \
  --hosted-child-node "$repo/native/remote-host-app/dist/pinned-node/bin/node" \
  --hosted-child-entrypoint "$repo/native/remote-host-app/dist/dsh-web.mjs" \
  --hosted-web-dsh-home "$DSH_HOME" \
  --hosted-web-patch-relative "$HOSTED_WEB_PATCH_RELATIVE" \
  --hosted-web-port "$HOSTED_WEB_PORT" \
  --hosted-web-trusted-host "$HOSTED_WEB_TRUSTED_HOST"
codesign --verify --deep --strict --verbose=2 "$RELEASE_TMP/DSHHost.app"
```

Recheck source cleanliness. The generated Node tree and Web bundle must remain ignored and untracked.

```sh
test -z "$(git status --porcelain=v1 --untracked-files=all)"
! git ls-files --error-unmatch native/remote-host-app/dist/pinned-node native/remote-host-app/dist/dsh-web.mjs >/dev/null 2>&1
```

## 4. Relocate and smoke-test before notarization

Copy the complete candidate to one supported canonical location, never through a symlink. A root-owned `/Applications` install or a current-user-owned `~/Applications` install is valid. Do not run it from the build or temporary directory.

```sh
mkdir -p "$HOME/Applications"
test ! -e "$HOME/Applications/DSHHost.app"
ditto "$RELEASE_TMP/DSHHost.app" "$HOME/Applications/DSHHost.app"
codesign --verify --deep --strict --verbose=2 "$HOME/Applications/DSHHost.app"
open "$HOME/Applications/DSHHost.app"
```

From the Host controls, choose **Start hosted runtime**. Confirm the relay remains inactive, open the configured hosted Web origin in a browser, create a session, send one harmless prompt, and observe a live response. Quit and reopen the relocated Host, choose **Start hosted runtime** again, and confirm the browser can return to the same configured Host state. Stop if XPC authorization, sealed-resource validation, hosted-child startup, browser loading, session creation, prompting, or restart recovery fails.

This is the final pre-notary candidate. After it passes, do not rebuild, re-sign, replace a resource, edit a manifest, or otherwise change code bytes.

## 5. Perform exactly one final notarization

Create the submission archive from the tested candidate and submit it exactly once with the configured Keychain profile. A rejected or inconclusive submission is a failed release candidate: diagnose it, rebuild a new candidate from clean source, repeat the pre-notary relocation smoke, and then make one submission for that new candidate.

```sh
ditto -c -k --keepParent "$HOME/Applications/DSHHost.app" "$RELEASE_TMP/DSHHost-notary.zip"
xcrun notarytool submit "$RELEASE_TMP/DSHHost-notary.zip" --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$HOME/Applications/DSHHost.app"
xcrun stapler validate "$HOME/Applications/DSHHost.app"
spctl --assess --type execute --verbose=4 "$HOME/Applications/DSHHost.app"
codesign --verify --deep --strict --verbose=2 "$HOME/Applications/DSHHost.app"
ditto -c -k --keepParent "$HOME/Applications/DSHHost.app" "$RELEASE_TMP/DSHHost.zip"
```

Stapling and creating the final distribution archive do not authorize a second notarization submission. Preserve the accepted notary result outside the repository with the release records.

## 6. Build, submit, and wait for TestFlight

The production EAS profile uses App Store distribution, remote credentials, and remote build-number auto-increment. Build from the same frozen commit, submit that exact iOS build, and do not record account or submission identifiers in source.

```sh
cd "$repo/apps/mobile"
eas build --platform ios --profile production --non-interactive --wait
eas submit --platform ios --profile production --latest --non-interactive --wait
```

Upload completion is not availability. Wait until App Store Connect finishes processing, required compliance answers are complete, the intended TestFlight group can see the build, and a physical iPhone can install or update to it. Record the public app version and build number outside the repository.

## 7. Run the different-network iPhone matrix

Use the notarized, stapled Host and the processed TestFlight build. Keep the Mac on its ordinary network and disable Wi-Fi on the iPhone so the phone uses cellular data or another independently routed network.

1. **Pair and presence prompt:** In DSH Mobile choose **Pair this phone**, scan or enter the short-lived code shown by **Pair iPhone from anywhere…**, compare the complete phone fingerprint on both devices, approve only at the Host, and satisfy the iPhone presence prompt. Confirm the protected invitation imports without exposing a Host token or private key.
2. **Hosted prompt:** Choose **Start hosted runtime**, then **Activate paired phone**. From the iPhone create or select a session, send a harmless prompt, and confirm the same prompt and response appear in the browser-backed hosted session.
3. **Reconnect:** Interrupt only the iPhone network, restore it, use **Retry connection**, and confirm the same route reconnects at the Host-issued next epoch without duplicate messages or a second live socket.
4. **Restart:** Quit the Host cleanly, reopen the notarized app from its canonical location, choose **Start hosted runtime**, and confirm the retained active route and hosted state recover. Reconnect the iPhone and send another prompt that appears in the same browser Host.
5. **Revoke:** Choose **Revoke paired phone…** on the Host. Confirm the phone loses access, retries fail, and a copied or retained invitation cannot restore the revoked route.
6. **Forget:** On the iPhone choose **Forget invitation** and confirm the destructive prompt. Relaunch the app and confirm it has no stored Host invitation, epoch, cursor, or rendered session history. Forgetting is local and does not substitute for Host revocation.

The release passes only when every row succeeds on a physical TestFlight iPhone over a different network. A simulator, development build, same-network-only run, upload receipt, or unnotarized Host does not satisfy this matrix.

## 8. Final release record

Record outside the repository: the source commit, relay deployment version, Host archive digest, accepted notarization result, public iOS version/build, TestFlight availability time, Mac installation location, iPhone model and OS, network separation used, and the result of every matrix row. Publish only the exact stapled Host archive and the exact processed TestFlight build that passed.
