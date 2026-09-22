/**
 * Tests for the logging utilities: debug-gated verbose log and warn-always.
 *
 * Default behavior is QUIET: verbose `log()` is suppressed unless
 * `ZCODE_ACP_DEBUG=1` is set; `warn()` always emits (perceivable failures).
 */

import path from "node:path";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { ZCODE_CREDS_PATH, compareVersions, log, warn, zcodeHomeDir } from "../src/utils.js";

describe("logging", () => {
  const prevDebug = process.env.ZCODE_ACP_DEBUG;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    spy.mockRestore();
    if (prevDebug === undefined) delete process.env.ZCODE_ACP_DEBUG;
    else process.env.ZCODE_ACP_DEBUG = prevDebug;
  });

  it("log() is silenced by default (no ZCODE_ACP_DEBUG)", () => {
    delete process.env.ZCODE_ACP_DEBUG;
    log("should be silenced");
    expect(spy).not.toHaveBeenCalled();
  });

  it("log() writes to stderr with the [zcode-acp] prefix when ZCODE_ACP_DEBUG=1", () => {
    process.env.ZCODE_ACP_DEBUG = "1";
    log("hello");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("[zcode-acp] hello\n");
  });

  it("warn() always writes, even without ZCODE_ACP_DEBUG", () => {
    delete process.env.ZCODE_ACP_DEBUG;
    warn("visible warning");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("[zcode-acp] visible warning\n");
  });

  it("ZCODE_ACP_DEBUG=0 keeps log() silenced (only '1' enables verbose)", () => {
    process.env.ZCODE_ACP_DEBUG = "0";
    log("still silenced");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("compareVersions", () => {
  it("treats 10.0.0 as greater than 2.0.0 (not lexicographic)", () => {
    expect(compareVersions("10.0.0", "2.0.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  it("treats 1.10.0 as greater than 1.2.0", () => {
    expect(compareVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
  });

  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("sorts empty string before any version (sentinel for discovery loops)", () => {
    expect(compareVersions("0.0.0", "")).toBeGreaterThan(0);
    expect(compareVersions("", "0.0.0")).toBeLessThan(0);
    expect(compareVersions("", "")).toBe(0);
  });

  it("handles different segment counts", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
  });
});

describe("zcodeHomeDir", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to .zcode under the user home", () => {
    vi.stubEnv("ZCODE_HOME", "");
    vi.stubEnv("HOME", "/fake-home");
    expect(zcodeHomeDir()).toBe(path.join("/fake-home", ".zcode"));
  });

  it("uses ZCODE_HOME verbatim when set", () => {
    vi.stubEnv("HOME", "/fake-home");
    vi.stubEnv("ZCODE_HOME", "/custom-zcode");
    expect(zcodeHomeDir()).toBe("/custom-zcode");
  });

  it("ZCODE_CREDS_PATH follows ZCODE_HOME (module-level const, so re-imported)", async () => {
    // The const is snapshotted at import time; re-import with the env set.
    expect(ZCODE_CREDS_PATH.endsWith(path.join("v2", "config.json"))).toBe(true);
    vi.stubEnv("ZCODE_HOME", "/custom-zcode");
    vi.resetModules();
    const fresh = await import("../src/utils.js");
    expect(fresh.ZCODE_CREDS_PATH).toBe(path.join("/custom-zcode", "v2", "config.json"));
  });
});
