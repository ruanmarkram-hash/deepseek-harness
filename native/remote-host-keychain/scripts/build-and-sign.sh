#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${script_dir:h}
build_dir="$root/.build/release"
binary="$build_dir/dsh-remote-host-keychain"

if (( $# != 2 )) || [[ $1 != '--signing-identity' ]] || [[ -z $2 ]]; then
  print -u2 'usage: build-and-sign.sh --signing-identity "Apple Development or Developer ID Application: Name (TEAMID)"'
  exit 64
fi
identity=$2
if [[ $identity == '-' ]] || { [[ $identity != Apple\ Development:*\ \(*\) ]] && [[ $identity != Developer\ ID\ Application:*\ \(*\) ]]; }; then
  print -u2 'a non-ad-hoc Apple Development or Developer ID Application signing identity with a Team ID is required'
  exit 65
fi
expected_team=$(security find-certificate -c "$identity" -p | openssl x509 -noout -subject | sed -n 's/.*OU=\([^,]*\).*/\1/p')
if [[ -z $expected_team ]]; then
  print -u2 'could not resolve the selected signing certificate Team ID'
  exit 65
fi

verify_signature() {
  local target=$1
  codesign --verify --strict --verbose=2 "$target"
  local details requirement team requirement_marker
  details=$(codesign -dvv "$target" 2>&1)
  requirement=$(codesign -d -r- "$target" 2>&1 | sed -n 's/^designated => //p')
  team=$(print -r -- "$details" | sed -n 's/^TeamIdentifier=//p')
  if [[ $identity == Developer\ ID\ Application:* ]]; then
    requirement_marker='certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */'
  else
    requirement_marker=$identity
  fi
  if [[ $team != $expected_team ]] || [[ $requirement != *'anchor apple generic'* ]] || [[ $requirement != *"$requirement_marker"* ]]; then
    print -u2 'signed output does not carry the expected Apple team and certificate requirement'
    exit 65
  fi
}

swift build --package-path "$root" -c release
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host-keychain --options runtime "$binary"
verify_signature "$binary"
codesign -d -r- "$binary" 2>&1
