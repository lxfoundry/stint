import { isAddress, isSignature } from "@solana/kit";

const EXPLORER = "https://explorer.solana.com";

/**
 * Whether `check` accepts `text`. The checks answer false for text of the wrong length but throw on text of the right
 * length that holds a character outside base58, and the error quotes the text: any throw means "not valid", and
 * nothing of it is kept.
 */
function accepts(check: (text: string) => boolean, text: string): boolean {
  try {
    return check(text);
  } catch {
    return false;
  }
}

/** The transaction's page on devnet's Explorer, for a valid base58 signature only. */
export const explorerTx = (signature: string): string | undefined =>
  accepts(isSignature, signature) ? `${EXPLORER}/tx/${signature}?cluster=devnet` : undefined;

/** The account's page on devnet's Explorer, for a valid base58 address only. */
export const explorerAddress = (address: string): string | undefined =>
  accepts(isAddress, address) ? `${EXPLORER}/address/${address}?cluster=devnet` : undefined;
