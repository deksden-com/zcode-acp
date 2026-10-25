import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  readRetainedChildBinding,
  readRetainedTerminal,
} from "../src/backend/retained-terminal.js";
import { retainedTerminal } from "../src/handlers/harness.js";
import type { ZcodeAcpServer } from "../src/server.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
let root: string, file: string, db: InstanceType<typeof DatabaseSync>;
const proof = "zcode/retained-child-effects@1";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "retained-effects-"));
  vi.stubEnv("ZCODE_HOME", path.join(root, ".zcode"));
  file = path.join(root, ".zcode", "cli", "db", "db.sqlite");
  mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE session(id TEXT,parent_id TEXT,task_type TEXT); CREATE TABLE message(id TEXT,session_id TEXT,sequence INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,sequence INTEGER,data TEXT)",
  );
  db.prepare("INSERT INTO session VALUES (?,?,?)").run(
    "sess_child",
    "sess_parent",
    "subagent_child",
  );
  message("user", 1, { role: "user", anchor: { turnId: "turn_failed" } });
  message("assistant", 3, {
    role: "assistant",
    anchor: { turnId: "turn_failed" },
    time: { completed: 150 },
    error: {
      data: { code: "model_request_failed", attribution: { source: "network", retryable: true } },
    },
  });
  tool("read", "Read", "completed");
  db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(
    "parent",
    "sess_parent",
    1,
    JSON.stringify({ role: "assistant", anchor: { turnId: "turn_parent" } }),
  );
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run(
    "launch",
    "parent",
    "sess_parent",
    1,
    JSON.stringify({
      type: "tool",
      tool: "Agent",
      callID: "call_launch",
      state: { status: "completed" },
    }),
  );
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function message(id: string, sequence: number, data: object) {
  db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(
    id,
    "sess_child",
    sequence,
    JSON.stringify(data),
  );
}
function tool(id: string, name: string, status: string) {
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run(
    id,
    "assistant",
    "sess_child",
    1,
    JSON.stringify({
      type: "tool",
      tool: name,
      callID: id,
      state: { status, input: { secret: "not-for-client" }, output: "not-for-client" },
    }),
  );
}
function read() {
  return readRetainedTerminal("sess_child", 100, 200, "turn_failed", file, proof);
}

it("validates full retained Turn without requiring contiguous assistant sequences or exposing output", () => {
  expect(read()).toMatchObject({
    available: true,
    effects_proof: { settled: true, message_count: 2, tool_count: 1, message_watermark: 3 },
  });
  expect(JSON.stringify(read())).not.toContain("not-for-client");
  tool("background", "Bash", "completed");
  expect(read()).toMatchObject({
    effects_proof: { settled: false, reason: "background_effects_unproven" },
  });
});
it("rejects pending/duplicate tools and newer unanchored input", () => {
  tool("pending", "Read", "running");
  expect(read()).toMatchObject({ effects_proof: { settled: false, reason: "pending_tools" } });
  db.exec("DELETE FROM part WHERE id='pending'");
  tool("read", "Read", "completed");
  expect(read()).toMatchObject({ effects_proof: { settled: false } });
  message("new", 4, { role: "user" });
  expect(read()).toMatchObject({
    effects_proof: { settled: false, reason: "successor_turn_present" },
  });
});
it("binds durable SendMessage admission to native parent, child, tool and parent Turn", () => {
  const insert = (status = "completed", call = "send") =>
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run(
      call,
      "parent",
      "sess_parent",
      2,
      JSON.stringify({
        type: "tool",
        tool: "SendMessage",
        callID: call,
        state: {
          status,
          input: { to: "agent_owned", message: "secret" },
          output: JSON.stringify({
            status: "success",
            agentId: "agent_owned",
            messageId: "message_one",
            delivery: "resumed_background",
          }),
        },
      }),
    );
  insert();
  const binding = () =>
    readRetainedChildBinding("sess_child", "sess_parent", "agent_owned", "call_launch", file);
  expect(binding()).toMatchObject({
    available: true,
    current_turn_id: "turn_failed",
    continuation_admission: {
      parent_turn_id: "turn_parent",
      parent_tool_call_id: "send",
      message_id: "message_one",
      delivery: "resumed_background",
    },
  });
  expect(JSON.stringify(binding())).not.toContain("secret");
  insert("running", "ambiguous");
  expect(binding()).toMatchObject({ available: false, reason: "ambiguous_send_message_admission" });
  expect(
    readRetainedChildBinding("sess_child", "sess_foreign", "agent_owned", "call_launch", file),
  ).toMatchObject({ available: false });
});
it("fences parent/child topology before and after read-only effects inspection", async () => {
  const node = {
    childSessionId: "sess_child",
    agentId: "agent_owned",
    toolCallId: "call_launch",
    startedAt: 100,
    endedAt: 200,
    status: "failed",
  };
  let parentResident = true;
  const request = vi.fn(async (_id: number, method: string, params: Record<string, unknown>) => {
    if (method === "session/read")
      return {
        result: {
          projection: parentResident ? { status: "idle" } : null,
          revision: 1,
          childSessionIds: [],
          running: [],
          ended: { total: 0, items: [] },
        },
      };
    expect(method).toBe("session/subagents");
    return {
      result: {
        revision: 1,
        childSessionIds: params.sessionId === "sess_parent" ? ["sess_child"] : [],
        running: [],
        ended: {
          total: params.sessionId === "sess_parent" ? 1 : 0,
          items: params.sessionId === "sess_parent" ? [node] : [],
        },
      },
    };
  });
  const backend = { request, isDead: false };
  const owners = new Map([["sess_parent", backend]]);
  const server = {
    resolveSid: () => undefined,
    ensureBackend: async () => backend,
    nativeChildRegistryParents: owners,
    nextId: () => 1,
  } as unknown as ZcodeAcpServer;
  const input = {
    sessionId: "sess_child",
    parentSessionId: "sess_parent",
    startedAt: 100,
    endedAt: 200,
    turnId: "turn_failed",
    proofContract: proof,
  };
  expect(await retainedTerminal(server, input)).toMatchObject({
    effects_proof: { settled: true },
    continuation_ref: {
      child_session_id: "sess_child",
      parent_session_id: "sess_parent",
      agent_id: "agent_owned",
      terminal_turn_id: "turn_failed",
    },
  });
  owners.clear();
  const cold = await retainedTerminal(server, input);
  expect(cold).toMatchObject({
    available: true,
    effects_proof: { settled: true },
    continuation_unavailable_reason: "native_registry_generation_unproven",
  });
  expect(cold.continuation_ref).toBeUndefined();
  owners.set("sess_parent", backend);
  parentResident = false;
  const evicted = await retainedTerminal(server, input);
  expect(evicted).toMatchObject({
    continuation_unavailable_reason: "native_registry_residency_unproven",
  });
  expect(evicted.continuation_ref).toBeUndefined();
  expect(owners.has("sess_parent")).toBe(false);
  let parents = 0;
  request.mockImplementation(async (_id, method, params) => {
    expect(method).toBe("session/subagents");
    const parent = params.sessionId === "sess_parent";
    if (parent) parents++;
    return {
      result: {
        revision: parent ? parents : 1,
        childSessionIds: parent ? ["sess_child"] : [],
        running: [],
        ended: { total: parent ? 1 : 0, items: parent ? [node] : [] },
      },
    };
  });
  expect(await retainedTerminal(server, input)).toMatchObject({
    available: false,
    reason: "topology_changed",
  });
});

it("accepts typed SendMessage success plus native current-lifetime metadata without inventing a messageId", () => {
  const file = path.join(
    root,
    ".zcode",
    "cli",
    "agents",
    "sess_parent",
    "agent_owned",
    "metadata.json",
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      agentId: "agent_owned",
      childSessionId: "sess_child",
      parentSessionId: "sess_parent",
      parentToolUseId: "call_send",
      createdAt: new Date(140).toISOString(),
      prompt: "private prompt",
    }),
  );
  db.prepare("UPDATE message SET data=? WHERE id=?").run(
    JSON.stringify({
      role: "assistant",
      anchor: { turnId: "turn_successor" },
      time: { created: 145, completed: 150 },
    }),
    "assistant",
  );
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run(
    "send",
    "parent",
    "sess_parent",
    2,
    JSON.stringify({
      type: "tool",
      tool: "SendMessage",
      callID: "call_send",
      state: {
        status: "completed",
        input: { to: "agent_owned" },
        time: { start: 130, end: 141 },
        output: "Native formatted prose, not JSON",
        metadata: { display: { kind: "local_agent_message", status: "success" } },
      },
    }),
  );
  const result = readRetainedChildBinding(
    "sess_child",
    "sess_parent",
    "agent_owned",
    "call_launch",
    file.replace(/agents.*$/, "db/db.sqlite"),
  );
  expect(result).toMatchObject({
    available: true,
    continuation_admission: {
      proof_kind: "parent_tool_successor",
      parent_turn_id: "turn_parent",
      parent_tool_call_id: "call_send",
      successor_turn_id: "turn_successor",
      successor_started_at: 140,
    },
  });
  expect((result.continuation_admission as Record<string, unknown>).message_id).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("private prompt");
  writeFileSync(
    file,
    JSON.stringify({
      agentId: "agent_owned",
      childSessionId: "sess_child",
      parentSessionId: "sess_parent",
      parentToolUseId: "call_send",
      createdAt: new Date(140).toISOString(),
      status: "running",
    }),
  );
  db.prepare("UPDATE message SET data=? WHERE id=?").run(
    JSON.stringify({
      role: "assistant",
      anchor: { turnId: "turn_predecessor" },
      time: { created: 100, completed: 110 },
    }),
    "assistant",
  );
  const inspect = () =>
    readRetainedChildBinding(
      "sess_child",
      "sess_parent",
      "agent_owned",
      "call_launch",
      file.replace(/agents.*$/, "db/db.sqlite"),
    );
  const partial = inspect();
  expect(partial).toMatchObject({
    current_turn_id: "turn_predecessor",
    continuation_admission: {
      proof_kind: "parent_tool_admission",
      parent_turn_id: "turn_parent",
      parent_tool_call_id: "call_send",
      successor_started_at: 140,
    },
  });
  expect(
    (partial.continuation_admission as Record<string, unknown>).successor_turn_id,
  ).toBeUndefined();
  expect((partial.continuation_admission as Record<string, unknown>).message_id).toBeUndefined();
  db.prepare("UPDATE message SET data=? WHERE id=?").run(
    JSON.stringify({
      role: "assistant",
      anchor: { turnId: "turn_successor" },
      time: { created: 145, completed: 150 },
    }),
    "assistant",
  );
  expect(inspect()).toMatchObject({
    current_turn_id: "turn_successor",
    continuation_admission: {
      proof_kind: "parent_tool_successor",
      successor_turn_id: "turn_successor",
    },
  });
  writeFileSync(
    file,
    JSON.stringify({
      agentId: "agent_owned",
      childSessionId: "sess_child",
      parentSessionId: "sess_parent",
      parentToolUseId: "call_foreign",
      createdAt: new Date(140).toISOString(),
    }),
  );
  expect(
    readRetainedChildBinding(
      "sess_child",
      "sess_parent",
      "agent_owned",
      "call_launch",
      file.replace(/agents.*$/, "db/db.sqlite"),
    ).continuation_admission,
  ).toBeUndefined();
});
