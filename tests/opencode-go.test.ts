/**
 * Tests for the Opencode Go usage feature: console status JSON parsing
 * (micro-cents → percent/countdown, idle windows, parser rot), the HTTP
 * client contract (both cookies + x-org-id — header-shape test lives in
 * tests/opencode-go-client.test.ts), query orchestration (env-driven
 * credentials, cache TTL, error degradation), duration formatting, and
 * section rendering.
 *
 * Parser/formatter tests are pure-function. The orchestration tests mock the
 * client module so we control the (status, text) pair deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import process from "node:process";

// Mock the client so queryGoUsage orchestration can inject a deterministic
// (status, text) without depending on undici's Response.url.
vi.mock("../src/quota/opencode-go/client.js", () => ({
  fetchGoStatus: vi.fn(),
  goStatusUrl: () => "https://opencode.ai/console/api/go/status",
}));

// Control the own-config side of credential resolution (quota.opencodeGo*
// in ~/.config/zcode-acp/config.json).
const { loadUserConfigMock } = vi.hoisted(() => ({ loadUserConfigMock: vi.fn() }));
vi.mock("../src/config/user-config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config/user-config.js")>(
    "../src/config/user-config.js",
  );
  return { ...actual, loadUserConfig: loadUserConfigMock };
});

// Compute the config path here (not via import) so the fs mock factory below
// can reference it without worrying about vitest mock-hoist ordering. This
// must match src/quota/opencode-go/config.ts::CONFIG_PATH exactly.
const CONFIG_PATH_MOCK = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".pi",
  "agent",
  "opencode-go.json",
);

// Mock node:fs so readConfigFile tests can supply a fake config file without
// touching the real ~/.pi/agent/opencode-go.json (which may exist on the dev
// machine). The config path is fully intercepted: a hit returns the mock
// content, a miss throws ENOENT — it never falls through to the real fs, so
// tests are hermetic regardless of the host environment. Other paths fall
// through unchanged.
const mockFiles = new Map<string, string>();
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string, ...rest: unknown[]) => {
      if (p === CONFIG_PATH_MOCK) {
        if (mockFiles.has(p)) return mockFiles.get(p)!;
        const err = new Error(`ENOENT, no such file or directory '${p}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actual.readFileSync(p, ...(rest as [string]));
    },
  };
});

import { formatDuration, formatGoSection } from "../src/quota/opencode-go/format.js";
import { looksLikeGoStatus, parseGoStatus } from "../src/quota/opencode-go/parse.js";
import type { GoQueryResult } from "../src/quota/opencode-go/types.js";
import { clearCache, setClock } from "../src/quota/opencode-go/cache.js";
import { fetchGoStatus } from "../src/quota/opencode-go/client.js";
import { CONFIG_PATH, readConfigFile } from "../src/quota/opencode-go/config.js";
import { queryGoUsage } from "../src/quota/opencode-go/index.js";

// `fetchGoStatus` is mocked (see vi.mock above) for orchestration tests. The
// real HTTP-client header test lives in tests/opencode-go-client.test.ts.
const mockedFetch = vi.mocked(fetchGoStatus);
void mockedFetch;

// --- parser --------------------------------------------------------------

/** Fixed parse clock — 2026-09-19T04:00:00Z. */
const NOW = Date.parse("2026-09-19T04:00:00.000Z");

/** One raw API meter (micro-cents strings, ISO timestamps). */
function meter(
  used: string,
  limit: string,
  resetsAt: string | null = null,
): Record<string, unknown> {
  return { startsAt: resetsAt, resetsAt, limitMicroCents: limit, usedMicroCents: used };
}

/** Build a status payload body around a meters object. */
function statusJson(meters: Record<string, unknown>, endsAt = "2026-10-03T02:03:01.000Z"): string {
  return JSON.stringify({
    subscriberUserId: "acc_test",
    access: { startsAt: "2026-09-03T02:03:01.000Z", endsAt, meters },
  });
}

describe("parseGoStatus", () => {
  it("computes percents from micro-cents and countdowns from resetsAt", () => {
    const body = statusJson({
      fiveHour: meter("300000000", "1200000000", "2026-09-19T05:00:00.000Z"),
      week: meter("383736648", "3000000000", "2026-09-21T04:00:00.000Z"),
      month: meter("789382340", "6000000000"),
    });
    const parsed = parseGoStatus(body, NOW);
    expect(parsed.parserOutdated).toBe(false);
    expect(parsed.rolling).not.toBeNull();
    expect(parsed.rolling!.usagePercent).toBeCloseTo(25, 5);
    expect(parsed.rolling!.resetInSec).toBe(3600);
    expect(parsed.weekly!.usagePercent).toBeCloseTo((383736648 / 3_000_000_000) * 100, 5);
    expect(parsed.weekly!.resetInSec).toBe(172_800);
    // Month carries no resetsAt — anchored to access.endsAt (renewal instant).
    expect(parsed.monthly!.usagePercent).toBeCloseTo((789382340 / 6_000_000_000) * 100, 5);
    const monthReset = Date.parse("2026-10-03T02:03:01.000Z") / 1000 - NOW / 1000;
    expect(parsed.monthly!.resetInSec).toBe(Math.round(monthReset));
  });

  it("idle five-hour window (resetsAt null, used 0) → 0% with reset 0", () => {
    const parsed = parseGoStatus(
      statusJson({ fiveHour: meter("0", "1200000000", null), week: meter("1", "3000000000") }),
      NOW,
    );
    expect(parsed.rolling!.usagePercent).toBe(0);
    expect(parsed.rolling!.resetInSec).toBe(0);
  });

  it("flags parserOutdated when meters exist but no window parses", () => {
    const parsed = parseGoStatus(
      statusJson({ fiveHour: meter("abc", "0"), week: meter("1", "not-a-number") }),
      NOW,
    );
    expect(parsed.rolling).toBeNull();
    expect(parsed.weekly).toBeNull();
    expect(parsed.monthly).toBeNull();
    expect(parsed.parserOutdated).toBe(true);
  });

  it("non-JSON body → nulls, not parserOutdated", () => {
    const parsed = parseGoStatus("<html>error page</html>", NOW);
    expect(parsed.rolling).toBeNull();
    expect(parsed.weekly).toBeNull();
    expect(parsed.monthly).toBeNull();
    expect(parsed.parserOutdated).toBe(false);
  });

  it("JSON without access.meters → nulls, not parserOutdated", () => {
    const parsed = parseGoStatus(JSON.stringify({ hello: "world" }), NOW);
    expect(parsed.parserOutdated).toBe(false);
  });

  it("looksLikeGoStatus detects the access.meters shape", () => {
    expect(looksLikeGoStatus(JSON.parse(statusJson({})))).toBe(true);
    expect(looksLikeGoStatus({})).toBe(false);
    expect(looksLikeGoStatus(null)).toBe(false);
    expect(looksLikeGoStatus("nope")).toBe(false);
  });
});

// --- formatDuration ------------------------------------------------------

describe("formatDuration", () => {
  it("< 60s → <1m", () => {
    expect(formatDuration(0)).toBe("<1m");
    expect(formatDuration(30)).toBe("<1m");
    expect(formatDuration(59.9)).toBe("<1m");
  });

  it("minutes only", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(45 * 60)).toBe("45m");
  });

  it("hours + minutes", () => {
    expect(formatDuration(2 * 3600 + 30 * 60)).toBe("2h 30m");
  });

  it("days + hours", () => {
    expect(formatDuration(6 * 86_400 + 8 * 3600)).toBe("6d 8h");
  });

  it("non-finite → <1m (defensive)", () => {
    expect(formatDuration(Number.NaN)).toBe("<1m");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("<1m");
  });
});

// --- formatGoSection -----------------------------------------------------

describe("formatGoSection", () => {
  const success: GoQueryResult = {
    kind: "success",
    rolling: { usagePercent: 42, resetInSec: 3600 },
    weekly: { usagePercent: 17, resetInSec: 604800 },
    monthly: { usagePercent: 8, resetInSec: 2592000 },
    fetchedAt: 1000,
  };

  it("renders all three windows when requested", () => {
    const sec = formatGoSection(success, ["rolling", "weekly", "monthly"], 1000);
    expect(sec.header).toBe("Opencode Go");
    expect(sec.body).toHaveLength(3);
    expect(sec.body[0]).toContain("5h");
    expect(sec.body[0]).toContain("42%");
    // Reset time renders as an absolute MM-DD HH:MM stamp (same layout as GLM).
    expect(sec.body[0]).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    expect(sec.body[1]).toContain("Week");
    expect(sec.body[1]).toContain("17%");
    expect(sec.body[2]).toContain("Month");
    expect(sec.body[2]).toContain("8%");
  });

  it("renders only requested windows (rolling + weekly)", () => {
    const sec = formatGoSection(success, ["rolling", "weekly"], 1000);
    expect(sec.body).toHaveLength(2);
    expect(sec.body.find((l) => l.includes("Month"))).toBeUndefined();
  });

  it("shows the reset time advancing as elapsed time grows (live ticker)", () => {
    // Reset stamp = fetchedAt + remainingSec*1000. As `now` advances, remaining
    // shrinks, so the stamp moves earlier. The rolling window (resetInSec=3600)
    // at now=1000  → resets at fetchedAt+3600s; at now=31000 → fetchedAt+3570s.
    const early = formatGoSection(success, ["rolling"], 1000).body[0]!;
    const later = formatGoSection(success, ["rolling"], 31_000).body[0]!;
    // Both must be valid MM-DD HH:MM stamps.
    expect(early).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    expect(later).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("clamps the remaining time at 0 (reset stamp stays at fetchedAt, never negative)", () => {
    // 1h past the reset instant — remaining clamps at 0.
    const line = formatGoSection(success, ["rolling"], 1000 + 3600_000 + 60_000).body[0]!;
    expect(line).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("renders '(no data)' when a requested window is null", () => {
    const partial: GoQueryResult = { ...success, monthly: null };
    const sec = formatGoSection(partial, ["monthly"], 1000);
    expect(sec.body[0]).toContain("(no data)");
  });

  it("non-success kinds render a single explanation line", () => {
    expect(formatGoSection({ kind: "auth_error" }, ["rolling"], 1000).body).toHaveLength(1);
    expect(formatGoSection({ kind: "unavailable" }, ["rolling"], 1000).body).toHaveLength(1);
    const nc = formatGoSection({ kind: "not_configured" }, ["rolling"], 1000);
    expect(nc.body[0]).toContain("OPENCODE_GO");
  });

  describe("color mode", () => {
    it("emits ANSI escapes and overlays NN% inside the bar; reset stays on the right", () => {
      const ESC = String.fromCharCode(27);
      const stripAnsi = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
      const rolling = formatGoSection(success, ["rolling"], 1000, true).body[0]!;
      expect(rolling).toContain(`${ESC}[48;2;`);
      const visible = stripAnsi(rolling);
      expect(visible).toContain("42%");
      expect(visible).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
      expect(visible).not.toContain("█");
      expect(visible).not.toContain("░");
    });

    it("color=false keeps the classic plain layout (no ANSI)", () => {
      const line = formatGoSection(success, ["rolling"], 1000, false).body[0]!;
      expect(line).not.toContain("\x1b[");
    });
  });
});

// --- queryGoUsage orchestration ------------------------------------------

describe("queryGoUsage orchestration", () => {
  beforeEach(() => {
    clearCache();
    setClock(() => 5000);
    mockedFetch.mockReset();
    mockFiles.clear();
    loadUserConfigMock.mockReset();
    loadUserConfigMock.mockReturnValue({});
  });
  afterEach(() => {
    clearCache();
    setClock(undefined);
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    delete process.env.OPENCODE_GO_SESSION_TOKEN;
    mockFiles.clear();
  });

  it("returns not_configured when env vars are absent", async () => {
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    delete process.env.OPENCODE_GO_SESSION_TOKEN;
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("returns not_configured when the session token is missing (auth cookie alone 401s)", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**x";
    // no OPENCODE_GO_SESSION_TOKEN
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("returns not_configured when workspaceId format is invalid", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "bad-id";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**x";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_valid_enough";
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("returns not_configured when cookie prefix is wrong", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "not-the-right-prefix";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_valid_enough";
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("parses a successful status response", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_session";
    mockedFetch.mockResolvedValue({
      status: 200,
      text: statusJson({
        fiveHour: meter("600000000", "1200000000", "2026-09-19T07:00:00.000Z"),
        week: meter("300000000", "3000000000", "2026-09-21T04:00:00.000Z"),
        month: meter("600000000", "6000000000"),
      }),
    });
    const result = await queryGoUsage();
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.rolling.usagePercent).toBeCloseTo(50, 5);
    expect(result.weekly.usagePercent).toBeCloseTo(10, 5);
    expect(result.monthly?.usagePercent).toBeCloseTo(10, 5);
  });

  it("classifies 401 as auth_error", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**expired";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_expired";
    mockedFetch.mockResolvedValue({ status: 401, text: "" });
    expect((await queryGoUsage()).kind).toBe("auth_error");
  });

  it("classifies 400 (unknown org id) as auth_error — same credentials remedy", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_session";
    mockedFetch.mockResolvedValue({ status: 400, text: "" });
    expect((await queryGoUsage()).kind).toBe("auth_error");
  });

  it("degrades to unavailable on other HTTP errors (e.g. 503)", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_session";
    mockedFetch.mockResolvedValue({ status: 503, text: "" });
    expect((await queryGoUsage()).kind).toBe("unavailable");
  });

  it("degrades to unavailable on network failure", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_session";
    mockedFetch.mockRejectedValue(new Error("network down"));
    expect((await queryGoUsage()).kind).toBe("unavailable");
  });

  it("degrades to unavailable on parser rot (meters present but unparseable)", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_session";
    mockedFetch.mockResolvedValue({
      status: 200,
      text: statusJson({ fiveHour: meter("abc", "0"), week: meter("x", "y") }),
    });
    expect((await queryGoUsage()).kind).toBe("unavailable");
  });

  it("serves a cached result within the TTL window", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_session";
    mockedFetch.mockResolvedValue({
      status: 200,
      text: statusJson({ fiveHour: meter("1", "1200000000") }),
    });
    await queryGoUsage();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    setClock(() => 5000 + 9_000); // 9s later — still fresh
    await queryGoUsage();
    expect(mockedFetch).toHaveBeenCalledTimes(1); // cached — no new fetch
  });

  it("re-fetches once the TTL expires", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_session";
    mockedFetch.mockResolvedValue({
      status: 200,
      text: statusJson({ fiveHour: meter("1", "1200000000") }),
    });
    await queryGoUsage();
    setClock(() => 5000 + 10_001); // expired
    await queryGoUsage();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

// --- readConfigFile (mocked fs) ------------------------------------------

describe("readConfigFile", () => {
  afterEach(() => mockFiles.clear());

  it("parses a valid {workspaceId, authCookie, sessionToken} JSON file", () => {
    mockFiles.set(
      CONFIG_PATH,
      JSON.stringify({ workspaceId: "wrk_x", authCookie: "Fe26.2**y", sessionToken: "st_z" }),
    );
    expect(readConfigFile()).toEqual({
      workspaceId: "wrk_x",
      authCookie: "Fe26.2**y",
      sessionToken: "st_z",
    });
  });

  it("returns empty object when the file is missing (ENOENT — silent)", () => {
    mockFiles.clear();
    expect(readConfigFile()).toEqual({});
  });

  it("returns empty object on invalid JSON (logged, non-fatal)", () => {
    mockFiles.set(CONFIG_PATH, "{not valid json");
    expect(readConfigFile()).toEqual({});
  });

  it("ignores non-string / unknown fields", () => {
    mockFiles.set(
      CONFIG_PATH,
      JSON.stringify({ workspaceId: "wrk_x", authCookie: 123, extra: "ignored" }),
    );
    // authCookie is a number → treated as absent.
    expect(readConfigFile()).toEqual({ workspaceId: "wrk_x", authCookie: undefined });
  });

  it("rejects a top-level non-object (array / primitive)", () => {
    mockFiles.set(CONFIG_PATH, JSON.stringify(["nope"]));
    expect(readConfigFile()).toEqual({});
    mockFiles.set(CONFIG_PATH, JSON.stringify("nope"));
    expect(readConfigFile()).toEqual({});
  });
});

// --- queryGoUsage credential merging (env + config file) -----------------

describe("queryGoUsage credential merging", () => {
  beforeEach(() => {
    clearCache();
    setClock(() => 5000);
    mockedFetch.mockReset();
    mockFiles.clear();
    loadUserConfigMock.mockReset();
    loadUserConfigMock.mockReturnValue({});
    // A complete env triple by default; individual tests unset what they need.
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_ENV0";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**env";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_env_token";
    mockedFetch.mockImplementation(async () => ({
      status: 200,
      text: statusJson({ fiveHour: meter("1", "1200000000") }),
    }));
  });
  afterEach(() => {
    clearCache();
    setClock(undefined);
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    delete process.env.OPENCODE_GO_SESSION_TOKEN;
    mockFiles.clear();
  });

  it("uses the config file when env is absent", async () => {
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    delete process.env.OPENCODE_GO_SESSION_TOKEN;
    mockFiles.set(
      CONFIG_PATH,
      JSON.stringify({
        workspaceId: "wrk_FILE0",
        authCookie: "Fe26.2**file",
        sessionToken: "st_file_token",
      }),
    );
    const result = await queryGoUsage();
    expect(result.kind).toBe("success");
    expect(mockedFetch).toHaveBeenCalledWith("wrk_FILE0", "Fe26.2**file", "st_file_token");
  });

  it("env overrides the file field-by-field", async () => {
    mockFiles.set(
      CONFIG_PATH,
      JSON.stringify({
        workspaceId: "wrk_FILE0",
        authCookie: "Fe26.2**file",
        sessionToken: "st_file_token",
      }),
    );
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_ENV0"; // override only workspaceId
    delete process.env.OPENCODE_GO_AUTH_COOKIE; // cookie still comes from the file
    delete process.env.OPENCODE_GO_SESSION_TOKEN; // token still comes from the file
    const result = await queryGoUsage();
    expect(result.kind).toBe("success");
    expect(mockedFetch).toHaveBeenCalledWith("wrk_ENV0", "Fe26.2**file", "st_file_token");
  });

  it("env fills a field the file lacks", async () => {
    delete process.env.OPENCODE_GO_SESSION_TOKEN; // env keeps id+cookie; file supplies token
    mockFiles.set(
      CONFIG_PATH,
      JSON.stringify({ sessionToken: "st_file_token" }), // only the token
    );
    const result = await queryGoUsage();
    expect(result.kind).toBe("success");
    expect(mockedFetch).toHaveBeenCalledWith("wrk_ENV0", "Fe26.2**env", "st_file_token");
  });

  it("returns not_configured when neither env nor file supplies the full triple", async () => {
    delete process.env.OPENCODE_GO_SESSION_TOKEN;
    mockFiles.set(CONFIG_PATH, JSON.stringify({ workspaceId: "wrk_FILE0" })); // no cookie/token
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("returns not_configured when the file is corrupt and env is absent", async () => {
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    delete process.env.OPENCODE_GO_SESSION_TOKEN;
    mockFiles.set(CONFIG_PATH, "{broken");
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

// --- own-config (quota.opencodeGo*) precedence ------------------------------

describe("own-config credential precedence", () => {
  beforeEach(() => {
    clearCache();
    setClock(() => 5000);
    mockedFetch.mockReset();
    mockFiles.clear();
    loadUserConfigMock.mockReset();
    loadUserConfigMock.mockReturnValue({});
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_env_token"; // token baseline for merge cases
    mockedFetch.mockImplementation(async () => ({
      status: 200,
      text: statusJson({ fiveHour: meter("1", "1200000000") }),
    }));
  });
  afterEach(() => {
    clearCache();
    setClock(undefined);
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    delete process.env.OPENCODE_GO_SESSION_TOKEN;
    mockFiles.clear();
  });

  it("quota.opencodeGo* in the own config is used when env/pi-file are absent", async () => {
    loadUserConfigMock.mockReturnValue({
      quota: {
        opencodeGoWorkspaceId: "wrk_OWN",
        opencodeGoAuthCookie: "Fe26.2**own",
        opencodeGoSessionToken: "st_own_token",
      },
    });
    expect((await queryGoUsage()).kind).toBe("success");
    expect(mockedFetch).toHaveBeenCalledWith("wrk_OWN", "Fe26.2**own", "st_own_token");
  });

  it("own config overrides env and the legacy pi file (highest precedence)", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_ENV";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**env";
    mockFiles.set(
      CONFIG_PATH,
      JSON.stringify({
        workspaceId: "wrk_PI",
        authCookie: "Fe26.2**pi",
        sessionToken: "st_pi_token",
      }),
    );
    loadUserConfigMock.mockReturnValue({
      quota: {
        opencodeGoWorkspaceId: "wrk_OWN",
        opencodeGoAuthCookie: "Fe26.2**own",
        opencodeGoSessionToken: "st_own_token",
      },
    });
    await queryGoUsage();
    expect(mockedFetch).toHaveBeenCalledWith("wrk_OWN", "Fe26.2**own", "st_own_token");
  });

  it("own config fills one field; the others still fall through to env/pi-file", async () => {
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**env";
    loadUserConfigMock.mockReturnValue({ quota: { opencodeGoWorkspaceId: "wrk_OWN" } });
    await queryGoUsage();
    expect(mockedFetch).toHaveBeenCalledWith("wrk_OWN", "Fe26.2**env", "st_env_token");
  });

  it("env still overrides the legacy pi file when own config is absent", async () => {
    mockFiles.set(
      CONFIG_PATH,
      JSON.stringify({
        workspaceId: "wrk_PI",
        authCookie: "Fe26.2**pi",
        sessionToken: "st_pi_token",
      }),
    );
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_ENV";
    await queryGoUsage();
    // Cookie from the file; token from env — per-field precedence.
    expect(mockedFetch).toHaveBeenCalledWith("wrk_ENV", "Fe26.2**pi", "st_env_token");
  });
});
