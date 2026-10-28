import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sbpfVersion } from "../src/artifact.js";
import { STINT_SO_PATH } from "../src/paths.js";

/** The first 64 bytes of an ELF64 file for the BPF machine, with the given `e_flags`. */
function header(flags: number, machine = 247): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); // magic, 64-bit, little-endian, version 1
  new DataView(bytes.buffer).setUint16(18, machine, true);
  new DataView(bytes.buffer).setUint32(48, flags, true);
  return bytes;
}

describe("sbpfVersion", () => {
  it("reads the version from the ELF flags of a BPF program", () => {
    expect(sbpfVersion(header(3))).toBe(3);
    expect(sbpfVersion(header(0))).toBe(0);
  });

  it("reads nothing from a file that is not a BPF ELF64 program", () => {
    expect(sbpfVersion(header(3, 62))).toBeUndefined();
    expect(sbpfVersion(new Uint8Array(64))).toBeUndefined();
    expect(sbpfVersion(new Uint8Array(10))).toBeUndefined();
  });
});

describe("the built program", () => {
  it("is SBPF v3: the version devnet and mainnet keep deploying", () => {
    if (!existsSync(STINT_SO_PATH)) throw new Error(`${STINT_SO_PATH} is missing: run anchor build`);
    expect(sbpfVersion(readFileSync(STINT_SO_PATH))).toBe(3);
  });
});
