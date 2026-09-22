/** Downstream native-evidence transport. Consumer policy belongs in dd-zcode. */
import { backendError } from "../backend/errors.js";
import type { ZcodeResponse } from "../backend/types.js";
import type { ZcodeAcpServer } from "../server.js";
import { log } from "../utils.js";
import { ensureRealSession } from "./session.js";

interface ExtensionParams {
  sessionId: string;
  [key: string]: unknown;
}
type Result = Record<string, unknown>;
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
  const { sessionId: _adapterSessionId, ...options } = params;
  const resp = await server
    .ensureBackend()
    .request(server.nextId(), method, { ...options, sessionId: zcodeSid }, 15000);
  if (resp.error) nativeFailure(method, zcodeSid, resp);
  return (resp.result ?? {}) as Result;
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
  const response = await server
    .ensureBackend()
    .request(server.nextId(), "session/subagents", { sessionId: nativeId }, 15000);
  if (response.error) nativeFailure("session/subagents", nativeId, response);
  return { sessionId: nativeId, topology: response.result ?? null };
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
  const response = await server
    .ensureBackend()
    .request(server.nextId(), "session/close", { sessionId: zcodeSid }, 15000);
  if (response.error) nativeFailure("session/close", zcodeSid, response);
  if ((response.result as Result | undefined)?.closed === true) {
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
  const response = await server
    .ensureBackend()
    .request(server.nextId(), "session/read", { sessionId: nativeId }, 15000);
  if (response.error?.code === -32004) return { sessionId: nativeId, resident: false };
  if (response.error) nativeFailure("session/read", nativeId, response);
  return {
    sessionId: nativeId,
    resident: true,
    projection: (response.result as Result | undefined)?.projection ?? null,
  };
}
