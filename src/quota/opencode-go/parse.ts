/**
 * Opencode Go status JSON parser.
 *
 * The console API (`/console/api/go/status`) returns meter pairs in
 * micro-cents per window; we compute the percent (used/limit) and the reset
 * countdown (resetsAt − now) here — the API gives absolute timestamps, the
 * formatter wants a relative countdown captured at fetch time.
 *
 * Window mapping:
 *   rolling ← meters.fiveHour (resetsAt is null while the window is idle → 0)
 *   weekly  ← meters.week
 *   monthly ← meters.month (carries no resetsAt — anchored to access.endsAt,
 *             the subscription renewal instant)
 */

import type { GoWindow } from "./types.js";

/** One raw meter as served by the API (micro-cents arrive as strings). */
interface RawMeter {
  startsAt?: string | null;
  resetsAt?: string | null;
  limitMicroCents?: string | number;
  usedMicroCents?: string | number;
}

/** Result of parsing the status payload — each window is independently optional. */
export interface ParsedGoStatus {
  rolling: GoWindow | null;
  weekly: GoWindow | null;
  monthly: GoWindow | null;
  /**
   * True when the body parsed and carries the status shape but no window
   * matched — the API layout changed (parser rot).
   */
  parserOutdated: boolean;
}

function microCents(v: string | number | undefined): number | null {
  const n = typeof v === "number" ? v : v === undefined ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

function windowFrom(
  meter: RawMeter | undefined,
  fallbackResetAt: string | undefined,
  now: number,
): GoWindow | null {
  if (!meter) return null;
  const used = microCents(meter.usedMicroCents);
  const limit = microCents(meter.limitMicroCents);
  if (used === null || limit === null || limit <= 0) return null;
  const usagePercent = Math.min(100, (used / limit) * 100);
  const resetMs = meter.resetsAt ?? fallbackResetAt;
  const at = resetMs !== undefined ? Date.parse(resetMs) : Number.NaN;
  const resetInSec = Number.isFinite(at) ? Math.max(0, Math.round((at - now) / 1000)) : 0;
  return { usagePercent, resetInSec };
}

/** Detect the status payload shape (`access.meters`) — the parser-rot guard. */
export function looksLikeGoStatus(parsed: unknown): boolean {
  const meters = (parsed as { access?: { meters?: unknown } } | null)?.access?.meters;
  return typeof meters === "object" && meters !== null;
}

export function parseGoStatus(text: string, now: number = Date.now()): ParsedGoStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { rolling: null, weekly: null, monthly: null, parserOutdated: false };
  }
  const access = (parsed as { access?: { meters?: Record<string, RawMeter>; endsAt?: string } })
    ?.access;
  const meters = access?.meters;
  if (typeof meters !== "object" || meters === null) {
    return { rolling: null, weekly: null, monthly: null, parserOutdated: false };
  }
  const rolling = windowFrom(meters.fiveHour, undefined, now);
  const weekly = windowFrom(meters.week, undefined, now);
  const monthly = windowFrom(meters.month, access?.endsAt, now);
  return {
    rolling,
    weekly,
    monthly,
    parserOutdated: !rolling && !weekly && !monthly,
  };
}
