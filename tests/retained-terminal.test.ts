import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readRetainedTerminal } from "../src/backend/retained-terminal.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

describe("retained terminal metadata", () => {
  it("projects CP225 unknown stream attribution for exact child/turn/time, not raw payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-terminal-"));
    const path = join(dir, "db.sqlite");
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TABLE message (session_id TEXT, data TEXT)");
      const message = {
        role: "assistant",
        anchor: { turnId: "turn_failed" },
        time: { completed: 1791839989041 },
        error: {
          name: "AiSdkModelAdapterError",
          data: {
            message: "Model request failed.",
            code: "model_request_failed",
            headers: { authorization: "secret" },
            body: "secret",
            attribution: {
              source: "provider",
              reason: "unknown",
              errorPhase: "stream",
              exceptionKind: "generic",
              providerId: "account:example",
              modelId: "GLM-5.3-Flash",
              providerKind: "anthropic",
              transport: "sse",
              retryable: false,
              headers: "secret",
            },
          },
        },
      };
      const insert = db.prepare("INSERT INTO message VALUES (?, ?)");
      insert.run("sess_child", JSON.stringify(message));
      const result = readRetainedTerminal("sess_child", 1791839989041, "turn_failed", path);
      expect(result).toMatchObject({
        available: true,
        sessionId: "sess_child",
        terminal_turn_id: "turn_failed",
        terminal_observed_at: "2026-10-12T21:19:49.041Z",
        provider_error: {
          code: "model_request_failed",
          attribution: { reason: "unknown", retryable: false, errorPhase: "stream" },
        },
      });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(
        readRetainedTerminal("sess_foreign", 1791839989041, "turn_failed", path).available,
      ).toBe(false);
      expect(readRetainedTerminal("sess_child", 1791839989041, "turn_other", path).available).toBe(
        false,
      );
      expect(readRetainedTerminal("sess_child", 1791839989042, undefined, path).available).toBe(
        false,
      );
      delete (message.error.data.attribution as { retryable?: boolean }).retryable;
      db.exec("DELETE FROM message");
      insert.run("sess_child", JSON.stringify(message));
      expect(
        JSON.stringify(readRetainedTerminal("sess_child", 1791839989041, undefined, path)),
      ).not.toContain("retryable");
      insert.run("sess_child", JSON.stringify(message));
      expect(readRetainedTerminal("sess_child", 1791839989041, undefined, path).available).toBe(
        false,
      );
      expect(
        readRetainedTerminal("sess_child", 1, undefined, join(dir, "missing.sqlite")).available,
      ).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
