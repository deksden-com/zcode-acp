/** Native facts only. session/read/messages require residents; the retained
 * message store provides exact child+completion+turn evidence without resume. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { zcodeHomeDir, zcodeUsageDbPath } from "../utils.js";

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
  startedAt: number,
  endedAt: number,
  turnId?: string,
  dbPath = zcodeUsageDbPath(),
  proofContract?: string,
): RecordValue {
  const unavailable = { sessionId, available: false };
  let db: InstanceType<typeof import("node:sqlite").DatabaseSync> | undefined;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("BEGIN");
    // Native topology settles after the message commit. Bound the latest completed
    // assistant to that exact child lifetime; never choose a nearest timestamp.
    // ponytail: cap native error JSON at 16 KiB; oversized records stay unassessable.
    // Use SQL field projection if native errors routinely exceed this ceiling.
    const rows = db
      .prepare(
        `SELECT
      json_extract(data, '$.anchor.turnId') AS turn_id,
      json_extract(data, '$.time.completed') AS completed_at,
      substr(json_extract(data, '$.error'), 1, 16384) AS error
      FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
      AND json_extract(data, '$.time.completed') BETWEEN ? AND ?
      ORDER BY json_extract(data, '$.time.completed') DESC LIMIT 2`,
      )
      .all(sessionId, startedAt, endedAt);
    if (!rows.length || (rows.length === 2 && rows[0].completed_at === rows[1].completed_at))
      return unavailable;
    const row = rows[0];
    if (
      typeof row.turn_id !== "string" ||
      !row.turn_id.trim() ||
      (turnId !== undefined && row.turn_id !== turnId)
    )
      return unavailable;
    if (typeof row.error !== "string" && proofContract !== "zcode/retained-child-effects@1")
      return unavailable;
    return {
      sessionId,
      available: true,
      startedAt,
      endedAt,
      terminal_turn_id: row.turn_id,
      terminal_observed_at: new Date(row.completed_at as number).toISOString(),
      ...(typeof row.error === "string"
        ? { provider_error: safeError(JSON.parse(row.error)) }
        : {}),
      ...(proofContract === "zcode/retained-child-effects@1"
        ? { effects_proof: retainedEffects(db, sessionId, startedAt, endedAt, row.turn_id) }
        : {}),
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

/** Inspect the full bounded native Turn, never just its last assistant message. */
function retainedEffects(
  db: InstanceType<typeof import("node:sqlite").DatabaseSync>,
  sessionId: string,
  startedAt: number,
  endedAt: number,
  turnId: string,
): RecordValue {
  const base = {
    schema_id: "zcode/retained-child-effects@1",
    session_id: sessionId,
    started_at: startedAt,
    ended_at: endedAt,
    terminal_turn_id: turnId,
  };
  const unknown = (reason: string) => ({
    ...base,
    settled: false,
    reason,
    native_turn_items: { observed: false, possible_effects: true, pending: true },
  });
  try {
    // Do not fetch unbounded tool output into memory. Record ceilings are checked
    // before reading rows, and include user/system sequence positions.
    const size = db
      .prepare(
        `SELECT count(*) AS count, coalesce(sum(length(data)),0) AS bytes FROM message WHERE session_id=?`,
      )
      .get(sessionId)!;
    const partsSize = db
      .prepare(
        `SELECT count(*) AS count, coalesce(sum(length(data)),0) AS bytes FROM part WHERE session_id=?`,
      )
      .get(sessionId)!;
    if (
      Number(size.count) + Number(partsSize.count) > 4096 ||
      Number(size.bytes) + Number(partsSize.bytes) > 16 * 1024 * 1024
    )
      return unknown("proof_budget_exceeded");
    const messages = db
      .prepare(`SELECT id, sequence, data FROM message WHERE session_id=? ORDER BY sequence`)
      .all(sessionId);
    const parsed = messages.map((row) => ({
      id: String(row.id),
      sequence: Number(row.sequence),
      data: record(JSON.parse(String(row.data))),
    }));
    if (
      new Set(parsed.map((row) => row.id)).size !== parsed.length ||
      new Set(parsed.map((row) => row.sequence)).size !== parsed.length
    )
      return unknown("message_conflict");
    const owned = parsed.filter((row) => record(row.data.anchor).turnId === turnId);
    if (!owned.length) return unknown("turn_missing");
    const last = owned.at(-1)!;
    const newer = parsed.filter((row) => row.sequence > last.sequence);
    if (newer.length) return unknown("successor_turn_present");
    const assistants = owned.filter((row) => row.data.role === "assistant");
    if (
      !assistants.length ||
      last.data.role !== "assistant" ||
      assistants.some((row) => {
        const time = record(row.data.time);
        return (
          typeof time.completed !== "number" ||
          time.completed < startedAt ||
          time.completed > endedAt
        );
      })
    )
      return unknown("incomplete_turn");
    const ids = new Set(owned.map((row) => row.id));
    const parts = db
      .prepare(`SELECT id,message_id,data FROM part WHERE session_id=? ORDER BY sequence`)
      .all(sessionId)
      .filter((row) => ids.has(String(row.message_id)))
      .map((row) => ({ id: String(row.id), data: record(JSON.parse(String(row.data))) }));
    const calls = new Set<string>();
    let pending = false,
      possible = false,
      unsafe = false;
    const inventory = parts
      .filter((row) => row.data.type === "tool")
      .map(({ id, data }) => {
        const state = record(data.state),
          metadata = { ...record(data.metadata), ...record(state.metadata) };
        const call = String(data.callID ?? ""),
          tool = String(data.tool ?? "");
        if (!call || calls.has(call)) unsafe = true;
        calls.add(call);
        if (!["completed", "error"].includes(String(state.status))) pending = true;
        // Native completion of synchronous file tools settles their invocation.
        // Shell/Agent/unknown tools can own services after return: never infer
        // their settlement merely from a completed part or from stdout prose.
        if (
          ![
            "Read",
            "Glob",
            "Grep",
            "Write",
            "Edit",
            "MultiEdit",
            "read",
            "glob",
            "grep",
            "write",
            "edit",
          ].includes(tool)
        )
          unsafe = true;
        if (
          Object.keys(metadata).some((key) =>
            /background|taskId|terminalId|childSessionId|pid/i.test(key),
          )
        )
          unsafe = true;
        possible ||= !["Read", "Glob", "Grep", "read", "glob", "grep"].includes(tool);
        return { id, call_id: call, tool, status: state.status };
      });
    const projection = {
      messages: owned.map((row) => ({ id: row.id, sequence: row.sequence })),
      tools: inventory,
    };
    return {
      ...base,
      settled: !pending && !unsafe,
      ...(unsafe
        ? { reason: "background_effects_unproven" }
        : pending
          ? { reason: "pending_tools" }
          : {}),
      native_turn_items: { observed: true, possible_effects: possible, pending: pending || unsafe },
      message_watermark: last.sequence,
      message_count: owned.length,
      tool_count: inventory.length,
      sha256: createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
    };
  } catch {
    return unknown("storage_schema_unavailable");
  }
}

/** Durable launch/admission facts. No child load, prompt text, or tool output escapes. */
export function readRetainedChildBinding(
  sessionId: string,
  parentSessionId: string,
  agentId: string,
  parentToolCallId: string,
  dbPath = zcodeUsageDbPath(),
): RecordValue {
  let db: InstanceType<typeof import("node:sqlite").DatabaseSync> | undefined;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("BEGIN");
    const child = db.prepare("SELECT parent_id,task_type FROM session WHERE id=?").get(sessionId);
    if (child?.parent_id !== parentSessionId || child.task_type !== "subagent_child")
      return { available: false, reason: "child_parent_unproven" };
    const budget = db
      .prepare(
        "SELECT count(*) AS count, coalesce(sum(length(data)),0) AS bytes FROM part WHERE session_id=?",
      )
      .get(parentSessionId)!;
    if (Number(budget.count) > 4096 || Number(budget.bytes) > 16 * 1024 * 1024)
      return { available: false, reason: "proof_budget_exceeded" };
    const rows = db
      .prepare(
        `SELECT p.id,p.data,m.sequence,json_extract(m.data,'$.anchor.turnId') AS turn_id
      FROM part p JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
      WHERE p.session_id=? AND json_extract(p.data,'$.type')='tool' ORDER BY m.sequence,p.sequence`,
      )
      .all(parentSessionId);
    const parts = rows.map((row) => ({
      turn_id: row.turn_id,
      value: record(JSON.parse(String(row.data))),
    }));
    const original = parts.filter((row) => row.value.callID === parentToolCallId);
    if (original.length !== 1) return { available: false, reason: "parent_tool_binding_unproven" };
    const metadata = readChildMetadata(parentSessionId, agentId, sessionId);
    const latest = db
      .prepare(
        "SELECT json_extract(data,'$.anchor.turnId') AS turn_id,json_extract(data,'$.time.created') AS created_at,json_extract(data,'$.role') AS role,json_extract(data,'$.time.completed') AS completed_at FROM message WHERE session_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(sessionId);
    let admission: RecordValue | undefined;
    const admissionTurns = new Set<string>();
    for (const row of parts) {
      const part = row.value,
        state = record(part.state),
        input = record(state.input);
      if (part.tool !== "SendMessage" || input.to !== agentId) continue;
      admission = undefined;
      if (typeof row.turn_id !== "string" || admissionTurns.has(row.turn_id))
        return { available: false, reason: "ambiguous_send_message_admission" };
      admissionTurns.add(row.turn_id);
      if (state.status !== "completed") continue;
      const display = record(record(state.metadata).display),
        start = record(state.time).start;
      if (
        display.kind === "local_agent_message" &&
        display.status === "success" &&
        typeof part.callID === "string" &&
        metadata.metadata_parent_tool_call_id === part.callID &&
        Number.isSafeInteger(metadata.metadata_started_at) &&
        typeof start === "number" &&
        Number(metadata.metadata_started_at) >= start &&
        typeof record(state.time).end === "number" &&
        Number(metadata.metadata_started_at) <= Number(record(state.time).end)
      ) {
        const successor =
          typeof latest?.turn_id === "string" &&
          typeof latest.created_at === "number" &&
          latest.created_at >= Number(metadata.metadata_started_at);
        if (!successor && metadata.metadata_status !== "running") continue;
        admission = {
          schema_id: "zcode/child-admission@1",
          proof_kind: successor ? "parent_tool_successor" : "parent_tool_admission",
          child_session_id: sessionId,
          parent_session_id: parentSessionId,
          agent_id: agentId,
          parent_tool_call_id: part.callID,
          parent_turn_id: row.turn_id,
          successor_started_at: metadata.metadata_started_at,
          ...(successor ? { successor_turn_id: latest!.turn_id } : {}),
          native_evidence_sha256: createHash("sha256")
            .update(JSON.stringify({ part, metadata, turn_id: successor ? latest!.turn_id : null }))
            .digest("hex"),
        };
        continue;
      }
      let output: RecordValue;
      try {
        output = record(typeof state.output === "string" ? JSON.parse(state.output) : state.output);
      } catch {
        continue;
      }
      if (
        output.status !== "success" ||
        output.agentId !== agentId ||
        typeof output.messageId !== "string" ||
        !output.messageId ||
        !["queued", "steered", "resumed_background"].includes(String(output.delivery)) ||
        typeof row.turn_id !== "string" ||
        typeof part.callID !== "string"
      )
        continue;
      admission = {
        schema_id: "zcode/child-admission@1",
        child_session_id: sessionId,
        parent_session_id: parentSessionId,
        agent_id: agentId,
        parent_tool_call_id: part.callID,
        parent_turn_id: row.turn_id,
        message_id: output.messageId,
        delivery: output.delivery,
      };
    }
    return {
      available: true,
      ...(admission ? { continuation_admission: admission } : {}),
      ...metadata,
      ...(typeof latest?.turn_id === "string" ? { current_turn_id: latest.turn_id } : {}),
      ...(typeof latest?.turn_id === "string" &&
      latest.role === "assistant" &&
      typeof latest.completed_at === "number"
        ? {
            latest_terminal_turn_id: latest.turn_id,
            latest_terminal_completed_at: latest.completed_at,
          }
        : {}),
    };
  } catch {
    return { available: false, reason: "storage_schema_unavailable" };
  } finally {
    try {
      db?.close();
    } catch {
      /* No promotion of failed evidence. */
    }
  }
}

function readChildMetadata(
  parentSessionId: string,
  agentId: string,
  sessionId: string,
): RecordValue {
  if (![parentSessionId, agentId].every((id) => /^[\w-]+$/.test(id))) return {};
  let fd: number | undefined;
  try {
    const file = path.join(
      zcodeHomeDir(),
      "cli",
      "agents",
      parentSessionId,
      agentId,
      "metadata.json",
    );
    const canonical = realpathSync(file),
      root = realpathSync(path.join(zcodeHomeDir(), "cli", "agents"));
    if (
      path.relative(root, canonical) !== `${parentSessionId}/${agentId}/metadata.json` ||
      lstatSync(file).isSymbolicLink()
    )
      return {};
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 65536) return {};
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) return {};
      offset += count;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return {};
    const data = record(JSON.parse(bytes.toString("utf8")));
    if (
      data.agentId !== agentId ||
      data.childSessionId !== sessionId ||
      data.parentSessionId !== parentSessionId
    )
      return {};
    return {
      ...(typeof data.resumedFromMessageId === "string"
        ? { resumed_from_message_id: data.resumedFromMessageId }
        : {}),
      ...(typeof data.createdAt === "string"
        ? { metadata_started_at: Date.parse(data.createdAt) }
        : {}),
      ...(typeof data.parentToolUseId === "string"
        ? { metadata_parent_tool_call_id: data.parentToolUseId }
        : {}),
      metadata_sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(["running", "completed", "failed", "stopped"].includes(String(data.status))
        ? { metadata_status: data.status }
        : {}),
    };
  } catch {
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
