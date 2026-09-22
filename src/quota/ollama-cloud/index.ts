/**
 * Ollama Cloud usage orchestration — the entry point used by the
 * `zcode-acp quota` CLI.
 *
 * Flow: credential (env + config file) → cache check → fetch → status/auth
 * check → parse → cache write. Any thrown error degrades to `unavailable`
 * rather than propagating, so the CLI always produces output.
 *
 * A missing API key yields `not_configured`, which the combined view silently
 * skips — so users who only care about GLM see no noise.
 */

import { log } from "../../utils.js";
import { getCached, setCached } from "./cache.js";
import { loadApiKey } from "./config.js";
import { fetchOcMe, fetchOcUsage } from "./client.js";
import type { OcQueryResult } from "./types.js";

/** Session window length: a rolling 5h bucket anchored at the Unix epoch. */
export const SESSION_WINDOW_MS = 5 * 3_600_000;
/** Weekly window anchor: Monday 00:00 UTC (the epoch was a Thursday, so the
 *  first Monday sits 4 days in) — same inference as the pi-multi-account
 *  reference client. */
export const WEEK_ANCHOR_MS = 4 * 86_400_000;
const WEEK_MS = 7 * 86_400_000;

/**
 * Next reset of the epoch-aligned 5h session bucket strictly after `t`.
 * The anchoring is inferred from observed bucket behaviour (undocumented).
 */
export function nextSessionReset(t: number): number {
  return (Math.floor(t / SESSION_WINDOW_MS) + 1) * SESSION_WINDOW_MS;
}

/** Next Monday 00:00 UTC strictly after `t` (the weekly window reset). */
export function nextWeeklyReset(t: number): number {
  const next = WEEK_ANCHOR_MS + (Math.floor((t - WEEK_ANCHOR_MS) / WEEK_MS) + 1) * WEEK_MS;
  return next > t ? next : next + WEEK_MS;
}

/**
 * Best-effort monthly reset lookup via POST /api/me. Two shapes exist:
 * - `SubscriptionPeriodEnd` (Go `sql.NullTime` `{Time, Valid}`) — the billing
 *   period end, when the account carries one;
 * - `CreatedAt` — the subscription start. New credit plans (live-verified
 *   2026-09-17: a Pro account returns only ID/CreatedAt/Email/Plan, no
 *   SubscriptionPeriodEnd) reset monthly on the subscription day, so the
 *   reset is the next monthly anniversary of that timestamp.
 * Any failure (network, auth, shape) yields undefined — the caller then
 * renders the monthly window without a reset stamp.
 */
async function lookupMonthlyReset(apiKey: string): Promise<number | undefined> {
  try {
    const resp = await fetchOcMe(apiKey);
    if (resp.status !== 200) return undefined;
    const parsed = JSON.parse(resp.text) as Record<string, unknown>;
    const period = parsed.SubscriptionPeriodEnd ?? parsed.subscriptionPeriodEnd;
    if (period !== undefined) {
      const raw =
        (period as { Time?: unknown; time?: unknown }).Time ?? (period as { time?: unknown }).time;
      const valid =
        (period as { Valid?: unknown; valid?: unknown }).Valid ??
        (period as { valid?: unknown }).valid;
      if (valid !== false && typeof raw === "string") {
        const ms = Date.parse(raw);
        if (Number.isFinite(ms)) return ms;
      }
    }
    const createdRaw = parsed.CreatedAt ?? parsed.createdAt;
    if (typeof createdRaw === "string") {
      const created = Date.parse(createdRaw);
      if (Number.isFinite(created)) return nextMonthlyAnniversary(created, Date.now());
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Next monthly anniversary of `createdMs` strictly after `now` — new credit
 * plans reset monthly on the subscription day, so the anchor keeps the
 * subscription's UTC time-of-day, not a made-up midnight. The day clamps to
 * the target month's length (a 31st signup rolls to the 30th/28th).
 */
export function nextMonthlyAnniversary(createdMs: number, now: number): number {
  const created = new Date(createdMs);
  const nowDate = new Date(now);
  const day = created.getUTCDate();
  const h = created.getUTCHours();
  const min = created.getUTCMinutes();
  const sec = created.getUTCSeconds();
  const ms = created.getUTCMilliseconds();
  for (let year = nowDate.getUTCFullYear(); year <= nowDate.getUTCFullYear() + 1; year++) {
    for (
      let month = year === nowDate.getUTCFullYear() ? nowDate.getUTCMonth() : 0;
      month < 12;
      month++
    ) {
      // Clamp to the month's last day (UTC months are 0-based).
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const candidate = Date.UTC(year, month, Math.min(day, lastDay), h, min, sec, ms);
      if (candidate > now) return candidate;
    }
  }
  return Number.NaN;
}

/**
 * Validate a usage value from the response body: a finite number in [0, 1].
 *
 * Values > 1 are rejected on purpose: the endpoint is undocumented, and if
 * Ollama ever switches to percent-valued numbers, silently treating 42 as a
 * 4200% fraction would render a nonsensical full bar. The same guard is used
 * by the pi-multi-account reference client.
 */
function validFraction(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * Query Ollama Cloud usage and return a normalised {@link OcQueryResult}.
 *
 * - No key → `not_configured`.
 * - Serves a cached result when fresh (< 10s).
 * - HTTP 401/403 → `auth_error` (bad or revoked key).
 * - Network/timeout/parse failure → `unavailable`.
 */
export async function queryOcUsage(): Promise<OcQueryResult> {
  const cached = getCached();
  if (cached) {
    log("ollama-cloud: serving cached result");
    return cached;
  }

  const apiKey = loadApiKey();
  if (!apiKey) return { kind: "not_configured" };

  let result: OcQueryResult;
  try {
    const resp = await fetchOcUsage(apiKey);

    if (resp.status === 401 || resp.status === 403) {
      result = { kind: "auth_error" };
    } else if (resp.status !== 200) {
      // 429 = quota exhausted, 5xx = server-side; neither is a usage snapshot.
      log(`ollama-cloud: unexpected status ${resp.status}`);
      result = { kind: "unavailable" };
    } else {
      const parsed = JSON.parse(resp.text) as {
        limits?: Record<string, { usage?: unknown } | undefined>;
      };
      const limits = parsed.limits ?? {};
      const window = (key: "session" | "weekly" | "monthly") =>
        validFraction(limits[key]?.usage) ? limits[key].usage : undefined;
      const session = window("session");
      const weekly = window("weekly");
      const monthly = window("monthly");
      if (session !== undefined || weekly !== undefined || monthly !== undefined) {
        // At least one recognised window — legacy plans carry session+weekly,
        // current credit plans carry monthly only. Reset moments: session and
        // weekly derive from the window anchoring; monthly needs the separate
        // /api/me billing-period lookup.
        const fetchedAt = Date.now();
        result = {
          kind: "success",
          ...(session !== undefined && { session, sessionResetAt: nextSessionReset(fetchedAt) }),
          ...(weekly !== undefined && { weekly, weeklyResetAt: nextWeeklyReset(fetchedAt) }),
          ...(monthly !== undefined && { monthly }),
          fetchedAt,
        };
        if (monthly !== undefined) {
          const monthlyResetAt = await lookupMonthlyReset(apiKey);
          if (monthlyResetAt !== undefined) result.monthlyResetAt = monthlyResetAt;
        }
      } else {
        log("ollama-cloud: response shape not recognised (endpoint may have changed)");
        result = { kind: "unavailable" };
      }
    }
  } catch (e) {
    log(`ollama-cloud: fetch failed (${e instanceof Error ? e.message : String(e)})`);
    result = { kind: "unavailable" };
  }

  setCached(result);
  return result;
}

// Re-exports for consumers (CLI + tests).
export { clearCache, clearCache as clearOcCache } from "./cache.js";
export { fetchOcMe, fetchOcUsage, ME_URL, USAGE_URL } from "./client.js";
export { formatOcSection } from "./format.js";
export { loadApiKey, ENV_API_KEY } from "./config.js";
export type { OcQueryResult, OcUsageResponse } from "./types.js";
