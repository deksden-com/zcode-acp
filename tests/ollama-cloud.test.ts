/**
 * Tests for the Ollama Cloud usage feature: response validation, the HTTP
 * client (Bearer header), query orchestration (env-driven credentials, cache
 * TTL, error degradation), credential merging (env + config file), and
 * section rendering.
 *
 * Orchestration tests mock the client module so no real network happens; the
 * fs mock intercepts the config path fully (hermetic regardless of host).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import process from "node:process";

// Mock the client so queryOcUsage orchestration can inject a deterministic
// (status, text) pair.
vi.mock("../src/quota/ollama-cloud/client.js", () => ({
  fetchOcUsage: vi.fn(),
  fetchOcMe: vi.fn(),
  USAGE_URL: "https://ollama.com/api/usage",
  ME_URL: "https://ollama.com/api/me",
}));

// Control the config-file side of credential resolution: loadApiKey reads
// loadUserConfig() live, so a per-test mock value stands in for
// ~/.config/zcode-acp/config.json's quota.ollamaApiKey.
const { loadUserConfigMock } = vi.hoisted(() => ({ loadUserConfigMock: vi.fn() }));
vi.mock("../src/config/user-config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config/user-config.js")>(
    "../src/config/user-config.js",
  );
  return { ...actual, loadUserConfig: loadUserConfigMock };
});

import { clearCache, setClock } from "../src/quota/ollama-cloud/cache.js";
import { fetchOcMe, fetchOcUsage } from "../src/quota/ollama-cloud/client.js";
import { formatOcSection } from "../src/quota/ollama-cloud/format.js";
import {
  nextMonthlyAnniversary,
  nextSessionReset,
  nextWeeklyReset,
  queryOcUsage,
  SESSION_WINDOW_MS,
} from "../src/quota/ollama-cloud/index.js";
import type { OcQueryResult } from "../src/quota/ollama-cloud/types.js";

const mockedFetch = vi.mocked(fetchOcUsage);
const mockedMe = vi.mocked(fetchOcMe);

/** Set the config-file key (null = no quota section in the file). */
function setFileKey(key: string | null): void {
  loadUserConfigMock.mockReturnValue(key === null ? {} : { quota: { ollamaApiKey: key } });
}

/** Build a valid /api/usage response body. */
function usageBody(session: number | null, weekly: number | null, monthly?: number | null): string {
  const limits: Record<string, { usage: number }> = {};
  if (session !== null && session !== undefined) limits.session = { usage: session };
  if (weekly !== null && weekly !== undefined) limits.weekly = { usage: weekly };
  if (monthly != null) limits.monthly = { usage: monthly };
  return JSON.stringify({ limits });
}

// --- formatOcSection -------------------------------------------------------

describe("formatOcSection", () => {
  const success: OcQueryResult = {
    kind: "success",
    session: 0.314,
    weekly: 0.675,
    fetchedAt: 1000,
  };

  it("renders both windows as percent bars, no stamp without derived resets", () => {
    const sec = formatOcSection(success);
    expect(sec.header).toBe("Ollama Cloud");
    expect(sec.body).toHaveLength(2);
    expect(sec.body[0]).toMatch(/5h\s+█+░*\s+31\.4%/);
    expect(sec.body[1]).toMatch(/Week\s+█+░*\s+67\.5%/);
    // No derived reset moments on the fixture — no stamp column.
    expect(sec.body[0]).not.toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("appends the derived reset stamp when the result carries one", () => {
    const sec = formatOcSection({
      kind: "success",
      session: 0.3,
      sessionResetAt: 1_800_000_000_000,
      weekly: 0.5,
      fetchedAt: 1,
    });
    expect(sec.body[0]).toMatch(/5h\s+[█░]+\s+30%\s+·\s+\d{2}-\d{2} \d{2}:\d{2}/);
    // The weekly line carries no stamp of its own on this fixture.
    expect(sec.body[1]).not.toMatch(/· \d{2}-\d{2}/);
  });

  it("non-success kinds render a single explanation line", () => {
    expect(formatOcSection({ kind: "not_configured" }).body[0]).toMatch(/not configured/i);
    expect(formatOcSection({ kind: "not_configured" }).body[0]).toContain("OLLAMA_API_KEY");
    expect(formatOcSection({ kind: "auth_error" }).body[0]).toMatch(/auth failed/i);
    expect(formatOcSection({ kind: "unavailable" }).body[0]).toMatch(/unavailable/i);
  });

  describe("color mode", () => {
    const ESC = String.fromCharCode(27);
    const stripAnsi = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

    it("emits ANSI escapes with the percent overlaid inside the bar", () => {
      const sec = formatOcSection(success, true);
      const line = sec.body[0]!;
      expect(line).toContain(`${ESC}[48;2;`);
      expect(line).toContain(`${ESC}[0m`);
      expect(stripAnsi(line)).toContain("31.4%");
      expect(stripAnsi(line)).not.toContain("█");
      expect(stripAnsi(line)).not.toContain("░");
    });

    it("renders only the windows the plan exposes (legacy vs credit plan)", () => {
      const legacy = formatOcSection({ kind: "success", session: 0.2, weekly: 0.4, fetchedAt: 1 });
      expect(legacy.body).toHaveLength(2); // 5h + Week
      const credit = formatOcSection({ kind: "success", monthly: 0.006, fetchedAt: 1 });
      expect(credit.body).toHaveLength(1);
      expect(credit.body[0]).toMatch(/Month\s+[█░]+\s+0\.6%/);
    });

    it("color=false keeps the plain layout (no ANSI)", () => {
      expect(formatOcSection(success, false).body[0]).not.toContain("\x1b[");
    });
  });
});

// --- queryOcUsage orchestration --------------------------------------------

describe("queryOcUsage orchestration", () => {
  beforeEach(() => {
    clearCache();
    setClock(() => 5000);
    mockedFetch.mockReset();
    mockedMe.mockReset();
    setFileKey(null);
  });
  afterEach(() => {
    clearCache();
    setClock(undefined);
    delete process.env.OLLAMA_API_KEY;
  });

  it("returns not_configured when no key resolves (env + file absent)", async () => {
    expect((await queryOcUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("parses a successful response into fractions", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({ status: 200, text: usageBody(0.051, 0.503) });
    const result = await queryOcUsage();
    expect(result).toMatchObject({ kind: "success", session: 0.051, weekly: 0.503 });
    // Session/weekly resets derive from the window anchoring at fetch time.
    if (result.kind !== "success") return;
    expect(result.sessionResetAt).toBeGreaterThan(result.fetchedAt);
    expect(result.sessionResetAt! - result.fetchedAt).toBeLessThanOrEqual(SESSION_WINDOW_MS);
    expect(result.weeklyResetAt).toBeGreaterThan(result.fetchedAt);
    // /api/me is only consulted when the monthly window exists.
    expect(mockedMe).not.toHaveBeenCalled();
  });

  it("derives reset moments from the window anchoring (pure functions)", () => {
    // 5h buckets are epoch-aligned: the next boundary after 2 buckets + 1ms
    // is the start of bucket 3.
    expect(nextSessionReset(2 * SESSION_WINDOW_MS + 1)).toBe(3 * SESSION_WINDOW_MS);
    expect(nextSessionReset(3 * SESSION_WINDOW_MS)).toBe(4 * SESSION_WINDOW_MS);
    // Weekly weeks anchor at Monday 00:00 UTC (epoch + 4d).
    const anchor = 4 * 86_400_000;
    const week = 7 * 86_400_000;
    expect(nextWeeklyReset(anchor + 3 * week + 1000)).toBe(anchor + 4 * week);
    expect(nextWeeklyReset(anchor + 4 * week)).toBe(anchor + 5 * week);
  });

  it("monthly plans fetch /api/me for the billing-period reset", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({ status: 200, text: usageBody(null, null, 0.006) });
    mockedMe.mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        Plan: "pro",
        SubscriptionPeriodEnd: { Time: "2026-10-05T00:00:00Z", Valid: true },
      }),
    });
    const result = await queryOcUsage();
    expect(result).toMatchObject({
      kind: "success",
      monthly: 0.006,
      monthlyResetAt: Date.parse("2026-10-05T00:00:00Z"),
    });
  });

  it("new credit plans: monthly reset derives from CreatedAt's next anniversary", async () => {
    // Live shape verified 2026-09-17 on a new Pro subscription: /api/me
    // returns ID/CreatedAt/Email/Name/Plan — no SubscriptionPeriodEnd.
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({ status: 200, text: usageBody(null, null, 0.006) });
    mockedMe.mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        ID: "09c296ae-ff2b-4043-8ea7-33875c996f82",
        CreatedAt: "2026-09-12T13:38:00.308816Z",
        Email: "user@example.com",
        Plan: "pro",
      }),
    });
    const result = await queryOcUsage();
    expect(result).toMatchObject({ kind: "success", monthly: 0.006 });
    if (result.kind !== "success" || result.monthlyResetAt === undefined) {
      throw new Error("monthlyResetAt missing");
    }
    // Next monthly anniversary of the subscription day, within a month.
    expect(result.monthlyResetAt).toBeGreaterThan(result.fetchedAt);
    expect(result.monthlyResetAt - result.fetchedAt).toBeLessThanOrEqual(32 * 86_400_000);
  });

  it("nextMonthlyAnniversary: subscription-day monthly cycle with day clamping", () => {
    const Y = (s: string): number => Date.parse(s);
    // Mid-cycle: Sep 17 with a Sep 12 13:38 signup → Oct 12 13:38 UTC (the
    // subscription's own time-of-day, not a fixed midnight).
    expect(nextMonthlyAnniversary(Y("2026-09-12T13:38:00Z"), Y("2026-09-17T00:00:00Z"))).toBe(
      Y("2026-10-12T13:38:00Z"),
    );
    // Before the anniversary moment on the day → later that same day.
    expect(nextMonthlyAnniversary(Y("2026-09-12T13:38:00Z"), Y("2026-10-12T13:00:00Z"))).toBe(
      Y("2026-10-12T13:38:00Z"),
    );
    // Past the anniversary moment → next month.
    expect(nextMonthlyAnniversary(Y("2026-09-12T13:38:00Z"), Y("2026-10-12T14:00:00Z"))).toBe(
      Y("2026-11-12T13:38:00Z"),
    );
    // A Jan-31 signup clamps to Feb 28 (2026 not a leap year).
    expect(nextMonthlyAnniversary(Y("2026-01-31T09:15:00Z"), Y("2026-02-01T00:00:00Z"))).toBe(
      Y("2026-02-28T09:15:00Z"),
    );
  });

  it("monthly reset is omitted when /api/me fails (best-effort)", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({ status: 200, text: usageBody(null, null, 0.006) });
    mockedMe.mockRejectedValue(new Error("network down"));
    const result = await queryOcUsage();
    expect(result).toMatchObject({ kind: "success", monthly: 0.006 });
    expect(result.kind === "success" && result.monthlyResetAt).toBeUndefined();
  });

  it("maps HTTP 401 to auth_error", async () => {
    process.env.OLLAMA_API_KEY = "sk-bad";
    mockedFetch.mockResolvedValue({ status: 401, text: JSON.stringify({ error: "Unauthorized" }) });
    expect((await queryOcUsage()).kind).toBe("auth_error");
  });

  it("maps HTTP 429 (quota exhausted) to unavailable", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({ status: 429, text: JSON.stringify({ error: "weekly limit" }) });
    expect((await queryOcUsage()).kind).toBe("unavailable");
  });

  it("rejects usage values > 1 (future percent-shaped response guard)", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({ status: 200, text: usageBody(42, 50) });
    expect((await queryOcUsage()).kind).toBe("unavailable");
  });

  it("new credit plans: monthly-only response is a success", async () => {
    // Real shape observed 2026-09 on a credit plan: limits.monthly only
    // (plus activity/per-model data we don't render).
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        activity: { cost: "0.00000", period: {}, models: [] },
        limits: {
          monthly: { usage: 0.006, models: [{ name: "deepseek-v4.1-flash", request_count: 145 }] },
        },
      }),
    });
    const result = await queryOcUsage();
    expect(result).toMatchObject({ kind: "success", monthly: 0.006 });
    if (result.kind !== "success") return;
    expect(result.session).toBeUndefined();
    expect(result.weekly).toBeUndefined();
  });

  it("keeps a valid window when another window's value is invalid", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({ status: 200, text: usageBody(null, 0.5, 42) });
    const result = await queryOcUsage();
    expect(result).toMatchObject({ kind: "success", weekly: 0.5 });
  });

  it("degrades to unavailable on unrecognised body shape", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({ status: 200, text: JSON.stringify({ something: "else" }) });
    expect((await queryOcUsage()).kind).toBe("unavailable");
  });

  it("degrades to unavailable on non-JSON body", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({ status: 200, text: "<html>login</html>" });
    expect((await queryOcUsage()).kind).toBe("unavailable");
  });

  it("degrades to unavailable on network failure", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockRejectedValue(new Error("network down"));
    expect((await queryOcUsage()).kind).toBe("unavailable");
  });

  it("serves a cached result within the TTL window, re-fetches after expiry", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedFetch.mockResolvedValue({ status: 200, text: usageBody(0.1, 0.2) });
    await queryOcUsage();
    setClock(() => 5000 + 9_000);
    await queryOcUsage();
    expect(mockedFetch).toHaveBeenCalledTimes(1); // still cached
    setClock(() => 5000 + 10_001);
    await queryOcUsage();
    expect(mockedFetch).toHaveBeenCalledTimes(2); // expired → refetch
  });
});

// --- credential merging (config file + env) --------------------------------

describe("credential merging", () => {
  beforeEach(() => {
    clearCache();
    setClock(() => 5000);
    mockedFetch.mockReset();
    setFileKey(null);
    mockedFetch.mockResolvedValue({ status: 200, text: usageBody(0.1, 0.2) });
  });
  afterEach(() => {
    clearCache();
    setClock(undefined);
    delete process.env.OLLAMA_API_KEY;
  });

  it("uses the config file when env is absent", async () => {
    setFileKey("sk-file");
    expect((await queryOcUsage()).kind).toBe("success");
    expect(mockedFetch).toHaveBeenCalledWith("sk-file");
  });

  it("the config file overrides the env var (user-config precedence)", async () => {
    setFileKey("sk-file");
    process.env.OLLAMA_API_KEY = "sk-env";
    await queryOcUsage();
    expect(mockedFetch).toHaveBeenCalledWith("sk-file");
  });

  it("env fills in when the file has no quota section", async () => {
    setFileKey(null);
    process.env.OLLAMA_API_KEY = "sk-env";
    await queryOcUsage();
    expect(mockedFetch).toHaveBeenCalledWith("sk-env");
  });

  it("a blank key (env or file) counts as absent", async () => {
    process.env.OLLAMA_API_KEY = "   ";
    expect((await queryOcUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
