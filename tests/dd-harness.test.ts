import { describe, expect, it, vi } from "vitest";

import {
  closeSession,
  events,
  readSession,
  resolveSession,
  residentSession,
  retainedSubagents,
  subagents,
  usage,
} from "../src/handlers/harness.js";
import { EventTranslator } from "../src/translators/event-translator.js";
import type { ZcodeAcpServer } from "../src/server.js";

function serverWith(result: unknown) {
  const request = vi.fn(async () => ({ result }));
  return {
    server: {
      resolveSid: () => "sess_native",
      isBackendSessionLive: () => true,
      pendingTurns: new Map(),
      sessionMap: new Map(),
      backendLoadedSessions: new Map(),
      nextId: () => 1,
      ensureBackend: () => ({ request }),
    } as unknown as ZcodeAcpServer,
    request,
  };
}

describe("dd harness extensions", () => {
  it("reads retained topology without materializing or resuming a session", async () => {
    const { server, request } = serverWith({ childSessionIds: [] });
    server.isBackendSessionLive = () => false;
    await expect(retainedSubagents(server, { sessionId: "sess_child" })).resolves.toEqual({
      sessionId: "sess_native",
      topology: { childSessionIds: [] },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      1,
      "session/subagents",
      { sessionId: "sess_native" },
      15000,
    );
    request.mockResolvedValueOnce({ error: { code: -32004, message: "missing" } } as never);
    await expect(retainedSubagents(server, { sessionId: "sess_child" })).rejects.toThrow("missing");
  });
  it("resolves an adapter locator to the native Session", async () => {
    const { server } = serverWith({});
    await expect(resolveSession(server, { sessionId: "acp_1" })).resolves.toEqual({
      adapterSessionId: "acp_1",
      providerSessionId: "sess_native",
    });
  });

  it.each([
    ["session/read", readSession],
    ["session/subagents", subagents],
    ["session/events", events],
  ] as const)("forwards %s with the native Session ID", async (method, handler) => {
    const { server, request } = serverWith({ ok: true });
    await expect(handler(server, { sessionId: "acp_1", limit: 10 })).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith(1, method, { sessionId: "sess_native", limit: 10 }, 15000);
  });

  it("closes only the resolved native Session", async () => {
    const { server, request } = serverWith({ closed: true });
    await expect(closeSession(server, { sessionId: "acp_1" })).resolves.toEqual({ closed: true });
    expect(request).toHaveBeenCalledWith(1, "session/close", { sessionId: "sess_native" }, 15000);
  });

  it("checks native child residency without resuming and accepts only inactive evidence", async () => {
    const { server, request } = serverWith({});
    request.mockResolvedValueOnce({
      error: { code: -32004, message: "Session is not active" },
    } as never);
    await expect(residentSession(server, { sessionId: "acp_1" })).resolves.toEqual({
      sessionId: "sess_native",
      resident: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(1, "session/read", { sessionId: "sess_native" }, 15000);
    request.mockResolvedValueOnce({ error: { code: -1, message: "offline" } } as never);
    await expect(residentSession(server, { sessionId: "acp_1" })).rejects.toThrow("offline");
  });

  it("returns native usage unchanged without accounting or history reads", async () => {
    const native = { sessionId: "sess_native", totalTokens: 12 };
    const { server, request } = serverWith(native);
    await expect(usage(server, { sessionId: "acp_1" })).resolves.toEqual(native);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(1, "session/usage", { sessionId: "sess_native" }, 15000);
  });

  it("preserves native error code and method across the ACP boundary", async () => {
    const { server, request } = serverWith({});
    request.mockResolvedValueOnce({
      id: 1,
      error: { code: -32004, message: "not active", data: { reason: "evicted" } },
    } as never);
    await expect(readSession(server, { sessionId: "acp_1" })).rejects.toMatchObject({
      code: -32603,
      data: {
        method: "session/read",
        session_id: "sess_native",
        native_code: -32004,
        native_data: { reason: "evicted" },
      },
    });
  });
});

describe("mirrored child identity", () => {
  it("survives tool translation for lifecycle adapters", () => {
    const translated = new EventTranslator().translate({
      sessionId: "sess_root",
      seq: 7,
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "child_bash",
        toolName: "Bash",
        input: { command: "dd-flow work start WORK-1 --project-root /work --json" },
        source: "subagent",
        childSessionId: "sess_child",
        agentId: "agent_child",
        parentToolCallId: "parent_agent_call",
      },
    });
    expect(translated[0]).toMatchObject({
      kind: "ToolCallNew",
      runtimeMeta: {
        source: "subagent",
        childSessionId: "sess_child",
        agentId: "agent_child",
        parentToolCallId: "parent_agent_call",
      },
    });
  });
});
