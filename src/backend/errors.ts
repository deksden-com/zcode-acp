import { RequestError } from "@agentclientprotocol/sdk";
import type { ZcodeResponse } from "./types.js";

export type BackendRequestError = RequestError & {
  nativeCode: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

/** Keep native transport details intact when an ACP handler crosses the bridge. */
export function backendError(
  method: string,
  sessionId: string | null | undefined,
  timeoutMs: number,
  response: Pick<ZcodeResponse, "id" | "error">,
): BackendRequestError {
  const native = response.error;
  const message = native?.message ?? "backend request failed";
  const code = native?.code === "native_timeout"
    ? "native_timeout"
    : native?.code === "native_backend_dead"
      ? "native_backend_dead"
      : native?.code === "native_backend_pipe_broken"
        ? "native_backend_pipe_broken"
        : native?.code === "native_outcome_unknown" ? "native_outcome_unknown" : "native_request_failed";
  const details = {
    method,
    request_id: response.id,
    session_id: sessionId ?? null,
    timeout_ms: timeoutMs,
    ...(native?.code === undefined ? {} : { native_code: native.code }),
    ...(native?.detail === undefined ? {} : { native_error: native.detail }),
    ...(native?.data === undefined ? {} : { native_data: native.data }),
  };
  // The SDK drops custom fields on ordinary Error objects. RequestError.data
  // is the protocol boundary shared by every handler and transport.
  const error = new RequestError(-32603, `${method} failed: ${message}`, {
    code, ...details,
  }) as BackendRequestError;
  error.nativeCode = code;
  error.retryable = false;
  error.details = details;
  return error;
}
