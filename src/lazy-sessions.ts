/**
 * Durable alias store for lazy `session/new` placeholders.
 *
 * `session/new` returns a placeholder id with no backend session behind it
 * (the real `session/create` is deferred to first use). The editor stores this
 * placeholder and may resume it later — including after a bridge restart, when
 * the in-memory `pendingSessions`/`sessionMap` are gone. Without a durable
 * record, `session/resume` then fails with "Session not found".
 *
 * This module keeps a tiny JSON file (`~/.zcode/v2/acp-lazy-sessions.json`,
 * next to tasks-index.sqlite) mapping acp_sid → { cwd, zcodeSid?, createdAt }:
 *   - `rememberLazySession` — written at session/new (no zcodeSid yet);
 *   - `recordMaterializedSession` — updated once the placeholder materializes;
 *   - `lookupLazySession` — lets resume/load/ensureRealSession recover a
 *     placeholder from a previous bridge lifetime.
 *
 * The legacy alias index is best-effort: failures are logged and swallowed
 * so a store problem never breaks session/new or first use. Records older than
 * 30 days are pruned on load — the real session stays reachable via
 * session/list after that, only the placeholder alias expires.
 * Allocation intents/identities use separate strict per-alias records. They
 * never expire automatically: absence of an outcome cannot authorize replay.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { log, warn } from "./utils.js";

/** Placeholder alias record persisted in the store. */
export interface LazySessionRecord {
  cwd: string;
  /** Backend session id once the placeholder materialized (absent = never used). */
  zcodeSid?: string;
  allocationPending?: boolean;
  createdAt: number;
}

/** Store file lives next to config.json / tasks-index.sqlite under ~/.zcode/v2/. */
const STORE_FILENAME = "acp-lazy-sessions.json";

/** Placeholder aliases expire after 30 days; the real session remains listable. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Resolved at call time so tests can stub HOME without re-importing. */
function storePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".zcode", "v2", STORE_FILENAME);
}

/** Read the store, pruning expired/corrupt records. Returns {} on any failure. */
function loadRecords(): Record<string, LazySessionRecord> {
  try {
    const p = storePath();
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, LazySessionRecord>;
    if (typeof raw !== "object" || raw === null) return {};
    const now = Date.now();
    let pruned = false;
    const out: Record<string, LazySessionRecord> = {};
    for (const [acpSid, rec] of Object.entries(raw)) {
      if (typeof rec?.createdAt !== "number" || now - rec.createdAt > TTL_MS) {
        pruned = true;
        continue;
      }
      out[acpSid] = rec;
    }
    if (pruned) writeRecords(out);
    return out;
  } catch (e) {
    warn(
      `lazy-sessions: store read failed ` +
        `(${e instanceof Error ? e.message : String(e)}) — placeholder aliases unavailable`,
    );
    return {};
  }
}

/** Overwrite the store file. Failures are logged, never thrown. */
function writeRecords(records: Record<string, LazySessionRecord>): void {
  try {
    const p = storePath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(records, null, 2));
  } catch (e) {
    log(`lazy-sessions: store write failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Record a new placeholder at session/new (no backend session yet). */
export function rememberLazySession(acpSid: string, cwd: string): void {
  const records = loadRecords();
  records[acpSid] = { cwd, createdAt: Date.now() };
  writeRecords(records);
}

/** Attach the backend session id once the placeholder materializes. */
export function recordMaterializedSession(acpSid: string, zcodeSid: string, cwd: string): void {
  const records = loadRecords();
  const existing = records[acpSid];
  if (existing?.zcodeSid === zcodeSid) return;
  records[acpSid] = {
    cwd: existing?.cwd ?? cwd,
    zcodeSid,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  writeRecords(records);
}

/** Look up a placeholder alias (undefined = unknown to this bridge and store). */
export function lookupLazySession(acpSid: string): LazySessionRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(allocationPath(acpSid), "utf8")) as LazySessionRecord;
    if (!record || typeof record.cwd !== "string" || typeof record.createdAt !== "number" ||
      !(record.allocationPending === true || (typeof record.zcodeSid === "string" && record.zcodeSid.length > 0))) {
      throw new Error(`Invalid retained allocation for ${acpSid}`);
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return loadRecords()[acpSid];
}

function allocationPath(acpSid: string): string {
  return path.join(path.dirname(storePath()), "acp-allocations", `${createHash("sha256").update(acpSid).digest("hex")}.json`);
}

/** Exclusive write-ahead allocation intent. A restart is not proof that a
 * previous create failed. Separate alias files avoid shared-store lost writes. */
export function beginSessionAllocation(acpSid: string, cwd: string): void {
  const file = allocationPath(acpSid);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ cwd, createdAt: Date.now(), allocationPending: true }), { flag: "wx", mode: 0o600 });
}

export function finishSessionAllocation(acpSid: string, cwd: string, zcodeSid?: string): void {
  const file = allocationPath(acpSid);
  if (!zcodeSid) { unlinkSync(file); return; } // Confirmed native rejection only.
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ cwd, zcodeSid, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
}
