const FLAG = "--only";

/**
 * The scenarios that `--only=4,34` limits a run to, by number; undefined without the flag, when every scenario runs.
 * The value follows an equals sign because the CLI takes its arguments that do not start with `--` as the target and
 * the mode. Throws on the flag without an equals sign, a list that names no scenario, a number that `known` lacks,
 * and the flag given twice.
 */
export function parseOnly(args: readonly string[], known: readonly number[]): Set<number> | undefined {
  if (args.includes(FLAG)) throw new Error(`${FLAG} takes its scenarios after an equals sign: ${FLAG}=4,34`);
  const given = args.filter((arg) => arg.startsWith(`${FLAG}=`));
  if (given.length === 0) return undefined;
  if (given.length > 1) throw new Error(`${FLAG} is given more than once`);

  const values = given[0]!
    .slice(FLAG.length + 1)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (values.length === 0) throw new Error(`${FLAG} names no scenario`);
  const ids = new Set<number>();
  for (const value of values) {
    // Digits only: Number() would also take "0x14", "1e1" and "4.0".
    const id = /^[0-9]+$/.test(value) ? Number(value) : NaN;
    if (!known.includes(id)) throw new Error(`${FLAG}: no scenario "${value}" in the catalogue`);
    ids.add(id);
  }
  return ids;
}
