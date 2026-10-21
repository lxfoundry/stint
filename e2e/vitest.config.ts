import { defineConfig } from "vitest/config";

// Each test file starts its own network. Running files one at a time keeps the machine's load,
// and so the chain's clock, predictable.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
