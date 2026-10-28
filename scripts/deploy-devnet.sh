#!/usr/bin/env bash
# Deploys the Stint program to devnet, or upgrades it. It refuses every other cluster: before it
# sends anything, it checks that the RPC reports devnet's genesis hash, so a wrong URL (the Solana
# CLI's own default is mainnet) can never spend mainnet SOL.
#
#   scripts/deploy-devnet.sh --payer <keypair> [--upgrade-authority <keypair>] [--program <.so>]
#                            [--program-keypair <keypair>] [--url <rpc>] [--dry-run] [--allow-default-wallet]
#
# --dry-run runs every check and prints the command it would run, and sends nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
# The ProgramData account's rent (about 0.90 SOL at devnet's 5,080 lamports per byte), the buffer that holds the
# same bytes until the deploy ends (the same again), and fees: about 1.8 SOL, and room for a larger build.
MIN_LAMPORTS=2200000000

url="https://api.devnet.solana.com"
payer=""
authority=""
program="target/deploy/stint.so"
program_keypair="target/deploy/stint-keypair.json"
dry_run=0
allow_default_wallet=0

die() {
  echo "refusing: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) url="${2:?--url needs a value}"; shift 2 ;;
    --payer) payer="${2:?--payer needs a value}"; shift 2 ;;
    --upgrade-authority) authority="${2:?--upgrade-authority needs a value}"; shift 2 ;;
    --program) program="${2:?--program needs a value}"; shift 2 ;;
    --program-keypair) program_keypair="${2:?--program-keypair needs a value}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --allow-default-wallet) allow_default_wallet=1; shift ;;
    *) die "unknown argument $1" ;;
  esac
done

[[ -n "$payer" ]] || die "--payer is required: a funded keypair file made for this"
[[ -f "$payer" ]] || die "the payer keypair $payer does not exist"
default_wallet="$HOME/.config/solana/id.json"
if [[ "$(realpath -m "$payer")" == "$(realpath -m "$default_wallet")" && $allow_default_wallet -eq 0 ]]; then
  die "$payer is the Solana CLI's default wallet: name a keypair made for this, or pass --allow-default-wallet"
fi
authority="${authority:-$payer}"
[[ -f "$authority" ]] || die "the upgrade authority keypair $authority does not exist"
[[ -f "$program" ]] || die "$program is missing: run anchor build (or anchor build --verifiable)"
[[ -f "$program_keypair" ]] || die "the program keypair $program_keypair is missing"

# Devnet and mainnet deploy SBPF v3 programs: the ELF header names the BPF machine (247) and flags 3.
machine="$(od -An -tu2 -j18 -N2 "$program" | tr -d ' ')"
flags="$(od -An -tu4 -j48 -N4 "$program" | tr -d ' ')"
[[ "$machine" == "247" && "$flags" == "3" ]] || die "$program is not an SBPF v3 program (e_machine $machine, e_flags $flags)"

# The program keypair must be the one Anchor.toml names for devnet.
expected_id="$(sed -n '/^\[programs\.devnet\]/,/^\[/s/^stint *= *"\(.*\)"/\1/p' Anchor.toml)"
program_id="$(solana-keygen pubkey "$program_keypair")"
[[ -n "$expected_id" && "$expected_id" == "$program_id" ]] || die "$program_keypair is $program_id, but Anchor.toml names '$expected_id' for devnet"

[[ "$url" =~ ^https?:// ]] || die "the RPC URL must start with http:// or https://"
host="$(printf '%s' "$url" | sed -E 's#^([a-z]+://)([^/@?]*@)?([^/?]+).*#\1\3#')"  # scheme and host only: a URL may carry an API key
# The cluster: nothing below runs unless the RPC is devnet.
genesis="$(solana genesis-hash --url "$url" 2>/dev/null)" || die "cannot read the genesis hash from $host"
[[ "$genesis" == "$DEVNET_GENESIS" ]] || die "the RPC at $host reports genesis hash $genesis, which is not devnet's"

payer_address="$(solana-keygen pubkey "$payer")"
balance_output="$(solana balance "$payer_address" --url "$url" --lamports 2>/dev/null)" || die "cannot read the balance of $payer_address from $host"
balance="${balance_output%% *}"
[[ "$balance" =~ ^[0-9]+$ ]] || die "cannot read the balance of $payer_address from $host (got '$balance_output')"
authority_address="$(solana-keygen pubkey "$authority")"
echo "payer $payer_address holds $balance lamports on devnet; upgrade authority $authority_address; program id $program_id"
if [[ "$authority_address" == "$payer_address" ]]; then
  echo "warning: the upgrade authority is the payer; keep them apart with --upgrade-authority" >&2
fi

command=(solana program deploy "$program" --url "$url" --keypair "$payer" --program-id "$program_keypair"
  --upgrade-authority "$authority" --use-rpc --max-sign-attempts 10)

if [[ $dry_run -eq 1 ]]; then
  echo "dry run: nothing was sent. It would run (the RPC URL is not printed: it may carry an API key):"
  shown=()
  for part in "${command[@]}"; do
    if [[ "$part" == "$url" ]]; then shown+=("<the RPC at $host>"); else shown+=("$part"); fi
  done
  echo "  ${shown[*]}"
  exit 0
fi

(( balance >= MIN_LAMPORTS )) || die "the payer holds $balance lamports; $MIN_LAMPORTS are needed (about 2.2 SOL): fund $payer_address on devnet first"

"${command[@]}"
solana program show "$program_id" --url "$url"
