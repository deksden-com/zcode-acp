/** Downstream native-evidence transport. Consumer policy belongs in dd-zcode. */
import path from "node:path";

import { backendError } from "../backend/errors.js";
import { readRetainedChildBinding, readRetainedTerminal } from "../backend/retained-terminal.js";
import type { ZcodeResponse } from "../backend/types.js";
import type { ZcodeAcpServer } from "../server.js";
import { log } from "../utils.js";
import { ensureRealSession } from "./session.js";

interface ExtensionParams {
  sessionId: string;
  [key: string]: unknown;
}
type Result = Record<string, unknown>;
const record = (value: unknown): Result =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Result) : {};
const EFFECTS = "zcode/retained-child-effects@1";
function enrichedChild(value: unknown, parentSessionId: string, storageHome?: string): Result {
  const item = record(value);
  if (
    typeof item.childSessionId !== "string" ||
    typeof item.agentId !== "string" ||
    typeof item.toolCallId !== "string"
  )
    return item;
  if (!storageHome)
    return { ...item, available: false, reason: "native_storage_binding_unavailable" };
  const binding = readRetainedChildBinding(
    item.childSessionId,
    parentSessionId,
    item.agentId,
    item.toolCallId,
    path.join(storageHome, "cli", "db", "db.sqlite"),
    storageHome,
  );
  const successor = record(binding.continuation_admission);
  const admitted = ["parent_tool_successor", "parent_tool_admission"].includes(
    String(successor.proof_kind),
  );
  const startedAt = admitted ? successor.successor_started_at : item.startedAt;
  const terminal =
    ["success", "failed", "cancelled"].includes(String(item.status)) &&
    typeof binding.latest_terminal_turn_id === "string" &&
    typeof binding.latest_terminal_completed_at === "number" &&
    typeof startedAt === "number" &&
    typeof item.endedAt === "number" &&
    binding.latest_terminal_completed_at >= startedAt &&
    binding.latest_terminal_completed_at <= item.endedAt;
  return {
    ...item,
    ...binding,
    ...(terminal ? { terminal_turn_id: binding.latest_terminal_turn_id } : {}),
    ...(admitted
      ? {
          startedAt: successor.successor_started_at,
          toolCallId: successor.parent_tool_call_id,
          native_lifetime_source: "retained_child_metadata",
          native_lifetime_sha256: binding.metadata_sha256,
        }
      : {}),
  };
}
const resolveSidOrThrow = (server: ZcodeAcpServer, params: ExtensionParams) =>
  ensureRealSession(server, params.sessionId);

function nativeFailure(method: string, sessionId: string, response: ZcodeResponse): never {
  throw backendError(method, response, sessionId);
}

/** Resolve a lazy ACP locator to the native ZCode Session identity. */
export async function resolveSession(
  server: ZcodeAcpServer,
  params: ExtensionParams,
  onAllocated?: (sid: string) => void | Promise<void>,
): Promise<Result> {
  const providerSessionId = await ensureRealSession(server, params.sessionId, { onAllocated });
  return { adapterSessionId: params.sessionId, providerSessionId };
}

async function inspectSession(
  server: ZcodeAcpServer,
  params: ExtensionParams,
  method: "session/read" | "session/subagents" | "session/usage" | "session/events",
): Promise<Result> {
  const zcodeSid = await resolveSidOrThrow(server, params);
  const {
    sessionId: _adapterSessionId,
    proofContract: _proofContract,
    parentSessionId: _parentSessionId,
    ...options
  } = params;
  const backend = await server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    method,
    { ...options, sessionId: zcodeSid },
    15000,
  );
  if (resp.error) nativeFailure(method, zcodeSid, resp);
  const result = (resp.result ?? {}) as Result;
  return method === "session/subagents" && params.proofContract === EFFECTS
    ? enrichedTopology(result, zcodeSid, backend.storageHome)
    : result;
}

function enrichedTopology(topology: Result, parentSessionId: string, storageHome?: string): Result {
  const enrich = (value: unknown) => enrichedChild(value, parentSessionId, storageHome);
  return {
    ...topology,
    running: Array.isArray(topology.running) ? topology.running.map(enrich) : topology.running,
    ended: {
      ...record(topology.ended),
      items: Array.isArray(record(topology.ended).items)
        ? (record(topology.ended).items as unknown[]).map(enrich)
        : record(topology.ended).items,
    },
  };
}

export const readSession = (server: ZcodeAcpServer, params: ExtensionParams) =>
  inspectSession(server, params, "session/read");
export const subagents = (server: ZcodeAcpServer, params: ExtensionParams) =>
  inspectSession(server, params, "session/subagents");

/** Durable topology only: unlike ordinary inspection this must never load or
 * resume a closed resident. Kept a distinct method so older bridges fail closed. */
export async function retainedSubagents(
  server: ZcodeAcpServer,
  params: ExtensionParams,
): Promise<Result> {
  const nativeId = server.resolveSid(params.sessionId) ?? params.sessionId;
  if (!nativeId.startsWith("sess_"))
    throw new Error("Retained topology requires a native Session identity");
  const backend = await server.ensureBackend();
  const response = await backend.request(
    server.nextId(),
    "session/subagents",
    {
      sessionId: nativeId,
      ...(params.endedCursor !== undefined ? { endedCursor: params.endedCursor } : {}),
    },
    15000,
  );
  if (response.error) nativeFailure("session/subagents", nativeId, response);
  const topology = record(response.result);
  if (params.proofContract === EFFECTS) {
    return {
      sessionId: nativeId,
      topology: enrichedTopology(topology, nativeId, backend.storageHome),
    };
  }
  return { sessionId: nativeId, topology: response.result ?? null };
}

/** Exact retained terminal metadata; never materialize a closed child. */
export async function retainedTerminal(
  server: ZcodeAcpServer,
  params: ExtensionParams,
): Promise<Result> {
  const nativeId = server.resolveSid(params.sessionId) ?? params.sessionId;
  if (!nativeId.startsWith("sess_"))
    throw new Error("Terminal inspection requires a native Session identity");
  if (
    !Number.isSafeInteger(params.endedAt) ||
    (params.endedAt as number) <= 0 ||
    (params.endedAt as number) > 8.64e15
  )
    throw new Error("Terminal inspection requires an exact endedAt timestamp");
  if (
    !Number.isSafeInteger(params.startedAt) ||
    (params.startedAt as number) <= 0 ||
    (params.startedAt as number) > (params.endedAt as number)
  )
    throw new Error("Terminal inspection requires an exact child lifetime startedAt");
  if (params.turnId !== undefined && (typeof params.turnId !== "string" || !params.turnId.trim()))
    throw new Error("Terminal inspection turnId must be nonempty");
  if (params.proofContract !== undefined && params.proofContract !== EFFECTS)
    throw new Error("Unsupported retained effects contract");
  // A retained read must never select a different account from process.env,
  // or spawn/resume a native process merely to discover its storage root.
  const storageHome = server.backend?.storageHome;
  if (!storageHome)
    return { sessionId: nativeId, available: false, reason: "native_storage_binding_unavailable" };
  const dbPath = path.join(storageHome, "cli", "db", "db.sqlite");
  if (params.proofContract === EFFECTS) {
    const parent = params.parentSessionId;
    if (typeof parent !== "string" || !parent.startsWith("sess_") || parent === nativeId)
      throw new Error("Effects inspection requires exact native parentSessionId");
    const before = await boundedTopology(server, parent);
    const entry = before.items.filter((item) => item.childSessionId === nativeId);
    const node = entry[0];
    if (
      entry.length !== 1 ||
      !node ||
      typeof node.agentId !== "string" ||
      typeof node.toolCallId !== "string" ||
      node.startedAt !== params.startedAt ||
      node.endedAt !== params.endedAt ||
      !["failed", "success", "cancelled"].includes(String(node.status))
    )
      return { sessionId: nativeId, available: false, reason: "child_lifetime_unproven" };
    const childBefore = await boundedTopology(server, nativeId);
    const binding = readRetainedChildBinding(
      nativeId,
      parent,
      node.agentId,
      node.toolCallId,
      dbPath,
      storageHome,
    );
    const terminal = readRetainedTerminal(
      nativeId,
      params.startedAt as number,
      params.endedAt as number,
      params.turnId as string | undefined,
      dbPath,
      EFFECTS,
    );
    const after = await boundedTopology(server, parent);
    const childAfter = await boundedTopology(server, nativeId);
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(childBefore) !== JSON.stringify(childAfter)
    )
      return { sessionId: nativeId, available: false, reason: "topology_changed" };
    if (binding.available !== true || terminal.available !== true)
      return {
        ...terminal,
        effects_proof: {
          schema_id: EFFECTS,
          settled: false,
          reason: binding.reason ?? "terminal_unavailable",
        },
      };
    if (childAfter.items.length)
      return {
        ...terminal,
        effects_proof: {
          ...record(terminal.effects_proof),
          settled: false,
          reason: "descendant_effects_unproven",
          native_turn_items: { observed: true, possible_effects: true, pending: true },
        },
      };
    const backend = await server.ensureBackend();
    if (server.nativeChildRegistryParents?.get(parent) !== backend || backend.isDead)
      return {
        ...terminal,
        ...binding,
        continuation_unavailable_reason: "native_registry_generation_unproven",
      };
    const resident = await backend.request(
      server.nextId(),
      "session/read",
      { sessionId: parent },
      15000,
    );
    if (resident.error || !record(resident.result).projection) {
      server.nativeChildRegistryParents.delete(parent);
      return {
        ...terminal,
        ...binding,
        continuation_unavailable_reason: "native_registry_residency_unproven",
      };
    }
    return {
      ...terminal,
      ...binding,
      continuation_ref: {
        schema_id: "zcode/child-continuation@1",
        capability: "dd-flow/managed-provider-recovery@1",
        agent_id: node.agentId,
        child_session_id: nativeId,
        parent_session_id: parent,
        parent_tool_call_id: node.toolCallId,
        started_at: params.startedAt,
        ended_at: params.endedAt,
        terminal_turn_id: terminal.terminal_turn_id,
      },
    };
  }
  return readRetainedTerminal(
    nativeId,
    params.startedAt as number,
    params.endedAt as number,
    params.turnId as string | undefined,
    dbPath,
  );
}

async function boundedTopology(
  server: ZcodeAcpServer,
  sessionId: string,
): Promise<{ revision: unknown; items: Result[] }> {
  const backend = await server.ensureBackend();
  const items: Result[] = [],
    cursors = new Set<string>();
  let cursor: string | undefined, revision: unknown;
  do {
    const response = await backend.request(
      server.nextId(),
      "session/subagents",
      { sessionId, endedLimit: 100, ...(cursor ? { endedCursor: cursor } : {}) },
      15000,
    );
    if (response.error) nativeFailure("session/subagents", sessionId, response);
    const data = record(response.result),
      ended = record(data.ended);
    if (
      !Array.isArray(data.running) ||
      !Array.isArray(ended.items) ||
      !Number.isSafeInteger(data.revision) ||
      !Number.isSafeInteger(ended.total)
    )
      throw new Error("Incomplete retained topology");
    if (revision !== undefined && revision !== data.revision)
      throw new Error("Retained topology changed during pagination");
    revision = data.revision;
    if (!cursor)
      items.push(
        ...data.running.map((value) => enrichedChild(value, sessionId, backend.storageHome)),
      );
    items.push(...ended.items.map((value) => enrichedChild(value, sessionId, backend.storageHome)));
    if (items.length > 4096) throw new Error("Retained topology exceeds proof budget");
    cursor = typeof ended.nextCursor === "string" ? ended.nextCursor : undefined;
    if (cursor && cursors.has(cursor)) throw new Error("Retained topology cursor cycle");
    if (cursor) cursors.add(cursor);
    if (!cursor && items.length - data.running.length !== ended.total)
      throw new Error("Incomplete retained ended topology");
  } while (cursor);
  return { revision, items };
}
export const usage = (server: ZcodeAcpServer, params: ExtensionParams) =>
  inspectSession(server, params, "session/usage");
export const events = (server: ZcodeAcpServer, params: ExtensionParams) =>
  inspectSession(server, params, "session/events");

/** Close the resident native session after a bounded cooperative stop failed.
 * This is deliberately a narrow dd-flow extension, not a generic backend
 * passthrough: callers can only close the Session they already own. */
export async function closeSession(
  server: ZcodeAcpServer,
  params: ExtensionParams,
): Promise<Result> {
  const zcodeSid = server.resolveSid(params.sessionId);
  if (!zcodeSid) throw new Error("session/close requires an already resolved Session");
  const turns = [...server.pendingTurns.values()].filter((turn) => turn.zcodeSid === zcodeSid);
  const response = await (
    await server.ensureBackend()
  ).request(server.nextId(), "session/close", { sessionId: zcodeSid }, 15000);
  if (response.error) nativeFailure("session/close", zcodeSid, response);
  if ((response.result as Result | undefined)?.closed === true) {
    server.nativeChildRegistryParents?.delete(zcodeSid);
    for (const [alias, nativeId] of server.sessionMap) {
      if (nativeId === zcodeSid) server.backendLoadedSessions.delete(alias);
    }
    for (const turn of turns) {
      turn.closed = true;
      turn.cancelled = true;
    }
  }
  log(`session/close → ${zcodeSid}`);
  return {
    ...((response.result ?? {}) as Result),
    closed: (response.result as Result | undefined)?.closed === true,
  };
}

/** Read residency after close without ensureRealSession's implicit resume. */
export async function residentSession(
  server: ZcodeAcpServer,
  params: ExtensionParams,
): Promise<Result> {
  const nativeId = server.resolveSid(params.sessionId) ?? params.sessionId;
  if (!nativeId.startsWith("sess_"))
    throw new Error("Residency inspection requires a native Session identity");
  const response = await (
    await server.ensureBackend()
  ).request(server.nextId(), "session/read", { sessionId: nativeId }, 15000);
  if (response.error?.code === -32004) return { sessionId: nativeId, resident: false };
  if (response.error) nativeFailure("session/read", nativeId, response);
  return {
    sessionId: nativeId,
    resident: true,
    projection: (response.result as Result | undefined)?.projection ?? null,
  };
}
