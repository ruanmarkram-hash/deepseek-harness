#!/bin/zsh
set -euo pipefail
script_dir=${0:A:h}
root=${script_dir:h}
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
archive="$root/third_party/libsodium/libsodium-1.0.22-stable.tar.gz"
expected='bf2745b62184002bdb9a6e19bf41cf08678eacb0b6680b8806c87ce86a6977b9'
expected_prebuilt='01027432dbed0b8b6617a42085d4d67929cde37e46e8344b3380385bcaac74e5'
[[ $(shasum -a 256 "$archive" | awk '{print $1}') == "$expected" ]] || { print -u2 'verified libsodium archive is missing or mismatched'; exit 65; }
[[ $(uname -m) == arm64 ]] || { print -u2 'the tracked libsodium prebuilt is macOS arm64 only'; exit 65; }
[[ -x /opt/homebrew/bin/minisign ]] || { print -u2 'the controlled Minisign executable is unavailable'; exit 69; }
build="${DSH_SODIUM_BUILD_ROOT:-$root/third_party/.build/libsodium-1.0.22}"
"$root/scripts/build-libsodium-bridge.sh" >/dev/null
output="$build/src/libsodium/.libs/libsodium.a"
[[ -f "$output" ]] || { print -u2 'libsodium static archive was not built'; exit 65; }
actual=$(shasum -a 256 "$output" | awk '{print $1}')
[[ "$actual" == "$expected_prebuilt" ]] || { print -u2 'verified libsodium source did not reproduce the tracked prebuilt archive'; exit 65; }
xcode=$(xcodebuild -version | tr '\n' ';')
compiler=$($cc_path --version | head -1)
signature_hash=$(shasum -a 256 "$root/third_party/libsodium/libsodium-1.0.22-stable.tar.gz.minisig" | awk '{print $1}')
public_key_hash=$(shasum -a 256 "$root/third_party/libsodium/libsodium-release.minisign.pub" | awk '{print $1}')
print '{"schema":1,"platform":"macos-arm64","sourceSha256":"'"$expected"'","signatureSha256":"'"$signature_hash"'","publicKeySha256":"'"$public_key_hash"'","staticArchiveSha256":"'"$actual"'","cc":"'"$cc_path"'","compiler":"'"$compiler"'","xcode":"'"$xcode"'","sdk":"'"$sdk_path"'","buildInputs":"DEVELOPER_DIR='"$developer_dir"';SDKROOT='"$sdk_path"';CC='"$cc_path"';AR='"$ar_path"';RANLIB='"$ranlib_path"';PATH=/usr/bin:/bin;MACOSX_DEPLOYMENT_TARGET=13.0;ZERO_AR_DATE=1;configure=--disable-shared --enable-static --disable-debug"}' > "$build/provenance.json"
cmp -s "$build/provenance.json" "$root/third_party/libsodium/prebuilt/macos-arm64/PREBUILT.json" || { print -u2 'verified libsodium build attestation does not match the tracked prebuilt'; exit 65; }
