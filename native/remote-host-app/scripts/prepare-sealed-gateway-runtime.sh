#!/bin/zsh
set -euo pipefail

if (( $# != 8 )) || [[ $1 != '--signing-identity' ]] || [[ -z $2 ]] || [[ $3 != '--node' ]] || [[ $5 != '--entrypoint' ]] || [[ $7 != '--output' ]]; then
  print -u2 'usage: prepare-sealed-gateway-runtime.sh --signing-identity "Apple Development or Developer ID Application: Name (TEAMID)" --node /absolute/release/node --entrypoint /absolute/dsh-remote-host-v3.mjs --output /absolute/GatewayRuntime'
  exit 64
fi

identity=$2
node_source=${4:A}
entrypoint_source=${6:A}
output=${8:A}
addon_source=${0:A:h:h}/GatewayRuntime/fd198-cloexec.c

{ [[ $identity == Apple\ Development:*\ \(*\) ]] || [[ $identity == Developer\ ID\ Application:*\ \(*\) ]]; } || { print -u2 'a non-ad-hoc Apple Development or Developer ID Application signing identity with a Team ID is required'; exit 65; }
[[ -f $node_source && ! -L $node_source ]] || { print -u2 'sealed gateway Node input must be a regular, non-symlink release binary'; exit 64; }
[[ -f $entrypoint_source && ! -L $entrypoint_source && $entrypoint_source == *.mjs ]] || { print -u2 'sealed gateway entrypoint must be a regular, non-symlink .mjs file'; exit 64; }
[[ -f $addon_source && ! -L $addon_source ]] || { print -u2 'sealed gateway FD198 close-on-exec addon source is missing'; exit 65; }
[[ ! -e $output ]] || { print -u2 'sealed gateway output must not already exist'; exit 64; }
staging_output="${output}.staging.$$"
[[ ! -e $staging_output ]] || { print -u2 'sealed gateway staging output already exists'; exit 65; }
cleanup_staging() { if [[ -d $staging_output ]]; then rm -rf "$staging_output"; fi; }
trap cleanup_staging EXIT

# A gateway release is a single precompiled ESM file. This intentionally rejects a
# development package tree, TypeScript source, package-manager resolution, and any
# import/require based dependency lookup at Host launch time.
node_arches=$(lipo -archs "$node_source" 2>/dev/null || true)
[[ " $node_arches " == *' arm64 '* ]] || { print -u2 'sealed gateway Node binary must contain macOS arm64'; exit 64; }
entrypoint_bytes=$(wc -c < "$entrypoint_source" | tr -d '[:space:]')
[[ $entrypoint_bytes -gt 0 && $entrypoint_bytes -le 4194304 ]] || { print -u2 'sealed gateway entrypoint must be between 1 byte and 4 MiB'; exit 64; }
if rg -n --pcre2 '\b(?:require|import)[[:space:]]*\(' "$entrypoint_source" >/dev/null \
  || rg -n --pcre2 "^\\s*import\\b.*\\bfrom\\s+[\\\"'](?!node:)" "$entrypoint_source" >/dev/null \
  || rg -n --pcre2 "^\\s*import\\s+[\\\"'](?!node:)" "$entrypoint_source" >/dev/null \
  || rg -n --pcre2 "^\\s*import\\b.*\\bfrom\\s+[\\\"']node:(?!(?:buffer|crypto|events|fs|http|https|net|stream|tls|url|util|zlib)[\\\"'])" "$entrypoint_source" >/dev/null \
  || rg -n --pcre2 "^\\s*import\\s+[\\\"']node:(?!(?:buffer|crypto|events|fs|http|https|net|stream|tls|url|util|zlib)[\\\"'])" "$entrypoint_source" >/dev/null; then
  print -u2 'sealed gateway entrypoint must be dependency-closed: only allowlisted static node: built-in imports are permitted'
  exit 64
fi
if rg -n 'process\.env|child_process|node:child_process' "$entrypoint_source" >/dev/null; then
  print -u2 'sealed gateway entrypoint may not read ambient environment or spawn child processes'
  exit 64
fi
dlopen_count=$( { rg -c 'process\.dlopen' "$entrypoint_source" 2>/dev/null || true; } | awk -F: '{ total += $NF } END { print total + 0 }')
if [[ $dlopen_count -ne 1 ]] || ! rg -q "fd198-cloexec\\.node" "$entrypoint_source"; then
  print -u2 'sealed gateway entrypoint may load only its fixed FD198 close-on-exec addon'
  exit 64
fi

mkdir -p "$staging_output"
cp -p "$node_source" "$staging_output/node"
cp -p "$entrypoint_source" "$staging_output/dsh-remote-host-v3.mjs"
clang -dynamiclib -arch arm64 -fvisibility=hidden -Wl,-undefined,dynamic_lookup "$addon_source" -o "$staging_output/fd198-cloexec.node"
for sealed_path in "$staging_output" "$staging_output/node" "$staging_output/dsh-remote-host-v3.mjs" "$staging_output/fd198-cloexec.node"; do
  chmod -N "$sealed_path"
  chmod go-w "$sealed_path"
  sealed_mode=$(stat -f '%OLp' "$sealed_path")
  (( (8#$sealed_mode & 8#022) == 0 )) || { print -u2 'sealed gateway output must not preserve group or world write permission'; exit 65; }
done
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host-gateway-node --options runtime "$staging_output/node"
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host-gateway-fd198-cloexec --options runtime "$staging_output/fd198-cloexec.node"
codesign --verify --strict --verbose=2 "$staging_output/node"
codesign --verify --strict --verbose=2 "$staging_output/fd198-cloexec.node"
node_requirement=$(codesign -d -r- "$staging_output/node" 2>&1 | sed -n 's/^designated => //p')
addon_requirement=$(codesign -d -r- "$staging_output/fd198-cloexec.node" 2>&1 | sed -n 's/^designated => //p')
[[ -n $node_requirement && $node_requirement == *'anchor apple generic'* ]] || { print -u2 'could not read a strict embedded Node designated requirement'; exit 65; }
[[ -n $addon_requirement && $addon_requirement == *'anchor apple generic'* ]] || { print -u2 'could not read a strict FD198 addon designated requirement'; exit 65; }
node_digest=$(shasum -a 256 "$staging_output/node" | awk '{print $1}')
entrypoint_digest=$(shasum -a 256 "$staging_output/dsh-remote-host-v3.mjs" | awk '{print $1}')
addon_digest=$(shasum -a 256 "$staging_output/fd198-cloexec.node" | awk '{print $1}')
[[ $node_digest =~ '^[0-9a-f]{64}$' && $entrypoint_digest =~ '^[0-9a-f]{64}$' && $addon_digest =~ '^[0-9a-f]{64}$' ]] || { print -u2 'could not calculate sealed gateway artifact digests'; exit 65; }

cat > "$staging_output/GatewayRuntimeManifest.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>formatVersion</key><integer>2</integer>
  <key>relativeNodeExecutablePath</key><string>GatewayRuntime/node</string>
  <key>relativeGatewayEntrypointPath</key><string>GatewayRuntime/dsh-remote-host-v3.mjs</string>
  <key>relativeGatewayCloexecAddonPath</key><string>GatewayRuntime/fd198-cloexec.node</string>
  <key>nodeSHA256</key><string>${node_digest}</string>
  <key>gatewayEntrypointSHA256</key><string>${entrypoint_digest}</string>
  <key>gatewayCloexecAddonSHA256</key><string>${addon_digest}</string>
  <key>nodeRequirement</key><string>${node_requirement}</string>
  <key>gatewayCloexecAddonRequirement</key><string>${addon_requirement}</string>
</dict>
</plist>
EOF
chmod -N "$staging_output/GatewayRuntimeManifest.plist"
chmod go-w "$staging_output/GatewayRuntimeManifest.plist"
sealed_mode=$(stat -f '%OLp' "$staging_output/GatewayRuntimeManifest.plist")
(( (8#$sealed_mode & 8#022) == 0 )) || { print -u2 'sealed gateway manifest must not preserve group or world write permission'; exit 65; }
plutil -lint "$staging_output/GatewayRuntimeManifest.plist"
mv "$staging_output" "$output"
trap - EXIT
