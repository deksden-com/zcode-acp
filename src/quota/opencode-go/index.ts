/**
 * Opencode Go usage orchestration — the entry point used by the
 * `zcode-acp quota` CLI and the quota dock.
 *
 * Flow: credentials (env + config file) → cache check → fetch → status/auth
 * check → parse → cache write. Any thrown error degrades to `unavailable`
 * rather than propagating, so the CLI always produces output.
 *
 * A missing/invalid credential triple yields `not_configured`, which the
 * combined view silently skips (vs. `unavailable`, which renders an error
 * line) — so users who only care about GLM see no noise.
 */

import { loadUserConfig } from "../../config/user-config.js";
import { log } from "../../utils.js";
import { getCached, setCached } from "./cache.js";
import { ENV_AUTH_COOKIE, ENV_SESSION_TOKEN, ENV_WORKSPACE_ID, readConfigFile } from "./config.js";
import { fetchGoStatus } from "./client.js";
import { parseGoStatus } from "./parse.js";
import type { GoQueryResult } from "./types.js";

/** Format validators (match pi-go-bars conventions). */
const RE_WORKSPACE = /^wrk_[A-Za-z0-9]+$/;
const COOKIE_PREFIX = "Fe26.2**";

/** Minimum plausible session-token length (console `st_…` values). */
const MIN_SESSION_TOKEN = 8;

/**
 * Resolve & validate credentials.
 *
 * Three sources, merged field-by-field with the standard user-config
 * precedence (highest first):
 *   1. `quota.opencodeGoWorkspaceId` / `opencodeGoAuthCookie` /
 *      `opencodeGoSessionToken` in `~/.config/zcode-acp/config.json` (our own
 *      config — preferred home).
 *   2. `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE` /
 *      `OPENCODE_GO_SESSION_TOKEN` env vars.
 *   3. `~/.pi/agent/opencode-go.json` (legacy — the @beyona/pi-zai-usage Pi
 *      extension convention, kept so existing setups keep working).
 *
 * The session token is REQUIRED since the 2026-09 console migration: the
 * status API answers 401 to an `auth` cookie alone. A field present in a
 * higher-precedence source overrides the same field below it; a field present
 * only lower down still counts. Returns `null` when the resolved triple is
 * incomplete or malformed — `queryGoUsage` maps that to `not_configured`.
 */
function loadCredentials(): {
  workspaceId: string;
  authCookie: string;
  sessionToken: string;
} | null {
  const own = loadUserConfig().quota;
  const file = readConfigFile();
  const workspaceId =
    own?.opencodeGoWorkspaceId ?? process.env[ENV_WORKSPACE_ID] ?? file.workspaceId;
  const authCookie = own?.opencodeGoAuthCookie ?? process.env[ENV_AUTH_COOKIE] ?? file.authCookie;
  const sessionToken =
    own?.opencodeGoSessionToken ?? process.env[ENV_SESSION_TOKEN] ?? file.sessionToken;

  if (!workspaceId || !authCookie || !sessionToken) return null;
  if (!RE_WORKSPACE.test(workspaceId)) {
    log(`opencode-go: invalid workspaceId format (expected wrk_…)`);
    return null;
  }
  if (!authCookie.startsWith(COOKIE_PREFIX)) {
    log(`opencode-go: authCookie does not start with ${COOKIE_PREFIX}`);
    return null;
  }
  if (sessionToken.trim().length < MIN_SESSION_TOKEN) {
    log(`opencode-go: sessionToken looks malformed (__Host-console_session value, st_…)`);
    return null;
  }
  return { workspaceId, authCookie, sessionToken };
}

/**
 * Query the Opencode Go console status API and return a normalised
 * {@link GoQueryResult}.
 *
 * - No credentials / invalid → `not_configured`.
 * - Serves a cached result when fresh (< 10s).
 * - HTTP 400/401/403 → `auth_error` (bad/missing org id or cookie pair).
 * - Network/timeout/parse failure → `unavailable`.
 */
export async function queryGoUsage(): Promise<GoQueryResult> {
  const cached = getCached();
  if (cached) {
    log("opencode-go: serving cached result");
    return cached;
  }

  const creds = loadCredentials();
  if (!creds) return { kind: "not_configured" };

  let result: GoQueryResult;
  try {
    const resp = await fetchGoStatus(creds.workspaceId, creds.authCookie, creds.sessionToken);

    // 401/403 = bad cookie pair; 400 = missing/unknown org id (x-org-id).
    // The remedy is the same for all three — re-grab credentials — so they
    // share auth_error.
    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      result = { kind: "auth_error" };
    } else if (resp.status < 200 || resp.status >= 300) {
      result = { kind: "unavailable" };
    } else {
      const parsed = parseGoStatus(resp.text);
      if (parsed.parserOutdated) {
        log("opencode-go: status JSON recognised but no windows parsed (parser outdated)");
        result = { kind: "unavailable" };
      } else if (!parsed.rolling && !parsed.weekly && !parsed.monthly) {
        // Not a status payload at all (e.g. an HTML error page).
        result = { kind: "unavailable" };
      } else {
        result = {
          kind: "success",
          // Rolling and weekly are the two windows the CLI shows by default;
          // fall back to zeroes if somehow absent so the type stays simple.
          rolling: parsed.rolling ?? { usagePercent: 0, resetInSec: 0 },
          weekly: parsed.weekly ?? { usagePercent: 0, resetInSec: 0 },
          monthly: parsed.monthly,
          fetchedAt: Date.now(),
        };
      }
    }
  } catch (e) {
    log(`opencode-go: fetch failed (${e instanceof Error ? e.message : String(e)})`);
    result = { kind: "unavailable" };
  }

  setCached(result);
  return result;
}

// Re-exports for consumers (CLI + tests).
export { clearCache, clearCache as clearGoCache } from "./cache.js";
export { fetchGoStatus, goStatusUrl } from "./client.js";
export { parseGoStatus, looksLikeGoStatus } from "./parse.js";
export { formatDuration, formatGoSection } from "./format.js";
export {
  readConfigFile,
  CONFIG_PATH,
  ENV_WORKSPACE_ID,
  ENV_AUTH_COOKIE,
  ENV_SESSION_TOKEN,
} from "./config.js";
export type { GoQueryResult, GoWindow, GoWindowKey, GoStatusResponse } from "./types.js";
