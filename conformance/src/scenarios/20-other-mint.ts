import { address } from "@solana/kit";
import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { expectEqual, expectTrue } from "../assert.js";
import { sessionSeconds } from "../helpers.js";
import { openOffers } from "../payments.js";
import { readUntil } from "../reads.js";
import { readOpenedSession } from "../sessions.js";
import { closeWith, tokenFor } from "../tokens.js";
import type { DirectSession, ScenarioContext } from "../types.js";
import { connectOnceSeen, expectOfferTerms } from "./35-adopted-session.js";

/**
 * Scenario 20 (spec §12.7): a session opened directly on-chain with the gate's terms and receiver authorizer, but in
 * another mint, which anyone can create (S5). A connect with a valid token is refused with `403`, and so is a second
 * one. The gate does not adopt the session (spec §7.2, check 4; §7.3): it has no such session to close, and it reports
 * no status for it. The scenario then closes the session itself, on the program, and gives back the buyer's account for
 * the mint, whether or not a check failed.
 */
export async function otherMintRefused(context: ScenarioContext): Promise<void> {
  const direct = context.direct;
  if (!direct) throw new Error("scenario 20 needs a target that provides direct chain access");
  const { offer } = await openOffers(context.gateUrl);
  const other = await direct.otherMint();
  expectTrue(other.mint !== address(offer.asset), "the second mint is not the offer's asset");
  const signer = await direct.newKey();
  const seconds = sessionSeconds(context.target, 20);
  const account = await other.fund(signer.address, BigInt(offer.extra.rate) * BigInt(seconds));
  let opened: DirectSession | undefined;
  let checked = false;
  try {
    // A close pays the seller in the session's mint, so the seller's account for it must exist.
    await other.fund(address(offer.payTo), 0n);
    opened = await direct.open({
      buyer: { signer, usdcAccount: account },
      seconds,
      mint: other.mint,
      receiverAuthorizer: address(offer.extra.receiverAuthorizer),
    });
    const session = opened.session;
    const stored = await readOpenedSession(context, session);
    expectEqual(stored.mint, other.mint, "the session is in the second mint");
    expectOfferTerms(stored, offer);
    const sign = (purpose: "connect" | "close") => tokenFor(signer, context.gateUrl, session, purpose);

    // Each connect is tried again while the gate answers 404: its node can answer from behind right after the open.
    const first = await connectOnceSeen(context, () => sign("connect"), session);
    expectEqual(first.status, 403, "a connect for a session in another mint is refused with 403");
    const second = await connectOnceSeen(context, () => sign("connect"), session);
    expectEqual(second.status, 403, "a second connect is refused with 403 too");
    // The gate tracks a session it adopted, and would answer a close request for it.
    expectEqual((await closeWith(context.gateUrl, session, await sign("close"))).status, 404, "the gate has no such session to close: it adopted nothing");
    const status = await fetch(`${context.gateUrl}/sessions/${session}`);
    await status.body?.cancel();
    expectEqual(status.status, 404, "the gate reports no status for a session in another mint");
    checked = true;
  } finally {
    // The gate never took the session up: if it opened, its buyer closes it on the program. The buyer's account for the
    // mint goes back whether or not the open or the close went through.
    const cleanUp = async () => {
      try {
        if (opened) await direct.close(opened, signer);
      } finally {
        await other.reclaim(signer);
      }
    };
    // A failed check is the scenario's result; a clean-up that fails after every check passed is one too.
    if (checked) await cleanUp();
    else await cleanUp().catch(() => undefined);
  }
  const readSession = () => fetchMaybeSession(context.rpc, opened.session, { commitment: "confirmed" });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the scenario's own close leaves no session on chain");
}
