#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${script_dir:h}
archive="$root/third_party/libsodium/prebuilt/macos-arm64/libsodium.a"
marker="$root/third_party/.build/libsodium-1.0.22/.prepared.json"
source_archive="$root/third_party/libsodium/libsodium-1.0.22-stable.tar.gz"
signature="$root/third_party/libsodium/libsodium-1.0.22-stable.tar.gz.minisig"
public_key="$root/third_party/libsodium/libsodium-release.minisign.pub"
temporary=$(mktemp -d)
backup="$temporary/libsodium.a"
log="$temporary/describe.log"
cleanup() { cp "$backup" "$archive" 2>/dev/null || true; rm -f "$marker"; rm -rf "$temporary"; }
trap cleanup EXIT

command -v minisign >/dev/null || { print -u2 'minisign is required for this verification smoke'; exit 69; }
cp -R "$root" "$temporary/remote-host-app"
perl -0pi -e 's#minisign_path=/opt/homebrew/bin/minisign#minisign_path=/no/such/minisign#' "$temporary/remote-host-app/scripts/build-libsodium-bridge.sh"
perl -0pi -e 's#\[\[ -x /opt/homebrew/bin/minisign \]\]#[[ -x /bin/sh ]]#' "$temporary/remote-host-app/scripts/prepare-sodium-xchacha.sh"
if "$temporary/remote-host-app/scripts/prepare-sodium-xchacha.sh" >"$log" 2>&1; then
  print -u2 'prepare accepted a configured missing Minisign executable'
  exit 1
fi
grep -q 'controlled Minisign executable is unavailable' "$log" || { cat "$log" >&2; exit 1; }
if ! MAKEFLAGS='CC=/usr/bin/false' "$root/scripts/prepare-sodium-xchacha.sh" >"$log" 2>&1; then
  cat "$log" >&2
  print -u2 'prepare did not neutralize hostile MAKEFLAGS'
  exit 1
fi

cp "$source_archive" "$temporary/libsodium-source.tar.gz"
dd if=/dev/zero of="$temporary/libsodium-source.tar.gz" bs=1 count=1 conv=notrunc >/dev/null 2>&1
if minisign -Vm "$temporary/libsodium-source.tar.gz" -x "$signature" -p "$public_key" >/dev/null 2>&1; then
  print -u2 'Minisign accepted a modified libsodium source archive'
  exit 1
fi
cp "$archive" "$backup"
dd if=/dev/zero of="$archive" bs=1 count=1 conv=notrunc >/dev/null 2>&1
substituted_hash=$(shasum -a 256 "$archive" | awk '{print $1}')
mkdir -p "$root/third_party/.build/libsodium-1.0.22"
print '{"schema":1,"staticArchiveSha256":"'"$substituted_hash"'"}' > "$marker"
if swift package --package-path "$root" describe >"$log" 2>&1; then
  print -u2 'SwiftPM accepted a paired substituted libsodium archive and marker'
  exit 1
fi
grep -q 'requires the tracked macOS-arm64 libsodium archive' "$log" || { cat "$log" >&2; exit 1; }
print 'Sodium preparation smoke passed'
