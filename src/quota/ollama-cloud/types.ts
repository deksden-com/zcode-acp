/**
 * Type definitions for the Ollama Cloud subscription usage feature.
 *
 * `zcode-acp quota` queries the undocumented-but-live
 * `GET https://ollama.com/api/usage` endpoint with the user's API key. The
 * response carries two usage fractions (session = 5h rolling window, weekly =
 * 7d window) in [0, 1] and NO reset timestamps — the server does not expose
 * them, so reset moments are DERIVED client-side (see OcQueryResult) and the
 * card shows them when available.
 *
 * Shape verified against live probes + the pi-multi-account reference client
 * (2026-09); see `.zcode/scratch/research-ollama-cloud-usage.md`. Undocumented
 * — treat parse failures as `unavailable`, never as a crash.
 */

/**
 * Result of querying Ollama Cloud usage — a 4-state sum type mirroring
 * {@link ../opencode-go/types.js GoQueryResult}.
 *
 * `not_configured` is distinct from `unavailable`: the CLI uses it to silently
 * skip the Ollama section in default (all-provider) mode when the user has not
 * supplied an API key, rather than printing an error.
 */
export type OcQueryResult =
  | {
      kind: "success";
      /** Present windows only — the account's plan decides which exist.
       *  Fractions in [0, 1]. Legacy plans expose session+weekly; current
       *  credit plans expose monthly (with per-model request counts). */
      session?: number;
      weekly?: number;
      monthly?: number;
      /** Derived reset moments (epoch ms). session/weekly are computed from
       *  the window anchoring (epoch-aligned 5h buckets; Monday 00:00 UTC
       *  weeks) — the API itself returns no timestamps. monthly comes from
       *  POST /api/me's SubscriptionPeriodEnd when that lookup succeeds;
       *  absent otherwise. */
      sessionResetAt?: number;
      weeklyResetAt?: number;
      monthlyResetAt?: number;
      /** Epoch ms of the fetch (kept for symmetry with the other providers). */
      fetchedAt: number;
    }
  | { kind: "not_configured" }
  | { kind: "auth_error" }
  | { kind: "unavailable" };

/** Raw /api/usage fetch result — status + body text. */
export interface OcUsageResponse {
  status: number;
  text: string;
}
