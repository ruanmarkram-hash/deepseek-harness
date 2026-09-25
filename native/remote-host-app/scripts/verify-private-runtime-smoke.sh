#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${script_dir:h}

if (( $# != 2 )) || [[ $1 != '--signing-identity' ]] || [[ -z $2 ]]; then
  print -u2 'usage: verify-private-runtime-smoke.sh --signing-identity "Apple Development: Name (TEAMID)"'
  exit 64
fi

identity=$2
scratch=$(mktemp -d /tmp/dsh-remote-host-private-runtime.XXXXXX)
cleanup() { rm -rf "$scratch" }
trap cleanup EXIT
app="$scratch/DSHHost.app"
"$root/scripts/assemble-host-owner.sh" --signing-identity "$identity" --output "$app"
codesign --verify --deep --strict "$app"
cmp -s "$root/third_party/libsodium/NOTICE.md" "$app/Contents/Resources/Licenses/libsodium-NOTICE.md" || { print -u2 'assembled app omitted the libsodium notice'; exit 1; }
cmp -s "$root/third_party/libsodium/LICENSE" "$app/Contents/Resources/Licenses/libsodium-LICENSE" || { print -u2 'assembled app omitted the libsodium ISC license'; exit 1; }

runtime="$app/Contents/Resources/Runtime/dsh-remote-host-runtime"
set +e
"$runtime" >/dev/null 2>&1
runtime_status=$?
set -e
if [[ $runtime_status -eq 0 ]]; then
  print -u2 'runtime accepted execution without its private descriptor'
  exit 1
fi

tampered_app="$scratch/DSHHost-tampered.app"
"$root/scripts/assemble-host-owner.sh" --signing-identity "$identity" --output "$tampered_app" >/dev/null
plutil -replace bundleVersion -string tampered "$tampered_app/Contents/XPCServices/DSHRemoteHostKeychain.xpc/Contents/Resources/AuthorizedClient.plist"
set +e
codesign --verify --deep --strict "$tampered_app" >/dev/null 2>&1
seal_status=$?
set -e
if [[ $seal_status -eq 0 ]]; then
  print -u2 'tampered signed service resource remained valid'
  exit 1
fi

untrusted_service="$scratch/UntrustedClient.xpc"
set +e
"$root/../remote-host-keychain/scripts/assemble-xpc-service.sh" --signing-identity "$identity" --authorized-client /usr/bin/true --output "$untrusted_service" >/dev/null 2>&1
untrusted_status=$?
set -e
if [[ $untrusted_status -ne 65 ]] || [[ -e $untrusted_service ]]; then
  print -u2 'assembly accepted an authorized client outside the selected signing identity'
  exit 1
fi

if ! rg -q 'posix_spawn_file_actions_addclose' "$root/Sources/RemoteHostRelay/RelayPrivateRuntimeSupervisor.swift" || ! rg -q 'FD_CLOEXEC' "$root/Sources/RemoteHostRuntime/main.swift" || ! rg -q 'maximumRecordBytes = 8 \* 1024 \* 1024' "$root/Sources/RemoteHostWire/RemoteHostWire.swift"; then
  print -u2 'private descriptor inheritance or Remote Wire size checks are absent'
  exit 1
fi

if rg -q 'identity\.open|identity\.sign|identity\.derive|route\.issue|func perform\(' "$root/Sources/RemoteHostApp" "$root/Sources/RemoteHostRuntime" "$root/../remote-host-keychain/Sources/RemoteHostKeychain"; then
  print -u2 'generic private operation protocol remains in the native Host boundary'
  exit 1
fi

if ! rg -q 'openHostPublicIdentity' "$root/Sources/RemoteHostApp/main.swift" || ! rg -q 'openHostPublicIdentity' "$root/../remote-host-keychain/Sources/RemoteHostKeychain/main.swift" || ! rg -q 'deriveHostSharedSecret\(withPeerPublicKey peerPublicKey: Data' "$root/Sources/RemoteHostApp/main.swift" "$root/../remote-host-keychain/Sources/RemoteHostKeychain/main.swift" || ! rg -q 'peerPublicKey.count == 32' "$root/../remote-host-keychain/Sources/RemoteHostKeychain/main.swift" || ! rg -q 'Contents/XPCServices/DSHRemoteHostKeychain.xpc' "$root/../remote-host-keychain/Sources/RemoteHostKeychain/main.swift" || rg -q 'case "(sign|derive)"|remoteAgreementPublicKey|requestId' "$root/../remote-host-keychain/Sources/RemoteHostKeychain/main.swift"; then
  print -u2 'Host XPC identity and agreement calls are not fixed and typed'
  exit 1
fi

if ! rg -q 'LocalEnrollmentMenu' "$root/Sources/RemoteHostApp/main.swift" || ! rg -q 'RelayLocalEnrollmentOfferReview' "$root/Sources/RemoteHostApp/main.swift" || ! rg -q 'Revoke paired phone' "$root/Sources/RemoteHostApp/main.swift" || ! rg -q 'revokePhoneSessions' "$root/Sources/RemoteHostApp/HostedRuntimeComposition.swift" || ! rg -q 'RelayDisabledRouteProvisioner' "$root/Sources/RemoteHostRelay/RelayHostPairingComposition.swift" || ! rg -q 'RelayProvisioningActivation' "$root/Sources/RemoteHostRelay/RelayHostPairingComposition.swift"; then
  print -u2 'Host local offer control or disabled provisioning gate is missing'
  exit 1
fi

if rg -q 'bundlePath|executablePath' "$root/../remote-host-keychain/Resources/AuthorizedClient.plist" || ! rg -q 'authorizedHostLocation' "$root/../remote-host-keychain/Sources/RemoteHostKeychain/main.swift"; then
  print -u2 'XPC authorization still persists a build-machine path or lacks relocation derivation'
  exit 1
fi

if ! rg -q -- '--install-provisioning-credential-stdin' "$root/Sources/RemoteHostApp/main.swift" || ! rg -q 'read\(upToCount: 258\)' "$root/Sources/RemoteHostApp/main.swift" || ! rg -q 'kSecAttrAccess as String: access' "$root/Sources/RemoteHostRelay/RemoteHostRelay.swift"; then
  print -u2 'one-shot bounded provisioning installer is missing'
  exit 1
fi

# Relocation must not invalidate the nested XPC client's sealed authorization.
installed="$scratch/Applications/DSHHost.app"
mkdir -p "${installed:h}"
mv "$app" "$installed"
app=$installed
codesign --verify --deep --strict "$app"
if plutil -p "$app/Contents/XPCServices/DSHRemoteHostKeychain.xpc/Contents/Resources/AuthorizedClient.plist" | rg -q 'bundlePath|executablePath'; then
  print -u2 'relocated Host persists a build path in XPC authorization'
  exit 1
fi

# A normal sealed Host reaches the ready fence and constructs only its inert
# composition. It has no local confirmation, so it cannot provision a route.
host="$app/Contents/MacOS/dsh-remote-host-app"
host_log="$scratch/inert-host.log"
"$host" >"$host_log" 2>&1 &
host_pid=$!
sleep 1
if ! kill -0 "$host_pid" >/dev/null 2>&1; then
  cat "$host_log" >&2 2>/dev/null || true
  print -u2 'sealed Host did not survive supervisor-ready inert startup'
  exit 1
fi
kill "$host_pid"
wait "$host_pid" || true

# Replace the runtime in the same sealed app with one that sends one valid
# Remote Wire record then exits. The Host must fail closed and reap its child.
runtime="$app/Contents/Resources/Runtime/dsh-remote-host-runtime"
cc -Wall -Werror "$root/Tests/runtime-exits-after-ready.c" -o "$runtime"
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host-runtime --options runtime "$runtime"
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host --options runtime "$app"
host="$app/Contents/MacOS/dsh-remote-host-app"
"$host" >/dev/null 2>&1 &
host_pid=$!
sleep 1
if ! kill -0 "$host_pid" >/dev/null 2>&1; then
  wait "$host_pid" || true
else
  kill "$host_pid"
  wait "$host_pid" || true
  print -u2 'Host remained live after the private runtime closed its socket'
  exit 1
fi

if ! rg -q 'SO_NOSIGPIPE' "$root/Sources/RemoteHostRelay/RelayPrivateRuntimeSupervisor.swift" || ! rg -q 'ChildProcessTerminator\.terminate' "$root/Sources/RemoteHostRelay/RelayPrivateRuntimeSupervisor.swift" || ! rg -q 'waitpid\(pid, &status, WNOHANG\)' "$root/Sources/RemoteHostRelay/ChildProcessTerminator.swift"; then
  print -u2 'private runtime EOF or SIGPIPE protections are absent'
  exit 1
fi

if rg -q '/tmp/dsh-host-relay-stage\.log|relaySocketStage' "$root/Sources/RemoteHostRelay"; then
  print -u2 'relay transport retains a fixed filesystem diagnostic log'
  exit 1
fi
