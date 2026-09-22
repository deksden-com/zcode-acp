import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Hermetic HOME for all tests — see tests/setup/hermetic-home.ts. Guards
    // the shared lazy-alias store (and any other $HOME-derived state) from
    // test writes on dev machines.
    setupFiles: ["./tests/setup/hermetic-home.ts"],
    // Keep gitignored workspace state (.zcode — scratch, cloned fork working
    // copies) out of the default **/*.test.ts sweep; their dependencies
    // (e.g. astro tsconfig extends) don't resolve in this context.
    exclude: ["**/node_modules/**", "**/dist/**", ".zcode/**"],
    // Every worker is a full forked Node process; uncapped parallelism
    // (= core count) ate multiple GB on dev machines. Cap local runs; CI
    // keeps its default parallelism. Override ad hoc: --maxWorkers=N.
    // minWorkers must be set too: vitest's forks pool defaults it to the CPU
    // count, which then exceeds a lowered maxWorkers and tinypool throws
    // "minThreads and maxThreads must not conflict".
    maxWorkers: process.env.CI ? undefined : 2,
    minWorkers: process.env.CI ? undefined : 1,
  },
});
