/**
 * Opencode Go status HTTP client.
 *
 * The Go dashboard moved off the legacy SSR page (`/workspace/<id>/go` — that
 * URL now bounces EVERY cookie to the login page, observed 2026-09-19) onto
 * the console at `https://opencode.ai/console/<org>/go`, backed by this JSON
 * API. Usage arrives as micro-cents meter pairs per window; the parser turns
 * them into percent + countdown.
 *
 * Auth needs THREE pieces (verified against the live API 2026-09-19): the
 * `auth` cookie, the `__Host-console_session` cookie, and the `x-org-id`
 * header. Missing session cookie → 401, missing org header → 400; any
 * User-Agent works (one is sent for parity with the console's own requests).
 */

/** Request timeout (ms). */
const TIMEOUT_MS = 10_000;

/** Browser-like User-Agent, mirroring the console's own XHR requests. */
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

/** The console status API endpoint (the org rides the `x-org-id` header). */
export function goStatusUrl(): string {
  return "https://opencode.ai/console/api/go/status";
}

/**
 * Fetch the Go status JSON.
 *
 * @throws on network errors or timeout; the caller maps these to
 *         `unavailable`. Auth failures are NOT thrown here — the HTTP status
 *         is returned so the orchestrator can classify 400/401/403 as
 *         `auth_error`.
 */
export async function fetchGoStatus(
  workspaceId: string,
  authCookie: string,
  sessionToken: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ status: number; text: string }> {
  const resp = await fetchImpl(goStatusUrl(), {
    method: "GET",
    headers: {
      Cookie: `auth=${authCookie}; __Host-console_session=${sessionToken}`,
      "x-org-id": workspaceId,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}
