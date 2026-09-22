import { RequestError } from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { backendError } from "../src/backend/errors.js";

it.each(["native_timeout", "native_backend_dead", "native_backend_pipe_broken", "native_outcome_unknown"])(
  "preserves %s at the SDK JSON-RPC boundary", (code) => {
    const error = backendError("session/create", null, 30000, { id: 42, error: { code, message: "failed" } });
    expect(error).toBeInstanceOf(RequestError);
    expect(JSON.parse(JSON.stringify(error.toResult()))).toMatchObject({
      error: { code: -32603, data: { code, method: "session/create", request_id: 42, timeout_ms: 30000 } },
    });
  },
);
