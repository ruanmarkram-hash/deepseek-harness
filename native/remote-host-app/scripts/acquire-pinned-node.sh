#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${script_dir:h}
version=24.19.0
archive="node-v${version}-darwin-arm64.tar.gz"
expected_sha256=8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d
source_url="https://nodejs.org/dist/v${version}/${archive}"

if (( $# == 0 )); then
  output="$root/dist/pinned-node"
elif (( $# == 2 )) && [[ $1 == '--output' && -n $2 ]]; then
  output=${2:A}
else
  print -u2 'usage: acquire-pinned-node.sh [--output /absolute/pinned-node]'
  exit 64
fi
[[ ! -e $output ]] || { print -u2 'pinned Node output must not already exist'; exit 64; }

scratch=$(mktemp -d /tmp/dsh-pinned-node.XXXXXX)
cleanup() { rm -rf "$scratch" }
trap cleanup EXIT
curl --fail --location --proto '=https' --tlsv1.2 --output "$scratch/$archive" "$source_url"
actual_sha256=$(shasum -a 256 "$scratch/$archive" | awk '{print $1}')
[[ $actual_sha256 == $expected_sha256 ]] || { print -u2 "Node archive SHA-256 mismatch: $actual_sha256"; exit 65; }
tar -xzf "$scratch/$archive" -C "$scratch"
extracted="$scratch/node-v${version}-darwin-arm64"
[[ -x "$extracted/bin/node" ]] || { print -u2 'Node archive omitted its executable'; exit 65; }
[[ $("$extracted/bin/node" --version) == "v${version}" ]] || { print -u2 'Node executable reported the wrong version'; exit 65; }
mkdir -p "${output:h}"
mv "$extracted" "$output"
print "Node v${version} acquired from $source_url"
print "SHA-256 $expected_sha256"
