import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";

/**
 * Why a key file was refused: `shape` when it is JSON that is not an array of 64 integers from 0 to 255, `unusable` when
 * it is not JSON, or when its public half is not its seed's. The message names the reason and never holds any of the
 * file's text.
 */
export class KeyFileError extends Error {
  constructor(readonly reason: "shape" | "unusable") {
    super(reason === "shape" ? "not a JSON array of 64 bytes" : "not JSON, or its public half is not its seed's");
    this.name = "KeyFileError";
  }
}

/**
 * The signer of a key file as the Solana CLI writes it: the text of a JSON array of 64 integers from 0 to 255, the
 * 32-byte seed and then the 32-byte public key. Throws a `KeyFileError`. Nothing is taken from a parser's error: it
 * quotes the start of the text it was given, and the contents of a key file never reach a log.
 */
export async function parseKeyFile(text: string): Promise<KeyPairSigner> {
  let bytes: unknown;
  try {
    bytes = JSON.parse(text);
  } catch {
    throw new KeyFileError("unusable");
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new KeyFileError("shape");
  }
  try {
    return await createKeyPairSignerFromBytes(Uint8Array.from(bytes as number[]));
  } catch {
    throw new KeyFileError("unusable");
  }
}
