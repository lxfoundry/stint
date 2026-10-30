import { createServer } from "node:net";
import { createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBuyer } from "../src/fixtures/buyers.js";
import { startLocalChain, type LocalChain } from "../src/targets/chain.js";
import { startServices, type Services } from "../src/targets/services.js";

describe("the services of a stack, run against the local chain", () => {
  let chain: LocalChain;
  let services: Services;
  const started: Services[] = [];

  /** The services as the targets start them, with a sweeper that runs every second. */
  async function start(): Promise<Services> {
    const running = await startServices({
      rpc: chain.network.rpc,
      rpcUrl: chain.network.rpcUrl,
      rpcWsUrl: chain.network.wsUrl,
      keys: chain.keys,
      sweeperIntervalMs: 1_000,
    });
    started.push(running);
    return running;
  }

  beforeAll(async () => {
    chain = await startLocalChain();
    services = await start();
  });

  afterAll(async () => {
    for (const running of started) await running.stop();
    chain?.stop();
  });

  const healthy = async (url: string) => (await fetch(`${url}/health`)).status === 200;
  const unreachable = (url: string) => fetch(`${url}/health`).then(() => false, () => true);

  /**
   * A whole session through the gate at `url`: the open, which the facilitator and Kora settle, and the close.
   * Returns what the close paid and refunded, together.
   */
  async function openAndClose(url: string): Promise<bigint> {
    const buyer = await newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, 1_000_000n);
    const { tools } = createSessionTools(
      createStintClient({
        signer: buyer.signer,
        policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
      }),
    );
    const opened = await tools.stint_open_session.run({ url, seconds: 30, reason: "stack control test" });
    const { paid, refunded } = await tools.stint_close_session.run({ sessionId: opened.sessionId });
    return BigInt(paid ?? 0) + BigInt(refunded ?? 0);
  }

  it("stops the gate and starts it again on the same URL, with the facilitator and Kora as they were", async () => {
    const { kora, facilitator } = services;
    const url = services.stream.url;
    expect(await openAndClose(url)).toBe(30_000n);

    await services.stopGate();

    expect(await unreachable(url)).toBe(true);
    expect(await healthy(facilitator.url)).toBe(true);

    await services.startGate();

    expect(services.stream.url).toBe(url);
    expect(await healthy(url)).toBe(true);
    expect(services.facilitator).toBe(facilitator);
    expect(services.kora).toBe(kora);
    // The new gate settles through the same facilitator and Kora: a session opens and closes on it.
    expect(await openAndClose(url)).toBe(30_000n);
  }, 90_000);

  it("takes a second stop or a second start of the gate as it comes", async () => {
    const url = services.stream.url;

    await services.stopGate();
    await services.stopGate();
    expect(await unreachable(url)).toBe(true);

    await services.startGate();
    await services.startGate();
    expect(await healthy(url)).toBe(true);
  });

  it("starts the gate again once whatever held its port lets go of it", async () => {
    const url = services.stream.url;
    await services.stopGate();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(Number(new URL(url).port), "127.0.0.1", resolve));

    const starting = services.startGate();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    await starting;

    expect(await healthy(url)).toBe(true);
  });

  it("stops the restarted gate with the rest", async () => {
    const own = await start();
    const url = own.stream.url;
    await own.stopGate();
    await own.startGate();
    expect(await healthy(url)).toBe(true);

    await own.stop();

    expect(await unreachable(url)).toBe(true);
    expect(await unreachable(own.facilitator.url)).toBe(true);
  }, 60_000);

  it("stops with a gate that is already stopped, takes a second stop, and starts no gate after it", async () => {
    const url = services.stream.url;
    await services.stopGate();

    await services.stop();
    await services.stop();

    expect(await unreachable(url)).toBe(true);
    expect(await unreachable(services.facilitator.url)).toBe(true);
    // A scenario's clean-up can ask for the gate after the stack has stopped: a gate started now is one that nothing stops.
    await services.startGate();
    expect(await unreachable(url)).toBe(true);
  });
});
