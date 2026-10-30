import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expectTypeOf, it } from "vitest";
import type { DirectChain, DirectSession, ScenarioContext, StackControl } from "../src/index.js";

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
  });
});
