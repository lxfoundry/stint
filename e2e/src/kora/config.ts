/**
 * Kora's configuration for the local target: free pricing and the `Mock` price source, so Kora
 * makes no outside request (T7), and Lighthouse assertions off (spec section 6.2, T8). The
 * fee-payer policy forbids every action other than paying fees: its flags default to false, and
 * they are written out so the policy reads from the file. In Kora 2.0.5, once a section exists,
 * all of its keys are required.
 */
export interface KoraConfigInput {
  readonly allowedPrograms: readonly string[];
  readonly allowedTokens: readonly string[];
  readonly maxAllowedLamports: number;
}

/** Programs every transaction may use: System, SPL Token, Associated Token Account, Compute Budget. */
export const KORA_ALLOWED_PROGRAMS = [
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
] as const;

const list = (values: readonly string[]) => `[${values.map((value) => `"${value}"`).join(", ")}]`;

const SPL_TOKEN_POLICY_KEYS = [
  "allow_transfer",
  "allow_burn",
  "allow_close_account",
  "allow_approve",
  "allow_revoke",
  "allow_set_authority",
  "allow_mint_to",
  "allow_initialize_mint",
  "allow_initialize_account",
  "allow_initialize_multisig",
  "allow_freeze_account",
  "allow_thaw_account",
];

export function renderKoraConfig(input: KoraConfigInput): string {
  if (input.allowedTokens.length === 0) throw new Error("Kora needs at least one allowed token");
  return [
    "[kora]",
    "rate_limit = 100",
    "",
    "[kora.auth]",
    "",
    "[kora.lighthouse]",
    "enabled = false",
    "",
    "[kora.enabled_methods]",
    "liveness = true",
    "estimate_transaction_fee = true",
    "get_supported_tokens = true",
    "get_payer_signer = true",
    "sign_transaction = true",
    "sign_and_send_transaction = false",
    "transfer_transaction = false",
    "get_blockhash = true",
    "get_config = true",
    "",
    "[validation]",
    `max_allowed_lamports = ${input.maxAllowedLamports}`,
    "max_signatures = 10",
    'price_source = "Mock"',
    "allow_durable_transactions = false",
    `allowed_programs = ${list(input.allowedPrograms)}`,
    `allowed_tokens = ${list(input.allowedTokens)}`,
    "allowed_spl_paid_tokens = []",
    "disallowed_accounts = []",
    "",
    "[validation.price]",
    'type = "free"',
    "",
    "[validation.fee_payer_policy.system]",
    "allow_transfer = false",
    "allow_assign = false",
    "allow_create_account = false",
    "allow_allocate = false",
    "",
    "[validation.fee_payer_policy.spl_token]",
    ...SPL_TOKEN_POLICY_KEYS.map((key) => `${key} = false`),
    "",
    "[validation.fee_payer_policy.token_2022]",
    ...SPL_TOKEN_POLICY_KEYS.map((key) => `${key} = false`),
    "",
  ].join("\n");
}

/** One memory signer whose key comes from `KORA_PRIVATE_KEY`, a JSON array of 64 bytes. */
export function renderSignersConfig(): string {
  return [
    "[signer_pool]",
    'strategy = "round_robin"',
    "",
    "[[signers]]",
    'name = "fee_payer"',
    'type = "memory"',
    'private_key_env = "KORA_PRIVATE_KEY"',
    "",
  ].join("\n");
}
