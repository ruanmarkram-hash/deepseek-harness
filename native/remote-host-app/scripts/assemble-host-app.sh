#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${script_dir:h}

if (( $# < 4 )); then
  print -u2 'usage: assemble-host-app.sh --signing-identity "Apple Development or Developer ID Application: Name (TEAMID)" --output /absolute/path/to/DSHHost.app [--provisioning-activation /absolute/path/to/RelayProvisioningActivation.plist] [--sealed-gateway-node /absolute/release/node --sealed-gateway-entrypoint /absolute/dsh-remote-host-v3.mjs] [--hosted-child-node /absolute/pinned/node --hosted-child-entrypoint /absolute/dsh-web.mjs --hosted-web-dsh-home /absolute/.dsh --hosted-web-patch-relative rc8-core.patch.yml --hosted-web-port 3080 --hosted-web-trusted-host dsh.example.invalid]'
  exit 64
fi

identity=''
output=''
activation_file=''
sealed_gateway_node=''
sealed_gateway_entrypoint=''
hosted_child_node=''
hosted_child_entrypoint=''
hosted_web_dsh_home=''
hosted_web_patch_relative=''
hosted_web_port=''
hosted_web_trusted_host=''
approved_plugins_file=''
while (( $# > 0 )); do
  case $1 in
    --signing-identity)
      [[ $# -ge 2 && -z $identity ]] || { print -u2 'signing identity must be supplied exactly once'; exit 64; }
      identity=$2; shift 2 ;;
    --output)
      [[ $# -ge 2 && -z $output ]] || { print -u2 'output must be supplied exactly once'; exit 64; }
      output=${2:A}; shift 2 ;;
    --provisioning-activation)
      [[ $# -ge 2 && -z $activation_file && -f $2 ]] || { print -u2 'activation must be an existing plist'; exit 64; }
      activation_file=${2:A}; shift 2 ;;
    --sealed-gateway-node)
      [[ $# -ge 2 && -z $sealed_gateway_node ]] || { print -u2 'sealed gateway Node must be supplied once'; exit 64; }
      sealed_gateway_node=${2:A}; shift 2 ;;
    --sealed-gateway-entrypoint)
      [[ $# -ge 2 && -z $sealed_gateway_entrypoint ]] || { print -u2 'sealed gateway entrypoint must be supplied once'; exit 64; }
      sealed_gateway_entrypoint=${2:A}; shift 2 ;;
    --hosted-child-node)
      [[ $# -ge 2 && -z $hosted_child_node ]] || { print -u2 'hosted child Node must be supplied exactly once'; exit 64; }
      hosted_child_node=${2:A}; shift 2 ;;
    --hosted-child-entrypoint)
      [[ $# -ge 2 && -z $hosted_child_entrypoint ]] || { print -u2 'hosted child entrypoint must be supplied exactly once'; exit 64; }
      hosted_child_entrypoint=${2:A}; shift 2 ;;
    --hosted-web-dsh-home)
      [[ $# -ge 2 && -z $hosted_web_dsh_home && $2 == /* && $2 != *'..'* ]] || { print -u2 'hosted web DSH home must be one absolute canonical path'; exit 64; }
      hosted_web_dsh_home=${2:A}; shift 2 ;;
    --hosted-web-patch-relative)
      [[ $# -ge 2 && -z $hosted_web_patch_relative && $2 != /* && $2 != *'..'* && $2 != *'//'* ]] || { print -u2 'hosted web patch must be a safe relative path'; exit 64; }
      hosted_web_patch_relative=$2; shift 2 ;;
    --hosted-web-port)
      [[ $# -ge 2 && -z $hosted_web_port && $2 == <-> && $2 -ge 1 && $2 -le 65535 ]] || { print -u2 'hosted web port must be 1...65535'; exit 64; }
      hosted_web_port=$2; shift 2 ;;
    --hosted-web-trusted-host)
      [[ $# -ge 2 && -z $hosted_web_trusted_host && ( $2 =~ '^[A-Za-z0-9]$' || $2 =~ '^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$' ) ]] || { print -u2 'hosted web trusted host is malformed'; exit 64; }
      hosted_web_trusted_host=$2; shift 2 ;;
    --approved-plugins)
      [[ $# -ge 2 && -z $approved_plugins_file && $2 == /* && -f $2 && ! -L $2 ]] || { print -u2 'approved plugins must be one absolute regular JSON file'; exit 64; }
      approved_plugins_file=${2:A}; shift 2 ;;
    *) print -u2 "unknown argument: $1"; exit 64 ;;
  esac
done
if [[ -n $hosted_child_node || -n $hosted_child_entrypoint ]]; then
  [[ -n $hosted_child_node && -n $hosted_child_entrypoint ]] || { print -u2 'hosted child Node and entrypoint must be supplied together'; exit 64; }
  [[ -n $hosted_web_dsh_home && -n $hosted_web_patch_relative && -n $hosted_web_port && -n $hosted_web_trusted_host ]] || { print -u2 'hosted child requires a complete install-specific hosted Web configuration'; exit 64; }
fi
if [[ -n $approved_plugins_file && -z $hosted_child_node ]]; then
  print -u2 'approved plugins require the hosted child runtime'
  exit 64
fi
[[ -n $identity && -n $output ]] || { print -u2 'signing identity and output are required'; exit 64; }
if [[ -n $sealed_gateway_node || -n $sealed_gateway_entrypoint ]]; then
  [[ -n $sealed_gateway_node && -n $sealed_gateway_entrypoint ]] || { print -u2 'sealed gateway Node and entrypoint must be supplied together'; exit 64; }
fi

if [[ $identity == '-' ]] || { [[ $identity != Apple\ Development:*\ \(*\) ]] && [[ $identity != Developer\ ID\ Application:*\ \(*\) ]]; }; then
  print -u2 'a non-ad-hoc Apple Development or Developer ID Application signing identity with a Team ID is required'
  exit 65
fi
expected_team=$(security find-certificate -c "$identity" -p | openssl x509 -noout -subject | sed -n 's/.*OU=\([^,]*\).*/\1/p')
if [[ -z $expected_team ]]; then
  print -u2 'could not resolve the selected signing certificate Team ID'
  exit 65
fi
if [[ -e $output ]]; then
  print -u2 'the output path must not exist'
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

sign_hosted_macho_files() {
  local hosted_modules=$1 native_path
  local signed_count=0
  while IFS= read -r -d '' native_path; do
    if /usr/bin/file -b "$native_path" | rg -q 'Mach-O'; then
      if ! codesign --force --sign "$identity" --options runtime "$native_path" >/dev/null 2>&1; then
        print -u2 "could not Developer ID-sign hosted native artifact: $native_path"
        codesign --force --sign "$identity" --options runtime "$native_path"
        exit 65
      fi
      (( signed_count += 1 ))
    fi
  done < <(find "$hosted_modules" -type f -print0)
  print "Developer ID-signed $signed_count hosted native artifacts"
}

pnpm --dir "$root/../.." run verify:macos-icons
swift build --package-path "$root" -c release
host_binary="$root/.build/release/dsh-remote-host-app"
runtime_binary="$root/.build/release/dsh-remote-host-runtime"
mkdir -p "$output/Contents/MacOS" "$output/Contents/Resources/Runtime" "$output/Contents/Resources/Licenses"
cp "$host_binary" "$output/Contents/MacOS/dsh-remote-host-app"
cp "$runtime_binary" "$output/Contents/Resources/Runtime/dsh-remote-host-runtime"
cp "$root/Resources/Info.plist" "$output/Contents/Info.plist"
cp "$root/../../apps/desktop/assets/DeepSeek-HOST.icns" "$output/Contents/Resources/DeepSeek.icns"
cp "$root/Resources/RuntimeMetadata.plist" "$output/Contents/Resources/RuntimeMetadata.plist"
cp "$root/Resources/HostActivationRequirement.plist" "$output/Contents/Resources/HostActivationRequirement.plist"
cp "$root/Resources/RemoteHostKeychainServiceRequirement.plist" "$output/Contents/Resources/RemoteHostKeychainServiceRequirement.plist"
if [[ -n $activation_file ]]; then
  cp "$activation_file" "$output/Contents/Resources/RelayProvisioningActivation.plist"
  [[ $(/usr/libexec/PlistBuddy -c 'Print :enabled' "$output/Contents/Resources/RelayProvisioningActivation.plist") == true ]] || { print -u2 'activation plist must set enabled=true'; exit 64; }
fi
if [[ -n $sealed_gateway_node ]]; then
  "$root/scripts/prepare-sealed-gateway-runtime.sh" \
    --signing-identity "$identity" \
    --node "$sealed_gateway_node" \
    --entrypoint "$sealed_gateway_entrypoint" \
    --output "$output/Contents/Resources/GatewayRuntime"
fi
if [[ -n $hosted_child_node ]]; then
  "$root/scripts/prepare-hosted-child-runtime.sh" \
    --signing-identity "$identity" \
    --node "$hosted_child_node" \
    --entrypoint "$hosted_child_entrypoint" \
    --output "$output/Contents/Resources/HostedChild"
  hosted_web_patch_source="$hosted_web_dsh_home/$hosted_web_patch_relative"
  [[ -f $hosted_web_patch_source && ! -L $hosted_web_patch_source ]] || { print -u2 'hosted web patch must be an existing regular file below the configured DSH home'; exit 64; }
  hosted_web_patch_sha256=$(shasum -a 256 "$hosted_web_patch_source" | awk '{print $1}')
  [[ $hosted_web_patch_sha256 =~ '^[0-9a-f]{64}$' ]] || { print -u2 'could not hash hosted web patch'; exit 65; }
  hosted_web_configuration="$output/Contents/Resources/HostedChild/HostedWebConfiguration.plist"
  plutil -create xml1 "$hosted_web_configuration"
  plutil -insert formatVersion -integer 1 "$hosted_web_configuration"
  plutil -insert dshHome -string "$hosted_web_dsh_home" "$hosted_web_configuration"
  plutil -insert patchRelativePath -string "$hosted_web_patch_relative" "$hosted_web_configuration"
  plutil -insert patchSHA256 -string "$hosted_web_patch_sha256" "$hosted_web_configuration"
  plutil -insert port -integer "$hosted_web_port" "$hosted_web_configuration"
  plutil -insert trustedHost -string "$hosted_web_trusted_host" "$hosted_web_configuration"
  chmod -N "$output/Contents/Resources/HostedChild/HostedWebConfiguration.plist"
  chmod go-w "$output/Contents/Resources/HostedChild/HostedWebConfiguration.plist"
  plutil -lint "$output/Contents/Resources/HostedChild/HostedWebConfiguration.plist"
  if [[ -n $approved_plugins_file ]]; then
    node "$root/scripts/assemble-hosted-node-modules.mjs" \
      "$output/Contents/Resources/HostedChild/node_modules" \
      "$output/Contents/Resources/HostedChild/TreeManifest.plist" \
      --approved-plugins "$approved_plugins_file"
  else
    node "$root/scripts/assemble-hosted-node-modules.mjs" \
      "$output/Contents/Resources/HostedChild/node_modules" \
      "$output/Contents/Resources/HostedChild/TreeManifest.plist"
  fi
  sign_hosted_macho_files "$output/Contents/Resources/HostedChild/node_modules"
  node "$root/scripts/assemble-hosted-node-modules.mjs" \
    "$output/Contents/Resources/HostedChild/node_modules" \
    "$output/Contents/Resources/HostedChild/TreeManifest.plist" \
    --manifest-only
  cp "$output/Contents/Resources/HostedChild/TreeManifest.plist" "$output/Contents/Resources/TreeManifest.plist"
fi
cp "$root/third_party/libsodium/NOTICE.md" "$output/Contents/Resources/Licenses/libsodium-NOTICE.md"
cp "$root/third_party/libsodium/LICENSE" "$output/Contents/Resources/Licenses/libsodium-LICENSE"
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host-runtime --options runtime "$output/Contents/Resources/Runtime/dsh-remote-host-runtime"
verify_signature "$output/Contents/Resources/Runtime/dsh-remote-host-runtime"
runtime_requirement=$(codesign -d -r- "$output/Contents/Resources/Runtime/dsh-remote-host-runtime" 2>&1 | sed -n 's/^designated => //p')
if [[ -z $runtime_requirement ]]; then
  print -u2 'could not read the packaged runtime designated requirement'
  exit 65
fi
plutil -replace requirement -string "$runtime_requirement" "$output/Contents/Resources/RuntimeMetadata.plist"
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host --options runtime "$output"
host_requirement=$(codesign -d -r- "$output" 2>&1 | sed -n 's/^designated => //p')
if [[ -z $host_requirement ]]; then
  print -u2 'could not read the packaged Host designated requirement'
  exit 65
fi
plutil -replace requirement -string "$host_requirement" "$output/Contents/Resources/HostActivationRequirement.plist"
if [[ -n $activation_file ]]; then plutil -replace requirement -string "$host_requirement" "$output/Contents/Resources/RelayProvisioningActivation.plist"; fi
plutil -lint "$output/Contents/Info.plist" "$output/Contents/Resources/RuntimeMetadata.plist" "$output/Contents/Resources/HostActivationRequirement.plist" "$output/Contents/Resources/RemoteHostKeychainServiceRequirement.plist"
codesign --force --sign "$identity" --identifier com.deepseek.dsh.remote-host --options runtime "$output"
verify_signature "$output"
codesign -d -r- "$output" 2>&1
