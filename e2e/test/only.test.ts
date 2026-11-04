import { describe, expect, it } from "vitest";
import { parseOnly } from "../src/only.js";

const KNOWN = [1, 2, 3, 4, 20, 34];

describe("parseOnly", () => {
  it("selects nothing, so every scenario runs, without the flag", () => {
    expect(parseOnly(["local"], KNOWN)).toBeUndefined();
    expect(parseOnly(["devnet", "--force"], KNOWN)).toBeUndefined();
  });

  it("takes the scenario numbers after the equals sign, comma-separated", () => {
    expect(parseOnly(["local", "--only=20"], KNOWN)).toEqual(new Set([20]));
    expect(parseOnly(["--only=34,4", "local"], KNOWN)).toEqual(new Set([4, 34]));
    expect(parseOnly(["local", "--only= 4 , 34 "], KNOWN)).toEqual(new Set([4, 34]));
  });

  it("refuses the flag without an equals sign, which would take its value for the mode", () => {
    expect(() => parseOnly(["local", "--only", "20"], KNOWN)).toThrow("--only takes its scenarios after an equals sign: --only=4,34");
  });

  it("refuses a list that names no scenario", () => {
    expect(() => parseOnly(["local", "--only="], KNOWN)).toThrow("--only names no scenario");
    expect(() => parseOnly(["local", "--only=,"], KNOWN)).toThrow("--only names no scenario");
  });

  it("refuses a value that is not the number of a scenario in the catalogue", () => {
    for (const value of ["99", "0", "-1", "4.5", "4a", "0x14", "1e1"]) {
      expect(() => parseOnly(["local", `--only=${value}`], KNOWN), value).toThrow(`--only: no scenario "${value}" in the catalogue`);
    }
  });

  it("refuses the flag given twice", () => {
    expect(() => parseOnly(["local", "--only=4", "--only=20"], KNOWN)).toThrow("--only is given more than once");
  });
});
