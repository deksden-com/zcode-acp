/**
 * formatQuotaDock tests (ADR-0021): the compact one-line dock string for the
 * Martty TUI — success shape, omitted MCP, missing windows, reset rendering,
 * and the null-on-failure contract.
 */

import { describe, expect, it } from "vitest";

import {
  composeQuotaDock,
  formatGoDockSegment,
  formatOcDockSegment,
  formatQuotaDock,
} from "../src/quota/format.js";
import type { OcQueryResult } from "../src/quota/ollama-cloud/types.js";
import type { GoQueryResult } from "../src/quota/opencode-go/types.js";
import type { QuotaItem, QuotaResult } from "../src/quota/types.js";

const NOW = 1_800_000_000_000;

function item(overrides: Partial<QuotaItem> & { key: string }): QuotaItem {
  return { label: overrides.key, usedPercent: 0, leftPercent: 100, ...overrides };
}

/** Local HH:MM of an epoch-ms timestamp (the dock shows the reset clock time). */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Local MM-DD of an epoch-ms timestamp (weekly/monthly reset dates). */
function date(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("formatQuotaDock", () => {
  it("renders 5h + weekly + reset clock time and omits MCP", () => {
    const reset = NOW + 2 * 3_600_000 + 13 * 60_000;
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [
        item({ key: "token_5h", usedPercent: 45, nextResetTime: reset }),
        item({ key: "token_week", usedPercent: 12, nextResetTime: NOW + 3 * 86_400_000 }),
        item({ key: "mcp", usedPercent: 80 }),
      ],
    };
    const wk = new Date(NOW + 3 * 86_400_000);
    const wkDate = `${String(wk.getMonth() + 1).padStart(2, "0")}-${String(wk.getDate()).padStart(2, "0")}`;
    expect(formatQuotaDock(result)).toBe(`45% ${clock(reset)} · 12% ${wkDate}`);
  });

  it("omits the weekly segment when absent", () => {
    const reset = NOW + 43 * 60_000;
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_5h", usedPercent: 7, nextResetTime: reset })],
    };
    expect(formatQuotaDock(result)).toBe(`7% ${clock(reset)}`);
  });

  it("zero-pads the clock minutes", () => {
    const reset = NOW + 3_600_000 + 2 * 60_000;
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_5h", usedPercent: 61, nextResetTime: reset })],
    };
    expect(formatQuotaDock(result)).toBe(`61% ${clock(reset)}`);
    expect(clock(reset)).toMatch(/^\d{2}:\d{2}$/);
  });

  it("omits the reset segment when the window carries no reset time", () => {
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [
        item({ key: "token_5h", usedPercent: 30 }),
        item({ key: "token_week", usedPercent: 5 }),
      ],
    };
    expect(formatQuotaDock(result)).toBe("30% · 5%");
  });

  it("returns null without a 5h window even on success", () => {
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_week", usedPercent: 5 }), item({ key: "mcp", usedPercent: 5 })],
    };
    expect(formatQuotaDock(result)).toBeNull();
  });

  it("returns null for every non-success result", () => {
    expect(formatQuotaDock({ kind: "auth_error" })).toBeNull();
    expect(formatQuotaDock({ kind: "rate_limited" })).toBeNull();
    expect(formatQuotaDock({ kind: "unavailable" })).toBeNull();
  });

  it("still shows a clock time when the reset moment is in the past", () => {
    const reset = NOW - 5_000;
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_5h", usedPercent: 99, nextResetTime: reset })],
    };
    expect(formatQuotaDock(result)).toBe(`99% ${clock(reset)}`);
  });
});

describe("formatGoDockSegment / composeQuotaDock", () => {
  const goSuccess = (monthly: number | null): GoQueryResult =>
    ({
      kind: "success",
      rolling: { usagePercent: 30, resetInSec: 3600 },
      weekly: { usagePercent: 12, resetInSec: 86400 },
      monthly: monthly === null ? null : { usagePercent: monthly, resetInSec: 2592000 },
      fetchedAt: NOW,
    }) as GoQueryResult;

  it("renders monthly only, percent + reset date", () => {
    const d = new Date(NOW + 2592000 * 1000);
    const date = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(formatGoDockSegment(goSuccess(8))).toBe(`go 8% ${date}`);
  });

  it("rounds raw micro-cents ratios to one decimal (console API precision)", () => {
    const d = new Date(NOW + 2592000 * 1000);
    const date = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(formatGoDockSegment(goSuccess(13.156372333333334))).toBe(`go 13.2% ${date}`);
    expect(formatGoDockSegment(goSuccess(84.25))).toBe(`go 84.3% ${date}`);
  });

  it("null when Go fails or has no monthly window", () => {
    expect(formatGoDockSegment(goSuccess(null))).toBeNull();
    expect(formatGoDockSegment({ kind: "not_configured" })).toBeNull();
    expect(formatGoDockSegment({ kind: "auth_error" })).toBeNull();
    expect(formatGoDockSegment({ kind: "unavailable" })).toBeNull();
  });

  it("composes GLM + Go segments with a separator", () => {
    expect(composeQuotaDock("45% 14:23 · 12% 10-18", "go 8% 10-11")).toBe(
      "45% 14:23 · 12% 10-18 · go 8% 10-11",
    );
    expect(composeQuotaDock("45%", null)).toBe("45%");
    expect(composeQuotaDock(null, "go 8% 10-11")).toBe("go 8% 10-11");
    expect(composeQuotaDock(null, null)).toBeNull();
  });
});

describe("formatOcDockSegment", () => {
  const ocSuccess = (
    windows: Partial<
      Pick<
        Extract<OcQueryResult, { kind: "success" }>,
        "session" | "weekly" | "monthly" | "sessionResetAt" | "weeklyResetAt" | "monthlyResetAt"
      >
    >,
  ): OcQueryResult => ({
    kind: "success",
    fetchedAt: NOW,
    ...windows,
  });

  it("shows ONLY the largest window the plan exposes, with its reset stamp", () => {
    // Monthly wins when present (credit plans) — session/weekly are dropped.
    expect(
      formatOcDockSegment(ocSuccess({ monthly: 0.304, monthlyResetAt: NOW + 5 * 86_400_000 })),
    ).toBe(`oc 30.4% ${date(NOW + 5 * 86_400_000)}`);
    // Weekly-only plans show the weekly window.
    expect(
      formatOcDockSegment(ocSuccess({ weekly: 0.42, weeklyResetAt: NOW + 2 * 86_400_000 })),
    ).toBe(`oc 42% ${date(NOW + 2 * 86_400_000)}`);
    // Legacy session window carries a clock-time reset.
    expect(
      formatOcDockSegment(ocSuccess({ session: 0.423, sessionResetAt: NOW + 3_600_000 })),
    ).toBe(`oc 42.3% ${clock(NOW + 3_600_000)}`);
  });

  it("omits the stamp when the reset moment is unknown (monthly /api/me failure)", () => {
    expect(formatOcDockSegment(ocSuccess({ monthly: 0.603 }))).toBe("oc 60.3%");
    expect(formatOcDockSegment(ocSuccess({ weekly: 0.2 }))).toBe("oc 20%");
  });

  it("clamps out-of-range fractions and nulls when nothing is usable", () => {
    expect(formatOcDockSegment(ocSuccess({ session: 1.4, sessionResetAt: NOW }))).toBe(
      `oc 100% ${clock(NOW)}`,
    );
    expect(formatOcDockSegment(ocSuccess({}))).toBeNull();
    expect(formatOcDockSegment({ kind: "not_configured" })).toBeNull();
    expect(formatOcDockSegment({ kind: "auth_error" })).toBeNull();
    expect(formatOcDockSegment({ kind: "unavailable" })).toBeNull();
  });
});
