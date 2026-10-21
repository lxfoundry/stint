import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchToken, getTransferCheckedInstruction } from "@solana-program/token";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundSol, newHarnessKey, type HarnessKey } from "../src/fixtures/keys.js";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS, deployStintProgram } from "../src/fixtures/programs.js";
import { USDC_DECIMALS, USDC_DEVNET_MINT, createUsdcAccount, mintUsdc, writeUsdcMint } from "../src/fixtures/usdc.js";
import { createKoraClient } from "../src/kora/client.js";
import { KORA_ALLOWED_PROGRAMS, renderKoraConfig, renderSignersConfig } from "../src/kora/config.js";
import { startKora, type KoraProcess } from "../src/kora/process.js";
import { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "../src/network/surfnet.js";
import { confirmSignature } from "../src/network/transactions.js";

const configInput = {
  allowedPrograms: [...KORA_ALLOWED_PROGRAMS, STINT_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS],
  allowedTokens: [USDC_DEVNET_MINT],
  maxAllowedLamports: 1_000_000,
};

describe("Kora configuration", () => {
  it("passes Kora's own validation", () => {
    const directory = mkdtempSync(join(tmpdir(), "stint-kora-config-"));
    writeFileSync(join(directory, "kora.toml"), renderKoraConfig(configInput));
    writeFileSync(join(directory, "signers.toml"), renderSignersConfig());
    const result = spawnSync(process.env.KORA_BIN ?? "kora", ["--config", "kora.toml", "config", "validate"], {
      cwd: directory,
      encoding: "utf8",
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
  });
});

describe("Kora on the local network", () => {
  let network: LocalNetwork;
  let kora: KoraProcess;
  let mintAuthority: HarnessKey;
  let feePayer: HarnessKey;

  beforeAll(async () => {
    network = startLocalNetwork();
    mintAuthority = await newHarnessKey();
    feePayer = await newHarnessKey();
    const freezeAuthority = await newHarnessKey();
    fundSol(network, mintAuthority.signer.address, 10);
    fundSol(network, feePayer.signer.address, 1);
    await writeUsdcMint(network, {
      mintAuthority: mintAuthority.signer.address,
      freezeAuthority: freezeAuthority.signer.address,
    });
    deployStintProgram(network);
    await waitForNewSlot(network.rpc);
    kora = await startKora({
      rpcUrl: network.rpcUrl,
      config: configInput,
      feePayerSecretKey: feePayer.secretKey,
      apiKey: "local-test-key",
    });
  });

  afterAll(async () => {
    await kora?.stop();
    network?.stop();
  });

  it("reports the harness key as its fee payer", async () => {
    const client = createKoraClient(kora.url, kora.apiKey);
    const { signer_address } = await client.getPayerSigner();
    expect(signer_address).toBe(feePayer.signer.address);
  });

  it("pays the fee of a token transfer, and nothing else", async () => {
    const sender = await newHarnessKey();
    const recipient = await newHarnessKey();
    const source = await mintUsdc(network.rpc, mintAuthority.signer, sender.signer.address, 1_000_000n);
    const destination = await createUsdcAccount(network.rpc, mintAuthority.signer, recipient.signer.address);

    const { value: latestBlockhash } = await network.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer.signer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getTransferCheckedInstruction({
              source,
              mint: USDC_DEVNET_MINT,
              destination,
              authority: sender.signer,
              amount: 250_000n,
              decimals: USDC_DECIMALS,
            }),
          ],
          m,
        ),
    );
    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);

    const client = createKoraClient(kora.url, kora.apiKey);
    const signed = await client.signTransaction(getBase64EncodedWireTransaction(partiallySigned));
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(signed)));
    await network.rpc.sendTransaction(signed, { encoding: "base64" }).send();
    await confirmSignature(network.rpc, signature);

    expect((await fetchToken(network.rpc, destination)).data.amount).toBe(250_000n);
    const transaction = await network.rpc
      .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" })
      .send();
    const meta = transaction?.meta;
    expect(meta).toBeDefined();
    const paid = meta!.preBalances[0]! - meta!.postBalances[0]!;
    expect(paid).toBe(meta!.fee);
  });
});
