/** Native facts only. session/read/messages require residents; the retained
 * message store provides exact child+completion+turn evidence without resume. */
import { createRequire } from "node:module";

import { zcodeUsageDbPath } from "../utils.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};

/** This is an allowlist, not raw error transport: headers/body/detail never leave storage. */
function safeError(value: unknown): RecordValue {
  const error = record(value);
  const data = record(error.data);
  const attribution = record(data.attribution);
  const safe: RecordValue = {};
  for (const key of [
    "source",
    "reason",
    "errorPhase",
    "exceptionKind",
    "providerId",
    "modelId",
    "providerKind",
    "transport",
  ])
    if (typeof attribution[key] === "string")
      safe[key] = (attribution[key] as string).slice(0, 200);
  if (typeof attribution.retryable === "boolean") safe.retryable = attribution.retryable;
  for (const key of ["statusCode", "retryAfterMs", "resetAt"])
    if (typeof attribution[key] === "number" && Number.isFinite(attribution[key]))
      safe[key] = attribution[key];
  return {
    ...(typeof error.name === "string" ? { type: error.name.slice(0, 200) } : {}),
    ...(typeof data.code === "string" ? { code: data.code.slice(0, 200) } : {}),
    ...(Object.keys(safe).length ? { attribution: safe } : {}),
  };
}

export function readRetainedTerminal(
  sessionId: string,
  endedAt: number,
  turnId?: string,
  dbPath = zcodeUsageDbPath(),
): RecordValue {
  const unavailable = { sessionId, available: false };
  let db: InstanceType<typeof import("node:sqlite").DatabaseSync> | undefined;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    // LIMIT 2 detects ambiguous identity rather than selecting an arbitrary last assistant.
    // ponytail: cap native error JSON at 16 KiB; oversized records stay unassessable.
    // Use SQL field projection if native errors routinely exceed this ceiling.
    const rows = db
      .prepare(
        `SELECT
      json_extract(data, '$.anchor.turnId') AS turn_id,
      substr(json_extract(data, '$.error'), 1, 16384) AS error
      FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
      AND json_extract(data, '$.time.completed') = ?
      AND json_type(data, '$.error') = 'object' LIMIT 2`,
      )
      .all(sessionId, endedAt);
    if (rows.length !== 1) return unavailable;
    const row = rows[0];
    if (
      typeof row.turn_id !== "string" ||
      !row.turn_id.trim() ||
      (turnId !== undefined && row.turn_id !== turnId)
    )
      return unavailable;
    if (typeof row.error !== "string") return unavailable;
    return {
      sessionId,
      available: true,
      terminal_turn_id: row.turn_id,
      terminal_observed_at: new Date(endedAt).toISOString(),
      provider_error: safeError(JSON.parse(row.error)),
    };
  } catch {
    // Missing/busy/incompatible storage is unassessable, never a successful outcome.
    return unavailable;
  } finally {
    try {
      db?.close();
    } catch {
      /* A failed close cannot turn unavailable evidence into success. */
    }
  }
}
