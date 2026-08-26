#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${script_dir:h}
source_dir="$root/third_party/libsodium"
unset CC CFLAGS CPPFLAGS LDFLAGS SDKROOT AR RANLIB DEVELOPER_DIR MAKEFLAGS TOOLCHAINS CONFIG_SITE CXX CXXFLAGS LIBS CPATH LIBRARY_PATH DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH
developer_dir=$(/usr/bin/xcode-select -p)
export DEVELOPER_DIR="$developer_dir"
sdk_path=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)
cc_path=/usr/bin/cc
ar_path=$(/usr/bin/xcrun --find ar)
ranlib_path=$(/usr/bin/xcrun --find ranlib)
make_path=$(/usr/bin/xcrun --find make)
export PATH=/usr/bin:/bin
export SDKROOT="$sdk_path"
export CC="$cc_path"
export AR="$ar_path"
export RANLIB="$ranlib_path"
archive="$source_dir/libsodium-1.0.22-stable.tar.gz"
signature="$source_dir/libsodium-1.0.22-stable.tar.gz.minisig"
public_key="$source_dir/libsodium-release.minisign.pub"
expected='bf2745b62184002bdb9a6e19bf41cf08678eacb0b6680b8806c87ce86a6977b9'
actual=$(shasum -a 256 "$archive" | awk '{print $1}')
[[ "$actual" == "$expected" ]] || { print -u2 'libsodium source hash mismatch'; exit 65; }
[[ $(uname -m) == arm64 ]] || { print -u2 'the tracked libsodium prebuilt is macOS arm64 only'; exit 65; }
minisign_path=/opt/homebrew/bin/minisign
[[ -x $minisign_path ]] || { print -u2 'the controlled Minisign executable is unavailable'; exit 69; }
"$minisign_path" -Vm "$archive" -x "$signature" -p "$public_key" >/dev/null
build_root="${DSH_SODIUM_BUILD_ROOT:-$root/third_party/.build/libsodium-1.0.22}"
mkdir -p "${build_root:h}"
if [[ -e "$build_root" || -L "$build_root" ]]; then
  stale_root="${build_root:h}/.stale-libsodium-1.0.22-$$-$(date +%s%N)"
  [[ ! -e "$stale_root" && ! -L "$stale_root" ]] || { print -u2 'could not allocate a stale libsodium build path'; exit 70; }
  mv "$build_root" "$stale_root"
  rm -rf "$stale_root" >/dev/null 2>&1 &!
fi
mkdir -p "$build_root"
tar -xzf "$archive" -C "$build_root" --strip-components=1
# Keep the static archive compatible with Package.swift's declared support floor.
(cd "$build_root" && MACOSX_DEPLOYMENT_TARGET=13.0 ./configure --disable-shared --enable-static --disable-debug && ZERO_AR_DATE=1 MACOSX_DEPLOYMENT_TARGET=13.0 "$make_path" -j"$(/usr/sbin/sysctl -n hw.ncpu)")
print "$build_root/src/libsodium/.libs/libsodium.a"
