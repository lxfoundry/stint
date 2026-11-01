import type { StintSession } from "@lxfoundry/stint-client";
import { sleep } from "./assert.js";
import { receivedAmount } from "./scenarios/22-example-agent-task.js";
import type { Buyer, ScenarioContext } from "./types.js";

/** What a connection received about a watched account, and how it ended. */
export interface Watch {
  /** When each frame about the watched account arrived, in milliseconds on the wall clock. */
  readonly frames: readonly number[];
  /** The connection's close code, once it has closed. */
  readonly closeCode: number | undefined;
  /** Set when a payment that should have changed the account failed. */
  readonly paymentFailure: unknown;
  /** Stops the payments, waits for the one in flight, and drops the connection. */
  stop(): Promise<void>;
}

/**
 * Connects to `session`, subscribes to `watched`'s USDC account, and has `payer` send it one base unit every 500 ms until
 * `stop`. Whatever the gate forwards shows up as a frame, so the frames show when the session was served (scenarios 4 and
 * 34). The watched account must exist before the subscription: the node then sends one message per change (scenario 22).
 */
export async function watchWhilePaying(context: ScenarioContext, session: StintSession, payer: Buyer, watched: Buyer): Promise<Watch> {
  const frames: number[] = [];
  let closeCode: number | undefined;
  let paymentFailure: unknown;
  const socket = await session.connect();
  socket.on("message", (data) => {
    try {
      if (receivedAmount(JSON.parse(String(data)), watched.usdcAccount) !== undefined) frames.push(Date.now());
    } catch {
      // not JSON, so not a frame about the account
    }
  });
  socket.on("close", (code) => {
    closeCode = code;
  });
  socket.on("error", () => {});
  socket.send(JSON.stringify({ op: "subscribe", accounts: [watched.usdcAccount] }));
  await sleep(context.subscriptionSettleMs); // the subscription is in place before the first payment

  let paying = true;
  const payments = (async () => {
    try {
      while (paying) {
        await context.sendUsdc(payer, watched.usdcAccount, 1n);
        await sleep(500);
      }
    } catch (error) {
      paymentFailure = error;
    }
  })();
  return {
    frames,
    get closeCode() {
      return closeCode;
    },
    get paymentFailure() {
      return paymentFailure;
    },
    async stop() {
      paying = false;
      await payments;
      socket.terminate();
    },
  };
}
