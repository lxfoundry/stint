import { describe, expect, it } from "vitest";
import { catalogue } from "../src/catalogue.js";
import type { Capability, IsolationGroup } from "../src/types.js";

const byId = new Map(catalogue.map((scenario) => [scenario.id, scenario]));
/** The scenarios the build has made required: each passes on `local`, and none goes back to pending (spec §12.2). */
const REQUIRED = [1, 2, 22];

function idsWhere(predicate: (needs: readonly Capability[]) => boolean): number[] {
  return catalogue.filter((scenario) => predicate(scenario.needs)).map((scenario) => scenario.id);
}

describe("scenario catalogue", () => {
  it("lists the 35 scenarios of spec section 12.7, numbered 1 to 35", () => {
    expect(catalogue.map((scenario) => scenario.id)).toEqual(
      Array.from({ length: 35 }, (_, index) => index + 1),
    );
  });

  it("has the scenarios of REQUIRED required with their implementations, and every other scenario pending without one", () => {
    for (const scenario of catalogue) {
      if (REQUIRED.includes(scenario.id)) {
        expect(scenario.status).toBe("required");
        expect(scenario.run).toBeDefined();
      } else {
        expect(scenario.status).toBe("pending");
        expect(scenario.run).toBeUndefined();
      }
    }
  });

  it("states the needs of spec section 12.7", () => {
    const same = (needs: readonly Capability[], expected: Capability[]) =>
      needs.length === expected.length && expected.every((capability) => needs.includes(capability));
    expect(idsWhere((needs) => same(needs, ["stack"]))).toEqual([10, 11, 22, 23, 24, 25, 26, 27, 30, 33, 34]);
    expect(idsWhere((needs) => same(needs, ["chain", "stack"]))).toEqual([28, 31]);
    expect(idsWhere((needs) => same(needs, ["allowance"]))).toEqual([12]);
    expect(idsWhere((needs) => same(needs, ["facilitatorApi"]))).toEqual([18, 19]);
    expect(idsWhere((needs) => needs.length === 0)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 20, 21, 29, 32, 35,
    ]);
  });

  it("places scenarios in the isolation groups of spec section 12.2", () => {
    const group = (id: number): IsolationGroup | undefined => byId.get(id)?.group;
    for (const id of [10, 11, 23, 24, 25, 26, 27, 28, 33, 34]) expect(group(id)).toBe("ownStack");
    expect(group(31)).toBe("ownNetwork");
    const shared = catalogue.filter((scenario) => scenario.group === "shared").map((s) => s.id);
    expect(shared).toHaveLength(24);
  });
});
