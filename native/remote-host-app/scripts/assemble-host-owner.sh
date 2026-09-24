#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${script_dir:h}
keychain_root=${root:h}/remote-host-keychain

if (( $# < 4 )); then
  print -u2 'usage: assemble-host-owner.sh --signing-identity "Apple Development or Developer ID Application: Name (TEAMID)" --output /absolute/path/to/DSHHost.app [--provisioning-activation plist] [--sealed-gateway-node node --sealed-gateway-entrypoint mjs] [--hosted-child-node node --hosted-child-entrypoint mjs --hosted-web-dsh-home dsh-home --hosted-web-patch-relative patch --hosted-web-port port --hosted-web-trusted-host host]'
  exit 64
fi

original_args=("$@")
identity=''
output=''
while (( $# > 0 )); do
  case $1 in
    --signing-identity)
      [[ $# -ge 2 && -z $identity ]] || { print -u2 'signing identity must be supplied exactly once'; exit 64; }
      identity=$2; shift 2 ;;
    --output)
      [[ $# -ge 2 && -z $output ]] || { print -u2 'output must be supplied exactly once'; exit 64; }
      output=${2:A}; shift 2 ;;
    --provisioning-activation|--sealed-gateway-node|--sealed-gateway-entrypoint|--hosted-child-node|--hosted-child-entrypoint|--hosted-web-dsh-home|--hosted-web-patch-relative|--hosted-web-port|--hosted-web-trusted-host|--approved-plugins)
      [[ $# -ge 2 ]] || { print -u2 "missing value for $1"; exit 64; }
      shift 2 ;;
    *) print -u2 "unknown argument: $1"; exit 64 ;;
  esac
done
[[ -n $identity && -n $output ]] || { print -u2 'signing identity and output are required'; exit 64; }
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
"$root/scripts/assemble-host-app.sh" "${original_args[@]}"
host_client="$output/Contents/MacOS/dsh-remote-host-app"
service="$output/Contents/XPCServices/DSHRemoteHostKeychain.xpc"
"$keychain_root/scripts/assemble-xpc-service.sh" --signing-identity "$identity" --authorized-client "$host_client" --output "$service"
service_requirement=$(codesign -d -r- "$service" 2>&1 | sed -n 's/^designated => //p')
if [[ -z $service_requirement ]]; then
  print -u2 'could not read the Keychain service designated requirement'
  exit 65
fi
plutil -replace requirement -string "$service_requirement" "$output/Contents/Resources/RemoteHostKeychainServiceRequirement.plist"
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host --options runtime "$output"
verify_signature "$output"
codesign -d -r- "$output" 2>&1
