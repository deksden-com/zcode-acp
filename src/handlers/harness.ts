/** Downstream native-evidence transport. Consumer policy belongs in dd-zcode. */
import { RequestError } from "@agentclientprotocol/sdk";
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

function nativeFailure(
  method: string,
  sessionId: string,
  response: { id?: unknown; error?: unknown },
): never {
  const error = response.error as { code?: unknown; message?: string; data?: unknown };
  throw new RequestError(-32603, `${method} failed: ${error.message ?? "native request failed"}`, {
    method,
    session_id: sessionId,
    request_id: response.id,
    native_code: error.code ?? null,
    native_data: error.data ?? null,
  });
}

/** Resolve a lazy ACP locator to the native ZCode Session identity. */
export async function resolveSession(
  server: ZcodeAcpServer,
  params: ExtensionParams,
): Promise<Result> {
  const providerSessionId = await resolveSidOrThrow(server, params);
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
  const response = await server
    .ensureBackend()
    .request(server.nextId(), "session/close", { sessionId: zcodeSid }, 15000);
  if (response.error) nativeFailure("session/close", zcodeSid, response);
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
