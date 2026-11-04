import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { expectEqual, expectTrue } from "../assert.js";
import { buyerClient, refusalOf, sessionSeconds, usdcBalance } from "../helpers.js";
import { openOffers } from "../payments.js";
import { expectRefunded, readOpenedSession } from "../sessions.js";
import type { ScenarioContext } from "../types.js";

/** Checks a refusal as spec §5.2 states it: `400 invalid_duration`, with the bounds in the body. */
function expectInvalidDuration(
  refusal: Awaited<ReturnType<typeof refusalOf>>,
  bounds: { readonly minSeconds: number; readonly maxSeconds: number },
  what: string,
): void {
  expectEqual(refusal?.status, 400, `${what}: refused with 400`);
  expectEqual(refusal?.reason, "invalid_duration", `${what}: refused as invalid_duration`);
  const body = refusal?.body as { minSeconds?: unknown; maxSeconds?: unknown } | undefined;
  expectEqual(body?.minSeconds, bounds.minSeconds, `${what}: the refusal states the shortest duration`);
  expectEqual(body?.maxSeconds, bounds.maxSeconds, `${what}: the refusal states the longest duration`);
}

/**
 * Scenario 32 (spec §12.7): an open below `minSeconds`, an open above `maxSeconds`, and a top-up that would take a session
 * past `maxSeconds` are each refused with `400 invalid_duration`, before any offer: the client signs nothing, and nothing
 * reaches the chain. The session the scenario opens for the top-up is then closed and refunded as in scenario 1.
 */
export async function durationsOutOfBounds(context: ScenarioContext): Promise<void> {
  const { offer } = await openOffers(context.gateUrl);
  const { minSeconds, maxSeconds } = offer.extra;
  const seconds = sessionSeconds(context.target, 20);
  const buyer = await context.newBuyer(BigInt(offer.extra.rate) * BigInt(seconds)); // the one session it opens
  const client = buyerClient(buyer);
  const before = await usdcBalance(context.rpc, buyer.usdcAccount);

  for (const [asked, what] of [
    [minSeconds - 1, "an open below minSeconds"],
    [maxSeconds + 1, "an open above maxSeconds"],
  ] as const) {
    expectInvalidDuration(await refusalOf(client.open(context.gateUrl, { seconds: asked })), { minSeconds, maxSeconds }, what);
  }
  expectEqual(await usdcBalance(context.rpc, buyer.usdcAccount), before, "the refused opens take nothing: the client signed nothing");
  expectEqual(client.remainingBudget(), 1_000_000n, "the refused opens lock nothing in the budget");

  const session = await client.open(context.gateUrl, { seconds });
  const stored = await readOpenedSession(context, session.id);
  // What maxSeconds leaves once the session's own seconds are counted (spec §5.2); one second more is out of bounds.
  const room = maxSeconds - seconds;
  expectInvalidDuration(await refusalOf(session.topUp({ seconds: room + 1 })), { minSeconds: 1, maxSeconds: room }, "a top-up past maxSeconds");
  const after = await fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
  expectTrue(after.exists, "the session is still open after the refused top-up");
  expectEqual(after.data.deposited, stored.deposited, "the refused top-up adds nothing to the deposit");
  expectEqual(client.remainingBudget(), 1_000_000n - stored.deposited, "the refused top-up locks nothing in the budget");

  const receipt = await session.close();
  await expectRefunded(context, { signature: receipt.transaction, session: session.id, stored, buyer, reported: receipt });
}
