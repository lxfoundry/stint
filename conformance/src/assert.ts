/** Assertions for scenarios: each failure names what was checked (spec §12.2, "Report"). */
export function expectTrue(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`${what}: not so`);
}

export function expectEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what}: not within ${timeoutMs} ms`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
