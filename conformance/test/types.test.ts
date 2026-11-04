import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expectTypeOf, it } from "vitest";
import type { Buyer, DirectChain, DirectSession, GateStartOptions, OtherMint, ScenarioContext, StackControl } from "../src/index.js";

describe("the scenario context's members for stack control and direct sessions", () => {
  it("are optional, and exported with the other types", () => {
    expectTypeOf<ScenarioContext["stack"]>().toEqualTypeOf<StackControl | undefined>();
    expectTypeOf<ScenarioContext["direct"]>().toEqualTypeOf<DirectChain | undefined>();
  });

  it("describe the gate's control and a session opened straight on the program", () => {
    expectTypeOf<StackControl["rentPayer"]>().toEqualTypeOf<Address>();
    expectTypeOf<ReturnType<StackControl["stopGate"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<StackControl["startGate"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<Awaited<ReturnType<DirectChain["open"]>>>().toEqualTypeOf<DirectSession>();
    expectTypeOf<Parameters<DirectChain["close"]>>().toEqualTypeOf<[session: DirectSession, closer: KeyPairSigner]>();
    expectTypeOf<ReturnType<DirectChain["close"]>>().toEqualTypeOf<Promise<string>>();
    expectTypeOf<Awaited<ReturnType<DirectChain["newKey"]>>>().toEqualTypeOf<KeyPairSigner>();
    expectTypeOf<DirectSession["deposit"]>().toEqualTypeOf<bigint>();
    expectTypeOf<Parameters<DirectChain["open"]>[0]["remainder"]>().toEqualTypeOf<bigint | undefined>();
    expectTypeOf<Parameters<DirectChain["open"]>[0]["seconds"]>().toEqualTypeOf<number>();
    expectTypeOf<Parameters<DirectChain["open"]>[0]["receiverAuthorizer"]>().toEqualTypeOf<Address | undefined>();
    expectTypeOf<Parameters<DirectChain["open"]>[0]["mint"]>().toEqualTypeOf<Address | undefined>();
    expectTypeOf<DirectSession["mint"]>().toEqualTypeOf<Address>();
    expectTypeOf<Awaited<ReturnType<DirectChain["otherMint"]>>>().toEqualTypeOf<OtherMint>();
    expectTypeOf<OtherMint["mint"]>().toEqualTypeOf<Address>();
    expectTypeOf<Parameters<OtherMint["fund"]>>().toEqualTypeOf<[owner: Address, amount: bigint]>();
    expectTypeOf<ReturnType<OtherMint["fund"]>>().toEqualTypeOf<Promise<Address>>();
    expectTypeOf<Parameters<OtherMint["reclaim"]>>().toEqualTypeOf<[owner: KeyPairSigner]>();
  });

  it("describe a gate started with its session clock ahead, and a top-up made straight on the program", () => {
    expectTypeOf<Parameters<StackControl["startGate"]>>().toEqualTypeOf<[options?: GateStartOptions]>();
    expectTypeOf<GateStartOptions["sessionClockAheadMs"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Parameters<DirectChain["topUp"]>[0]>().toEqualTypeOf<{ readonly buyer: Buyer; readonly session: Address; readonly seconds: number }>();
    expectTypeOf<ReturnType<DirectChain["topUp"]>>().toEqualTypeOf<Promise<string>>();
  });
});
