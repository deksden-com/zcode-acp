/**
 * Type definitions for the Opencode Go subscription usage feature.
 *
 * `zcode-acp quota` queries the console status API
 * (`https://opencode.ai/console/api/go/status`, JSON — since the 2026-09
 * console migration replaced the scraped `/workspace/<id>/go` SSR page).
 * Usage is split into three windows: rolling (5h), weekly (7d), monthly
 * (30d). The API serves micro-cents meter pairs; the parser computes each
 * window's `usagePercent` and relative `resetInSec` countdown.
 */

/** One usage window — both fields are server-provided. */
export interface GoWindow {
  /** Used percentage in [0, 100], already computed server-side. */
  usagePercent: number;
  /** Seconds until this window resets (relative countdown, not a timestamp). */
  resetInSec: number;
}

/**
 * Result of querying Opencode Go usage — a 4-state sum type.
 *
 * `not_configured` is distinct from `unavailable`: the CLI uses it to silently
 * skip the Go section in default (dual-platform) mode when the user has not
 * supplied credentials, rather than printing an error.
 */
export type GoQueryResult =
  | {
      kind: "success";
      rolling: GoWindow;
      weekly: GoWindow;
      /** Monthly window is optional — present when the dashboard exposes it. */
      monthly: GoWindow | null;
      /** Epoch ms of the fetch, used to drive the live countdown in the CLI. */
      fetchedAt: number;
    }
  | { kind: "not_configured" }
  | { kind: "auth_error" }
  | { kind: "unavailable" };

/** The three window keys, in display order. */
export type GoWindowKey = "rolling" | "weekly" | "monthly";

/** Raw status fetch result — the API body (JSON text) + HTTP status. */
export interface GoStatusResponse {
  status: number;
  text: string;
}
