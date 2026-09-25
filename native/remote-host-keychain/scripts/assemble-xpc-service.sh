#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${script_dir:h}

if (( $# != 6 )) || [[ $1 != '--signing-identity' ]] || [[ -z $2 ]] || [[ $3 != '--authorized-client' ]] || [[ $5 != '--output' ]]; then
  print -u2 'usage: assemble-xpc-service.sh --signing-identity "Apple Development or Developer ID Application: Name (TEAMID)" --authorized-client /absolute/path/to/signed-host-client --output /absolute/path/to/DSHRemoteHostKeychain.xpc'
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
client=${4:A}
output=${6:A}
if [[ ! -e $client ]] || [[ -e $output ]]; then
  print -u2 'the signed client must exist and the output path must not exist'
  exit 64
fi

verify_signature() {
  local target=$1
  codesign --verify --deep --strict --verbose=2 "$target"
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

client_bundle=${client:h:h:h}
client_info="$client_bundle/Contents/Info.plist"
if [[ ${client_bundle:e} != app ]] || [[ ! -f $client_info ]]; then
  print -u2 'the authorized client executable must be inside a signed macOS app bundle'
  exit 65
fi
verify_signature "$client_bundle"
verify_signature "$client"
client_requirement=$(codesign -d -r- "$client" 2>&1 | sed -n 's/^designated => //p')
if [[ -z $client_requirement ]]; then
  print -u2 'could not read the Host client designated requirement'
  exit 65
fi
client_identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$client_info")
client_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$client_info")
if [[ -z $client_identifier ]] || [[ -z $client_version ]]; then
  print -u2 'the authorized client app bundle must declare an identifier and build version'
  exit 65
fi

swift build --package-path "$root" -c release
binary="$root/.build/release/dsh-remote-host-keychain"
mkdir -p "$output/Contents/MacOS" "$output/Contents/Resources"
cp "$binary" "$output/Contents/MacOS/dsh-remote-host-keychain"
cp "$root/Resources/Info.plist" "$output/Contents/Info.plist"
cp "$root/Resources/AuthorizedClient.plist" "$output/Contents/Resources/AuthorizedClient.plist"
plutil -replace requirement -string "$client_requirement" "$output/Contents/Resources/AuthorizedClient.plist"
plutil -replace bundleIdentifier -string "$client_identifier" "$output/Contents/Resources/AuthorizedClient.plist"
plutil -replace bundleVersion -string "$client_version" "$output/Contents/Resources/AuthorizedClient.plist"
plutil -lint "$output/Contents/Info.plist" "$output/Contents/Resources/AuthorizedClient.plist"
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host.keychain --options runtime "$output"
verify_signature "$output"
codesign -d -r- "$output" 2>&1
