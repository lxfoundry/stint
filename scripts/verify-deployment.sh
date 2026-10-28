#!/usr/bin/env bash
# Checks that the program deployed on devnet is the given artifact, byte for byte.
#
#   scripts/verify-deployment.sh [artifact.so] [program-id] [rpc-url]
#
# With no arguments it checks target/deploy/stint.so against the program id Anchor.toml names for
# devnet. `solana program dump` writes the program's ELF followed by the account's zero padding, so
# the check compares the first bytes, as many as the artifact has, and requires the rest to be zeros.
# It reads from devnet only, and refuses any other cluster.
set -euo pipefail
cd "$(dirname "$0")/.."

DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
artifact="${1:-target/deploy/stint.so}"
program_id="${2:-$(sed -n '/^\[programs\.devnet\]/,/^\[/s/^stint *= *"\(.*\)"/\1/p' Anchor.toml)}"
url="${3:-https://api.devnet.solana.com}"

die() {
  echo "verification failed: $*" >&2
  exit 1
}

[[ -f "$artifact" ]] || die "$artifact is missing"
[[ -n "$program_id" ]] || die "no program id: Anchor.toml names none for devnet"
[[ "$url" =~ ^https?:// ]] || die "the RPC URL must start with http:// or https://"
host="$(printf '%s' "$url" | sed -E 's#^([a-z]+://)([^/@?]*@)?([^/?]+).*#\1\3#')"  # scheme and host only: a URL may carry an API key
genesis="$(solana genesis-hash --url "$url" 2>/dev/null)" || die "cannot read the genesis hash from $host"
[[ "$genesis" == "$DEVNET_GENESIS" ]] || die "the RPC at $host reports genesis hash $genesis, which is not devnet's"

mkdir -p target
dump="$(mktemp "target/dump.XXXXXX")"
trap 'rm -f "$dump"' EXIT
# The CLI's errors quote the URL it was given, key included: its output is not shown.
solana program dump "$program_id" "$dump" --url "$url" >/dev/null 2>&1 || die "cannot dump $program_id from $host"

size="$(stat -c %s "$artifact")"
dumped_size="$(stat -c %s "$dump")"
(( dumped_size >= size )) || die "the deployed program holds $dumped_size bytes, fewer than the artifact's $size"
want="$(sha256sum "$artifact" | cut -d ' ' -f 1)"
got="$(head -c "$size" "$dump" | sha256sum | cut -d ' ' -f 1)"
[[ "$want" == "$got" ]] || die "the first $size bytes of $program_id hash to $got; $artifact hashes to $want"
trailing="$(tail -c +"$((size + 1))" "$dump" | tr -d '\0' | wc -c)"
(( trailing == 0 )) || die "$program_id holds $trailing non-zero bytes after the artifact"

echo "devnet program $program_id is $artifact (sha256 $want, $size bytes)"
