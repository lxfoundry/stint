#!/usr/bin/env bash
# Checks that the installed tools match the pinned versions. Exits non-zero on any mismatch.
set -uo pipefail

failed=0

check() {
  local name="$1" command="$2" want="$3" got
  if ! got="$(bash -c "$command" 2>/dev/null | head -n 1)" || [[ -z "$got" ]]; then
    echo "MISSING  $name (want $want)"
    failed=1
  elif [[ "$got" == *"$want"* ]]; then
    echo "OK       $name: $got"
  else
    echo "MISMATCH $name: want $want, got $got"
    failed=1
  fi
}

check rustc    "rustc --version"    "1.99.1"
check solana   "solana --version"   "4.3.2"
check anchor   "anchor --version"   "1.2.1"
check node     "node --version"     "v24.22.0"
check pnpm     "pnpm --version"     "12.14.0"
check surfpool "surfpool --version" "1.6.1"
check kora     "kora --version"     "2.0.5"

exit "$failed"
