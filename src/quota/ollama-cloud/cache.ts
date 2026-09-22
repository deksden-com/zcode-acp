/**
 * In-memory TTL cache for Ollama Cloud results.
 *
 * Mirrors {@link ../../cache.ts} but typed for {@link OcQueryResult}. Same
 * 10s TTL — matches the quota cache and the CLI's minimum watch interval.
 */

import type { OcQueryResult } from "./types.js";

/** How long a cached result is served before re-querying. */
const TTL_MS = 10_000;

let slot: { result: OcQueryResult; at: number } | null = null;

/** Inject a fake clock — only tests should need this. */
let now: () => number = () => Date.now();

/** Return the cached result if still fresh, else `null`. */
export function getCached(): OcQueryResult | null {
  if (slot && now() - slot.at < TTL_MS) return slot.result;
  return null;
}

/** Store a fresh result, stamping it with the current time. */
export function setCached(result: OcQueryResult): void {
  slot = { result, at: now() };
}

/** Clear the cache (test helper, and used by CLI watch mode per tick). */
export function clearCache(): void {
  slot = null;
}

/** Override the clock (test-only). Pass `undefined` to restore real time. */
export function setClock(fn?: () => number): void {
  now = fn ?? (() => Date.now());
}
