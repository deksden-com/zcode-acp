import { RequestError } from "@agentclientprotocol/sdk";
import type { ZcodeResponse } from "./types.js";

const unknownCodes = new Set([
  "native_timeout",
  "native_backend_dead",
  "native_backend_pipe_broken",
  "native_outcome_unknown",
]);

export function isUnknownBackendOutcome(error: unknown): boolean {
  const value = error as { code?: unknown; data?: { code?: unknown } } | null;
  return unknownCodes.has(String(value?.data?.code ?? value?.code));
}

/** Preserve the causal native envelope across the ACP error boundary. */
export function backendError(
  method: string,
  response: ZcodeResponse,
  sessionId?: string,
): RequestError {
  const error = response.error;
  return new RequestError(
    -32603,
    `${method} failed: ${error?.message ?? "native request failed"}`,
    {
      code: isUnknownBackendOutcome(error) ? error?.code : "native_request_failed",
      method,
      request_id: response.id,
      session_id: sessionId ?? null,
      native_code: error?.code ?? null,
      native_data: error?.data ?? error?.detail ?? null,
    },
  );
}
