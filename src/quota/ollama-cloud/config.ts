/**
 * Ollama Cloud credential discovery.
 *
 * The API key comes from two sources, with the **config file taking
 * precedence** over the environment variable (the user-config convention —
 * the file is the authoritative home for stable preferences):
 *   1. `quota.ollamaApiKey` in `~/.config/zcode-acp/config.json`.
 *   2. `OLLAMA_API_KEY` env var — the name Ollama's own docs use for cloud
 *      authentication (`Authorization: Bearer $OLLAMA_API_KEY`), kept as a
 *      full fallback for setups without a config file and one-off overrides.
 *
 * Unlike Opencode Go (which reuses `~/.pi/agent/` for historical reasons),
 * the Ollama key is a plain static API key and belongs in our own config.
 *
 * A missing/blank key yields `not_configured` (the section is silently
 * skipped in `all` mode).
 */

import process from "node:process";

import { loadUserConfig } from "../../config/user-config.js";

/** Env var name — documented in the CLI help and README. */
export const ENV_API_KEY = "OLLAMA_API_KEY";

/**
 * Resolve the API key: config file first, env var as fallback. Blank strings
 * count as absent.
 */
export function loadApiKey(): string | null {
  const file = loadUserConfig().quota?.ollamaApiKey;
  const key = (file ?? process.env[ENV_API_KEY] ?? "").trim();
  return key.length > 0 ? key : null;
}
