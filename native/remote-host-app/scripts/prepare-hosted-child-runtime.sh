#!/bin/zsh
set -euo pipefail

# Assembles Resources/HostedChild for the hosted FD199 runtime:
# re-signs the pinned Node binary, stages the complete bundled CLI program in
# the signed application, and emits manifests with digests computed here.

if (( $# != 8 )) || [[ $1 != '--signing-identity' ]] || [[ -z $2 ]] || [[ $3 != '--node' ]] || [[ $5 != '--entrypoint' ]] || [[ $7 != '--output' ]]; then
  print -u2 'usage: prepare-hosted-child-runtime.sh --signing-identity "Apple Development or Developer ID Application: Name (TEAMID)" --node /absolute/release/node --entrypoint /absolute/dsh-web.mjs --output /absolute/Resources/HostedChild'
  exit 64
fi

identity=$2
node_source=${4:A}
entrypoint_source=${6:A}
output=${8:A}

{ [[ $identity == Apple\ Development:*\ \(*\) ]] || [[ $identity == Developer\ ID\ Application:*\ \(*\) ]]; } || { print -u2 'a non-ad-hoc Apple Development or Developer ID Application signing identity with a Team ID is required'; exit 65; }
[[ -f $node_source && ! -L $node_source ]] || { print -u2 'hosted child Node input must be a regular, non-symlink release binary'; exit 64; }
[[ -f $entrypoint_source && ! -L $entrypoint_source && $entrypoint_source == *.mjs ]] || { print -u2 'hosted child entrypoint must be a regular, non-symlink .mjs bundle'; exit 64; }
[[ ! -e $output ]] || { print -u2 'hosted child output must not already exist'; exit 64; }
staging_output="${output}.staging.$$"
[[ ! -e $staging_output ]] || { print -u2 'hosted child staging output already exists'; exit 65; }
cleanup_staging() { if [[ -d $staging_output ]]; then rm -rf "$staging_output"; fi; }
trap cleanup_staging EXIT

node_arches=$(lipo -archs "$node_source" 2>/dev/null || true)
[[ " $node_arches " == *' arm64 '* ]] || { print -u2 'hosted child Node binary must contain macOS arm64'; exit 64; }

mkdir -p "$staging_output/child"
cp -p "$node_source" "$staging_output/node"
# The shipped entry is a tiny sealed stub.  Its only non-builtin import is the
# adjacent, code-signed bundle.  In particular it must never follow a path or
# module search root supplied from Application Support or the developer
# workspace: that would make a signed child execute mutable code.
cat > "$staging_output/child/dsh-web.mjs" <<'STUB'
await import(new URL('./dsh-web.bundle.mjs', import.meta.url).href)
STUB
cp -p "$entrypoint_source" "$staging_output/child/dsh-web.bundle.mjs"
chmod -N "$staging_output/child/dsh-web.mjs" "$staging_output/child/dsh-web.bundle.mjs"
chmod go-w "$staging_output/child/dsh-web.mjs" "$staging_output/child/dsh-web.bundle.mjs"

for hosted_path in "$staging_output" "$staging_output/node" "$staging_output/child/dsh-web.mjs" "$staging_output/child/dsh-web.bundle.mjs"; do
  chmod -N "$hosted_path"
  chmod go-w "$hosted_path"
done

# Dynamic-link Node builds carry libnode.dylib beside them; bundle it and
# retarget the reference to the staged layout so the copied binary boots.
for libref in $(otool -L "$staging_output/node" | awk '/libnode.*\.dylib/ {print $1}'); do
  libname=${libref:t}
  libsource="${node_source:h}/$libname"
  [[ -f $libsource ]] || libsource="${node_source:h:h}/lib/$libname"
  [[ -f $libsource && ! -L $libsource ]] || { print -u2 "hosted child Node requires a regular $libname beside it or in ../lib; copy the full release directory"; exit 64; }
  cp -p "$libsource" "$staging_output/$libname"
  chmod -N "$staging_output/$libname"; chmod go-w "$staging_output/$libname"
  # The dylib must carry the same team as the re-signed Node binary.
  codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host-hosted-libnode --options runtime "$staging_output/$libname"
  install_name_tool -change "$libref" "@executable_path/$libname" "$staging_output/node"
done
install_name_tool -add_rpath @executable_path "$staging_output/node" >/dev/null 2>&1 || true

# V8 needs runtime JIT permissions under hardened runtime.
entitlements="$staging_output/NodeEntitlements.plist"
plutil -create xml1 "$entitlements"
/usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.allow-jit bool true' "$entitlements"
/usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.allow-unsigned-executable-memory bool true' "$entitlements"
/usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.disable-executable-page-protection bool true' "$entitlements"
/usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.disable-library-validation bool true' "$entitlements"
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host-hosted-node --options runtime --entitlements "$entitlements" "$staging_output/node"
codesign --verify --strict --verbose=2 "$staging_output/node"
node_requirement=$(codesign -d -r- "$staging_output/node" 2>&1 | sed -n 's/^designated => //p')
[[ -n $node_requirement && $node_requirement == *'anchor apple generic'* ]] || { print -u2 'could not read a strict hosted Node designated requirement'; exit 65; }

node_digest=$(shasum -a 256 "$staging_output/node" | awk '{print $1}')
entrypoint_digest=$(shasum -a 256 "$staging_output/child/dsh-web.mjs" | awk '{print $1}')
bundle_digest=$(shasum -a 256 "$staging_output/child/dsh-web.bundle.mjs" | awk '{print $1}')
[[ $node_digest =~ '^[0-9a-f]{64}$' && $entrypoint_digest =~ '^[0-9a-f]{64}$' && $bundle_digest =~ '^[0-9a-f]{64}$' ]] || { print -u2 'could not calculate hosted child artifact digests'; exit 65; }

hosted_manifest="$staging_output/HostedChildManifest.plist"
plutil -create xml1 "$hosted_manifest"
plutil -insert formatVersion -integer 2 "$hosted_manifest"
plutil -insert relativeNodeExecutablePath -string HostedChild/node "$hosted_manifest"
plutil -insert relativeChildEntrypointPath -string HostedChild/child/dsh-web.mjs "$hosted_manifest"
plutil -insert nodeSHA256 -string "$node_digest" "$hosted_manifest"
plutil -insert childEntrypointSHA256 -string "$entrypoint_digest" "$hosted_manifest"
plutil -insert childBundleSHA256 -string "$bundle_digest" "$hosted_manifest"
plutil -insert nodeRequirement -string "$node_requirement" "$hosted_manifest"
plutil -insert relativeTreeManifestPath -string HostedChild/TreeManifest.plist "$hosted_manifest"
chmod -N "$staging_output/HostedChildManifest.plist"
chmod go-w "$staging_output/HostedChildManifest.plist"
plutil -lint "$staging_output/HostedChildManifest.plist"

# This manifest names the complete JavaScript import closure.  The Node binary
# and any adjacent dylib retain their own manifest/signature checks above;
# every non-native executable source byte is listed here.  The native
# validator rejects symlinks, traversal, writable files, and extras before it
# resumes the child.
tree_manifest="$staging_output/TreeManifest.plist"
plutil -create xml1 "$tree_manifest"
plutil -insert formatVersion -integer 2 "$tree_manifest"
plutil -insert entries -xml '<array/>' "$tree_manifest"
chmod -N "$staging_output/TreeManifest.plist"
chmod go-w "$staging_output/TreeManifest.plist"
plutil -lint "$staging_output/TreeManifest.plist"

mv "$staging_output" "$output"
trap - EXIT
