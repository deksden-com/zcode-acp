import { describe, expect, it, vi } from "vitest";

import {
  events,
  readSession,
  resolveSession,
  subagents,
  usage,
} from "../src/handlers/extensions.js";
import { EventTranslator } from "../src/translators/event-translator.js";
import type { ZcodeAcpServer } from "../src/server.js";

function serverWith(result: unknown) {
  const request = vi.fn(async () => ({ result }));
  return {
    server: {
      resolveSid: () => "sess_native",
      isBackendSessionLive: () => true,
      pendingTurns: new Map(),
      nextId: () => 1,
      ensureBackend: () => ({ request }),
    } as unknown as ZcodeAcpServer,
    request,
  };
}

describe("dd harness extensions", () => {
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

  it("adds exact request and cache counters to the compact usage projection", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ result: { sessionId: "sess_native", totalTokens: 12 } })
      .mockResolvedValueOnce({ result: { messages: [
        { info: { role: "assistant", tokens: { total: 10, input: 8, output: 2, reasoning: 1, cache: { read: 5, write: 1 } } } },
        { info: { role: "user" } },
        { info: { role: "assistant", tokens: { total: 20, input: 17, output: 3, cache: { read: 11, write: 0 } } } }
      ] } });
    const server = { resolveSid: () => "sess_native", isBackendSessionLive: () => true, pendingTurns: new Map(), nextId: vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(2), ensureBackend: () => ({ request }) } as unknown as ZcodeAcpServer;
    await expect(usage(server, { sessionId: "acp_1" })).resolves.toMatchObject({
      totalTokens: 12, requestUsageStatus: "measured", requestCount: 2, requestTotalTokens: 30,
      requestInputTokens: 25, requestOutputTokens: 5, requestReasoningTokens: 1,
      requestCacheReadTokens: 16, requestCacheCreationTokens: 1
    });
    expect(request).toHaveBeenNthCalledWith(1, 1, "session/usage", { sessionId: "sess_native" }, 15000);
    expect(request).toHaveBeenNthCalledWith(2, 2, "session/read", { sessionId: "sess_native" }, 15000);
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
