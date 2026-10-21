#!/usr/bin/env bash
# Fetches the Subscriptions & Allowances program from devnet into e2e/.cache when the cache is
# empty, then checks it against the pinned hash. It runs before a test run, never during one
# (spec section 12.3). With --pin, it records the hash of the cached copy instead.
set -euo pipefail
cd "$(dirname "$0")/.."

program_id="De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44"
copy="e2e/.cache/subscriptions.so"
pin="e2e/fixtures/subscriptions.sha256"

mkdir -p e2e/.cache e2e/fixtures
if [[ ! -f "$copy" ]]; then
  solana program dump --url devnet "$program_id" "$copy"
fi

actual="$(sha256sum "$copy" | cut -d ' ' -f 1)"
if [[ "${1:-}" == "--pin" ]]; then
  echo "$actual" > "$pin"
  echo "Pinned $actual"
  exit 0
fi

expected="$(cat "$pin")"
if [[ "$actual" != "$expected" ]]; then
  echo "The cached Subscriptions program ($actual) does not match the pinned hash ($expected)." >&2
  exit 1
fi
echo "The cached Subscriptions program matches the pinned hash."
