/** Strict per-alias write-ahead intent. Unknown outcomes are never replayed. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { zcodeHomeDir } from "./utils.js";

interface Allocation {
  owner: string;
  cwd: string;
  sessionId?: string;
}
function allocationPath(alias: string): string {
  return path.join(
    zcodeHomeDir(),
    "v2",
    "acp-allocations",
    `${createHash("sha256").update(alias).digest("hex")}.json`,
  );
}
export function allocationUnknown(alias: string): RequestError {
  return new RequestError(
    -32603,
    "Session allocation outcome is unknown; automatic create is forbidden",
    {
      code: "native_outcome_unknown",
      adapter_session_id: alias,
    },
  );
}
export function readAllocation(alias: string): Allocation | undefined {
  try {
    const value = JSON.parse(readFileSync(allocationPath(alias), "utf8"));
    if (
      !value ||
      typeof value.owner !== "string" ||
      typeof value.cwd !== "string" ||
      (value.sessionId !== undefined && (typeof value.sessionId !== "string" || !value.sessionId))
    )
      throw allocationUnknown(alias);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw allocationUnknown(alias);
  }
}
export function beginAllocation(alias: string, cwd: string): string {
  const file = allocationPath(alias);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const owner = randomUUID();
  try {
    writeFileSync(file, JSON.stringify({ owner, cwd }), { flag: "wx", mode: 0o600, flush: true });
  } catch {
    throw allocationUnknown(alias);
  }
  return owner;
}
export function finishAllocation(alias: string, owner: string, sessionId?: string): void {
  const current = readAllocation(alias);
  if (!current || current.owner !== owner) throw allocationUnknown(alias);
  const file = allocationPath(alias);
  if (sessionId === undefined) {
    unlinkSync(file);
    return;
  }
  const temp = `${file}.${owner}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...current, sessionId }), {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  renameSync(temp, file);
}
