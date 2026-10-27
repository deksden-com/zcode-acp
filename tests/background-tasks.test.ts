/**
 * BackgroundTaskListener unit tests.
 *
 * Drives handleEvent() with synthetic zcode events (the shapes captured by the
 * real app-server probe — see docs/PROTOCOL.md "Background Tasks") and asserts
 * the session/update notifications it pushes back via the server. No real
 * backend or ACP client — `notifyByZcodeSid` is stubbed to record calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundTaskListener } from "../src/handlers/background-tasks.js";
import type { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeEvent } from "../src/backend/types.js";

// Pin the language: asserted card titles are English and fs is not mocked.
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A minimal fake server: records every session/update it would send. */
interface FakeServer {
  calls: Array<{ zcodeSid: string; update: Record<string, unknown> }>;
  /** Mirrors ZcodeAcpServer.terminalSentData — set by tests to simulate a
   *  tracked launch card so BackgroundTaskListener reuses it. */
  terminalSentData: Map<string, string>;
  /** Mirrors ZcodeAcpServer.notifyTurnActiveSince (notification busy window). */
  notifyTurnActiveSince: Map<string, number>;
  pendingTurns: Map<string, { zcodeSid: string; nativeTurnId?: string }>;
}
type TestServer = FakeServer & Pick<ZcodeAcpServer, "notifyByZcodeSid">;

function makeServer(): TestServer {
  const calls: TestServer["calls"] = [];
  const server = {
    calls,
    terminalSentData: new Map<string, string>(),
    notifyTurnActiveSince: new Map<string, number>(),
    pendingTurns: new Map<string, { zcodeSid: string; nativeTurnId?: string }>(),
    // pushTaskTerminal reads the live client count (offline-push gate).
    clients: { size: 0 },
    async notifyByZcodeSid(zcodeSid: string, update: Record<string, unknown>): Promise<boolean> {
      calls.push({ zcodeSid, update });
      return true;
    },
  };
  return server as unknown as TestServer;
}

function zcodeEvent(
  type: string,
  payload: Record<string, unknown>,
  extra: Partial<ZcodeEvent> = {},
): ZcodeEvent {
  return {
    sessionId: "sess_test",
    seq: 0,
    type: type as ZcodeEvent["type"],
    payload,
    ...extra,
  };
}

describe("BackgroundTaskListener", () => {
  it("forwards only changing late child output on its original native turn, before its terminal", async () => {
    const server = makeServer(),
      listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    const base = {
      toolCallId: "tool",
      toolName: "Bash",
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native",
      parentToolCallId: "parent",
    };
    const event = (payload: Record<string, unknown>, turnId = "turn_old") =>
      zcodeEvent("tool.updated", { ...base, ...payload }, { turnId });
    server.pendingTurns.set("old", { zcodeSid: "sess_test", nativeTurnId: "turn_old" });
    const start = event({ kind: "scheduled", input: { command: "long-command" } });
    listener.handleEvent(start);
    listener.noteForegroundMirrored(start);
    const foreground = event({ kind: "progress", stdoutTail: "foreground" });
    listener.handleEvent(foreground);
    expect(listener.forwardedMirrored(foreground)).toBe(false);
    listener.noteForegroundMirrored(foreground);
    server.pendingTurns.delete("old");
    server.pendingTurns.set("next", { zcodeSid: "sess_test", nativeTurnId: "turn_new" });
    listener.handleEvent(event({ kind: "progress", stdoutTail: "foreign" }, "turn_other"));
    listener.handleEvent(event({ kind: "progress", stdoutTail: "foreground" }));
    listener.handleEvent(
      event({ kind: "progress", stdoutTail: "foreign", childSessionId: "other" }),
    );
    listener.handleEvent(event({ kind: "progress", stdoutTail: "first" }));
    listener.handleEvent(event({ kind: "progress", stdoutTail: "first" }));
    listener.handleEvent(
      event({ kind: "progress", stdoutTail: "first\nsecond", stderrTail: "warning" }),
    );
    listener.handleEvent(event({ kind: "result" }));
    listener.handleEvent(event({ kind: "progress", stdoutTail: "after native terminal" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.calls.map((call) => call.update.rawOutput)).toEqual([
      "first",
      "first\nsecond\nwarning",
      undefined,
    ]);
    expect(server.calls.map((call) => call.update.status)).toEqual([
      "in_progress",
      "in_progress",
      "completed",
    ]);
    expect(
      server.calls.every(
        (call) =>
          (call.update._meta as { zcodeRuntime: { nativeTurnId: string } }).zcodeRuntime
            .nativeTurnId === "turn_old",
      ),
    ).toBe(true);
    listener.handleEvent(event({ kind: "progress", stdoutTail: "after terminal" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.calls).toHaveLength(3);
  });

  it("waits for late start delivery and retries an undelivered progress snapshot", async () => {
    const server = makeServer(),
      listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    const base = {
      toolCallId: "tool",
      toolName: "Bash",
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native",
      parentToolCallId: "parent",
    };
    const event = (kind: string) =>
      zcodeEvent(
        "tool.updated",
        { ...base, kind, input: { command: "long-command" }, stdoutTail: "output" },
        { turnId: "turn_old" },
      );
    let release!: (value: boolean) => void;
    const notify = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    server.notifyByZcodeSid = notify as typeof server.notifyByZcodeSid;
    listener.handleEvent(event("scheduled"));
    listener.handleEvent(event("progress"));
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(1);
    release(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(2);
    listener.handleEvent(event("progress"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(3);
    listener.handleEvent(event("progress"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("forwards only native terminal outcomes of the same known mirrored child", async () => {
    const server = makeServer(),
      listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    const base = {
      toolCallId: "tool",
      toolName: "Bash",
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native",
      parentToolCallId: "parent",
    };
    const start = zcodeEvent(
      "tool.updated",
      { ...base, kind: "scheduled", input: { command: "pwd" } },
      { turnId: "turn_old", seq: 1 },
    );
    listener.handleEvent(start);
    await Promise.resolve();
    expect(server.calls).toHaveLength(1);
    const foreign = zcodeEvent(
      "tool.updated",
      { ...base, kind: "result", childSessionId: "foreign" },
      { turnId: "turn_old", seq: 2 },
    );
    listener.handleEvent(foreign);
    expect(listener.forwardedMirrored(foreign)).toBe(false);
    expect(server.calls).toHaveLength(1);
    const wrongTurn = zcodeEvent(
      "tool.updated",
      { ...base, kind: "result" },
      { turnId: "turn_other", seq: 3 },
    );
    listener.handleEvent(wrongTurn);
    expect(listener.forwardedMirrored(wrongTurn)).toBe(false);
    const terminal = zcodeEvent(
      "tool.updated",
      { ...base, kind: "result" },
      { turnId: "turn_old", seq: 4 },
    );
    listener.handleEvent(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.calls[1]?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "completed",
      _meta: {
        zcodeRuntime: {
          childSessionId: "child",
          childToolCallId: "native",
          parentToolCallId: "parent",
          nativeTurnId: "turn_old",
        },
      },
    });
    listener.handleEvent(
      zcodeEvent("tool.updated", { ...base, kind: "result" }, { turnId: "turn_old", seq: 5 }),
    );
    await Promise.resolve();
    expect(server.calls).toHaveLength(2);
    listener.handleEvent(
      zcodeEvent(
        "tool.updated",
        { ...base, kind: "started", input: { command: "changed" } },
        { turnId: "turn_old", seq: 7 },
      ),
    );
    await Promise.resolve();
    expect(server.calls).toHaveLength(2);
    // A first event that is only terminal does not establish a prior tool.
    listener.handleEvent(
      zcodeEvent(
        "tool.updated",
        { ...base, kind: "error", toolCallId: "unseen" },
        { turnId: "turn_old", seq: 6 },
      ),
    );
    await Promise.resolve();
    expect(server.calls).toHaveLength(2);
  });

  it("retains a foreground child identity so its later error reaches the same physical child", async () => {
    const server = makeServer(),
      listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    const base = {
      toolCallId: "tool",
      toolName: "Bash",
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native",
      parentToolCallId: "parent",
    };
    server.pendingTurns.set("foreground", { zcodeSid: "sess_test", nativeTurnId: "turn_old" });
    const start = zcodeEvent(
      "tool.updated",
      { ...base, kind: "scheduled", input: { command: "pwd" } },
      { turnId: "turn_old" },
    );
    listener.handleEvent(start);
    expect(listener.forwardedMirrored(start)).toBe(false);
    listener.noteForegroundMirrored(start);
    const currentResult = zcodeEvent(
      "tool.updated",
      { ...base, kind: "error" },
      { turnId: "turn_old" },
    );
    listener.handleEvent(currentResult);
    await Promise.resolve();
    expect(listener.forwardedMirrored(currentResult)).toBe(true);
    server.pendingTurns.set("next", { zcodeSid: "sess_test", nativeTurnId: "turn_new" });
    server.pendingTurns.delete("foreground");
    const late = zcodeEvent("tool.updated", { ...base, kind: "error" }, { turnId: "turn_old" });
    listener.handleEvent(late);
    await Promise.resolve();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.update).toMatchObject({
      status: "failed",
      _meta: {
        zcodeRuntime: {
          childSessionId: "child",
          childToolCallId: "native",
          nativeTurnId: "turn_old",
        },
      },
    });
  });

  it("does not treat an undelivered terminal notification as sent", async () => {
    const server = makeServer(),
      listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    const base = {
      toolCallId: "tool",
      toolName: "Bash",
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native",
      parentToolCallId: "parent",
    };
    listener.handleEvent(
      zcodeEvent(
        "tool.updated",
        { ...base, kind: "scheduled", input: { command: "pwd" } },
        { turnId: "turn_old" },
      ),
    );
    await Promise.resolve();
    const notify = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    server.notifyByZcodeSid = notify as typeof server.notifyByZcodeSid;
    const terminal = () =>
      zcodeEvent("tool.updated", { ...base, kind: "result" }, { turnId: "turn_old" });
    listener.handleEvent(terminal());
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener.handleEvent(terminal());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("retains a failed terminal delivery and retries on a duplicate start", async () => {
    const server = makeServer();
    const listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    const notify = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    server.notifyByZcodeSid = notify as typeof server.notifyByZcodeSid;
    const base = {
      toolCallId: "tool",
      toolName: "Bash",
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native",
      parentToolCallId: "parent",
    };
    const start = () =>
      zcodeEvent(
        "tool.updated",
        { ...base, kind: "started", input: { command: "pwd" } },
        { turnId: "turn_old" },
      );
    listener.handleEvent(start());
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener.handleEvent(
      zcodeEvent("tool.updated", { ...base, kind: "result" }, { turnId: "turn_old" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(2);
    listener.handleEvent(start());
    listener.handleEvent(start());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[2]?.[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
      _meta: {
        zcodeRuntime: {
          childSessionId: "child",
          childToolCallId: "native",
          nativeTurnId: "turn_old",
        },
      },
    });
    listener.handleEvent(start());
    expect(notify).toHaveBeenCalledTimes(3);
  });
  it("retries an undelivered late start without duplicating an in-flight delivery", async () => {
    const server = makeServer();
    const listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    let resolveFirst!: (value: boolean) => void;
    const first = new Promise<boolean>((resolve) => {
      resolveFirst = resolve;
    });
    const notify = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(true);
    server.notifyByZcodeSid = notify as typeof server.notifyByZcodeSid;
    const start = () =>
      zcodeEvent(
        "tool.updated",
        {
          kind: "scheduled",
          toolCallId: "tool",
          toolName: "Bash",
          input: { command: "pwd" },
          source: "subagent",
          childSessionId: "child",
          childToolCallId: "native",
          parentToolCallId: "parent",
        },
        { turnId: "turn_old" },
      );
    listener.handleEvent(start());
    listener.handleEvent(start());
    expect(notify).toHaveBeenCalledTimes(1);
    resolveFirst(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener.handleEvent(start());
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener.handleEvent(start());
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("retains the native terminal across a failed start until a successful start retry", async () => {
    const server = makeServer();
    const listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    let resolveFirst!: (value: boolean) => void;
    const first = new Promise<boolean>((resolve) => {
      resolveFirst = resolve;
    });
    const notify = vi.fn().mockReturnValueOnce(first).mockResolvedValue(true);
    server.notifyByZcodeSid = notify as typeof server.notifyByZcodeSid;
    const base = {
      toolCallId: "tool",
      toolName: "Bash",
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native",
      parentToolCallId: "parent",
    };
    const start = () =>
      zcodeEvent(
        "tool.updated",
        { ...base, kind: "scheduled", input: { command: "pwd" } },
        { turnId: "turn_old" },
      );
    listener.handleEvent(start());
    listener.handleEvent(
      zcodeEvent("tool.updated", { ...base, kind: "result" }, { turnId: "turn_old" }),
    );
    resolveFirst(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(1);
    listener.handleEvent(start());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[1]?.[1]).toMatchObject({
      sessionUpdate: "tool_call",
      status: "in_progress",
    });
    expect(notify.mock.calls[2]?.[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
      _meta: {
        zcodeRuntime: {
          childSessionId: "child",
          childToolCallId: "native",
          nativeTurnId: "turn_old",
        },
      },
    });
  });
  it("retains a terminal arriving after failed start and before its retry", async () => {
    const server = makeServer();
    const listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    const notify = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    server.notifyByZcodeSid = notify as typeof server.notifyByZcodeSid;
    const base = {
      toolCallId: "tool",
      toolName: "Bash",
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native",
      parentToolCallId: "parent",
    };
    const start = () =>
      zcodeEvent(
        "tool.updated",
        { ...base, kind: "started", input: { command: "pwd" } },
        { turnId: "turn_old" },
      );
    listener.handleEvent(start());
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener.handleEvent(
      zcodeEvent("tool.updated", { ...base, kind: "error" }, { turnId: "turn_old" }),
    );
    listener.handleEvent(start());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify.mock.calls[2]?.[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "failed",
    });
  });
  it("forwards source-bound late shell commands without guessing their semantics", async () => {
    const server = makeServer(),
      listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    const commands = [
      "$DD_FLOW_BIN work start W",
      "node /opt/engine/dist/cli.js work start W",
      "pwd",
    ];
    for (const [index, command] of commands.entries()) {
      const event = zcodeEvent(
        "tool.updated",
        {
          kind: "scheduled",
          toolCallId: `tool-${index}`,
          toolName: "Bash",
          input: { command },
          source: "subagent",
          childSessionId: "child",
          childToolCallId: `native-${index}`,
          parentToolCallId: "parent",
        },
        { seq: index + 1, turnId: "turn_old" },
      );
      listener.handleEvent(event);
      expect(listener.forwardedMirrored(event)).toBe(true);
    }
    await Promise.resolve();
    expect(
      server.calls.map((call) => (call.update.rawInput as { command: string }).command),
    ).toEqual(commands);
    server.pendingTurns.set("foreground", { zcodeSid: "sess_test", nativeTurnId: "turn_new" });
    const foreground = zcodeEvent(
      "tool.updated",
      {
        kind: "scheduled",
        toolCallId: "foreground",
        toolName: "Bash",
        input: { command: "pwd" },
        source: "subagent",
        childSessionId: "child",
        childToolCallId: "native-foreground",
        parentToolCallId: "parent",
      },
      { turnId: "turn_new" },
    );
    listener.handleEvent(foreground);
    expect(listener.forwardedMirrored(foreground)).toBe(false);
    expect(server.calls).toHaveLength(3);
  });
  it("forwards only exact late mirrored child tools and lets the foreground skip the same event", async () => {
    const server = makeServer(),
      listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    const payload = {
      kind: "scheduled",
      toolCallId: "child-call",
      toolName: "Bash",
      input: { command: "dd-flow work start W" },
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native-child-call",
      parentToolCallId: "parent",
    };
    const between = zcodeEvent("tool.updated", payload, { seq: 1, turnId: "turn_old" });
    listener.handleEvent(between);
    await Promise.resolve();
    expect(listener.forwardedMirrored(between)).toBe(true);
    expect(server.calls[0]?.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "child-call",
      rawInput: payload.input,
      _meta: {
        zcodeRuntime: {
          nativeTurnId: "turn_old",
          childSessionId: "child",
          parentToolCallId: "parent",
        },
      },
    });
    listener.handleEvent(zcodeEvent("tool.updated", payload, { seq: 2, turnId: "turn_old" }));
    await Promise.resolve();
    expect(server.calls).toHaveLength(1);
    server.pendingTurns.set("next", { zcodeSid: "sess_test", nativeTurnId: "turn_new" });
    const late = zcodeEvent(
      "tool.updated",
      { ...payload, toolCallId: "late-call" },
      { seq: 3, turnId: "turn_old" },
    );
    listener.handleEvent(late);
    await Promise.resolve();
    expect(listener.forwardedMirrored(late)).toBe(true);
    expect(server.calls).toHaveLength(2);
    const own = zcodeEvent(
      "tool.updated",
      { ...payload, toolCallId: "own-call" },
      { seq: 4, turnId: "turn_new" },
    );
    listener.handleEvent(own);
    expect(listener.forwardedMirrored(own)).toBe(false);
    listener.noteForegroundMirrored(own);
    server.pendingTurns.clear();
    const oldReplay = zcodeEvent(
      "tool.updated",
      { ...payload, toolCallId: "own-call" },
      { seq: 9, turnId: "turn_new" },
    );
    listener.handleEvent(oldReplay);
    expect(listener.forwardedMirrored(oldReplay)).toBe(true);
    const unbound = zcodeEvent("tool.updated", { ...payload, toolCallId: "unbound" }, { seq: 5 });
    listener.handleEvent(unbound);
    expect(listener.forwardedMirrored(unbound)).toBe(false);
    const forged = zcodeEvent(
      "tool.updated",
      { ...payload, toolCallId: "bad", parentToolCallId: "" },
      { seq: 6, turnId: "turn_old" },
    );
    listener.handleEvent(forged);
    expect(listener.forwardedMirrored(forged)).toBe(false);
    expect(server.calls).toHaveLength(2);
  });

  it("ignores root streaming input and retains only source-bound scheduled input for child retry", async () => {
    const server = makeServer(),
      listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    listener.handleEvent(
      zcodeEvent(
        "model.streaming",
        { kind: "tool_call", toolCallId: "call", input: { command: "dd-flow work start W" } },
        { turnId: "turn_old" },
      ),
    );
    const payload = {
      kind: "scheduled",
      toolCallId: "call",
      toolName: "Bash",
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native-child-call",
      parentToolCallId: "parent",
    };
    const absent = zcodeEvent("tool.updated", payload, { turnId: "turn_old" });
    listener.handleEvent(absent);
    expect(listener.forwardedMirrored(absent)).toBe(false);
    expect((listener as any).mirroredInputs.size).toBe(0);
    const exact = zcodeEvent(
      "tool.updated",
      { ...payload, input: { command: "dd-flow work start W" } },
      { turnId: "turn_old" },
    );
    listener.handleEvent(exact);
    await Promise.resolve();
    expect(listener.forwardedMirrored(exact)).toBe(true);
    expect(server.calls).toHaveLength(1);
    const terminal = zcodeEvent(
      "tool.updated",
      { ...payload, kind: "result" },
      { turnId: "turn_old" },
    );
    listener.handleEvent(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replay = zcodeEvent("tool.updated", payload, { turnId: "turn_old" });
    listener.handleEvent(replay);
    expect(listener.forwardedMirrored(replay)).toBe(false); // cached input was released after terminal delivery
  });
  it("retains source-bound scheduled input when retry arrives as started without input", async () => {
    const server = makeServer();
    const listener = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    const notify = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    server.notifyByZcodeSid = notify as typeof server.notifyByZcodeSid;
    const base = {
      toolCallId: "tool",
      toolName: "Bash",
      source: "subagent",
      childSessionId: "child",
      childToolCallId: "native",
      parentToolCallId: "parent",
    };
    listener.handleEvent(
      zcodeEvent(
        "tool.updated",
        { ...base, kind: "scheduled", input: { command: "pwd" } },
        { turnId: "old" },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener.handleEvent(
      zcodeEvent("tool.updated", { ...base, kind: "started" }, { turnId: "old" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]?.[1]).toMatchObject({ rawInput: { command: "pwd" } });
  });
  it("emits a tool_call card on the first running session.updated(taskId)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "agent_abc",
        toolCallId: "call_orig",
        status: "running",
        description: "research src/",
        outputPath: "/tmp/out.txt",
        terminalId: "agent_fallback",
        agentId: "agent_abc",
        childSessionId: "sess_child",
        parentToolCallId: "call_orig",
      }),
    );
    // notifyByZcodeSid is async; flush microtasks.
    await Promise.resolve();
    expect(server.calls).toHaveLength(1);
    const { update, zcodeSid } = server.calls[0]!;
    expect(zcodeSid).toBe("sess_test");
    expect(update["sessionUpdate"]).toBe("tool_call");
    expect(update["title"]).toBe("[background] research src/");
    expect(update["kind"]).toBe("other");
    expect(update["status"]).toBe("in_progress");
    expect(String(update["toolCallId"]).startsWith("bg_")).toBe(true);
    const meta = update["_meta"] as { backgroundTask: Record<string, unknown> };
    expect(meta.backgroundTask.taskId).toBe("agent_abc");
    expect(meta.backgroundTask.agentId).toBe("agent_abc");
    expect(meta.backgroundTask.childSessionId).toBe("sess_child");
    expect(meta.backgroundTask.parentToolCallId).toBe("call_orig");
    expect(meta.backgroundTask.outputPath).toBe("/tmp/out.txt");
  });

  it("emits a tool_call_update on status transition to completed", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "completed" }));
    await Promise.resolve();
    expect(server.calls).toHaveLength(2);
    const update = server.calls[1]!.update;
    expect(update["sessionUpdate"]).toBe("tool_call_update");
    expect(update["status"]).toBe("completed");
    // Same toolCallId as the first card.
    expect(update["toolCallId"]).toBe(server.calls[0]!.update["toolCallId"]);
  });

  it("skips no-op status updates (same status as last advertised)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    // Another running event with no status change → suppressed.
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    expect(server.calls).toHaveLength(1);
  });

  it("ignores session.updated without taskId (e.g. usage updates)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", { usage: { inputTokens: 123 }, contextWindow: 1000 }),
    );
    await Promise.resolve();
    expect(server.calls).toHaveLength(0);
  });

  it("forwards background_task turn text_delta as agent_message_chunk", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    // A notification turn starts.
    l.handleEvent(
      zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "turn_bg1" }),
    );
    await Promise.resolve();
    // The notification busy window opens with the turn.
    expect(server.notifyTurnActiveSince.has("sess_test")).toBe(true);
    // Its text deltas are forwarded.
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "result part 1 " }));
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "part 2" }));
    await Promise.resolve();
    // turn.completed ends the notification turn.
    l.handleEvent(zcodeEvent("turn.completed", { resultType: "success" }));
    await Promise.resolve();
    // ...and the busy window closes with it.
    expect(server.notifyTurnActiveSince.has("sess_test")).toBe(false);
    // Subsequent text_delta (no active bg turn) is NOT forwarded.
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "leak" }));
    await Promise.resolve();
    const chunks = server.calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk");
    expect(chunks).toHaveLength(2);
    expect((chunks[0]!.update["content"] as { text: string }).text).toBe("result part 1 ");
    expect((chunks[1]!.update["content"] as { text: string }).text).toBe("part 2");
    // All chunks share one messageId (the bg result message).
    expect(chunks[0]!.update["messageId"]).toBe(chunks[1]!.update["messageId"]);
  });

  it("turn.failed also closes the notification busy window", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "turn_bg2" }),
    );
    await Promise.resolve();
    expect(server.notifyTurnActiveSince.has("sess_test")).toBe(true);
    l.handleEvent(zcodeEvent("turn.failed", { error: { code: "x" } }));
    await Promise.resolve();
    expect(server.notifyTurnActiveSince.has("sess_test")).toBe(false);
  });

  it("allocates a fresh messageId per background task (no cross-task reuse)", async () => {
    // Regression guard: firstMessageId must be reset when a background
    // notification turn ends, else two tasks in the same session share one
    // messageId and the editor merges/overwrites their output.
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    // Task 1's notification turn.
    l.handleEvent(zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "t1" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "task1 result" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("turn.completed", { resultType: "success" }));
    await Promise.resolve();
    // Task 2's notification turn (same session, same listener instance).
    l.handleEvent(zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "t2" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "task2 result" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("turn.completed", { resultType: "success" }));
    await Promise.resolve();
    const chunks = server.calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk");
    expect(chunks).toHaveLength(2);
    // Distinct messageIds — the second task does NOT reuse the first's id.
    expect(chunks[0]!.update["messageId"]).not.toBe(chunks[1]!.update["messageId"]);
  });

  it("does NOT forward a normal (non-background) turn's text_delta", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("turn.started", { inputSource: "user_prompt" }, { turnId: "turn_user" }),
    );
    await Promise.resolve();
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "user reply" }));
    await Promise.resolve();
    expect(server.calls).toHaveLength(0);
  });

  it("markCancelled emits a failed update with cancelled flag and clears state", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    await l.markCancelled("agent_abc");
    expect(server.calls).toHaveLength(2);
    const cancel = server.calls[1]!.update;
    expect(cancel["sessionUpdate"]).toBe("tool_call_update");
    expect(cancel["status"]).toBe("failed");
    expect(
      (cancel["_meta"] as { backgroundTask: { cancelled: boolean } }).backgroundTask.cancelled,
    ).toBe(true);
    // State cleared: a subsequent status event re-creates the card (new callId).
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    expect(server.calls).toHaveLength(3);
  });

  it("never throws on a malformed payload (best-effort)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    expect(() =>
      l.handleEvent(zcodeEvent("session.updated", { taskId: "x" } as never)),
    ).not.toThrow();
    expect(() => l.handleEvent(zcodeEvent("unknown.type", {}))).not.toThrow();
    await Promise.resolve();
  });
});

describe("BackgroundTaskListener: background Bash reuses launch card", () => {
  it("reuses the launch toolCallId when terminalSentData tracks it (no new bg_ card)", async () => {
    const server = makeServer();
    // Simulate the dispatcher having already seeded the launch card.
    server.terminalSentData.set("call_bash1", "Command running in background with ID: exec_x\n");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_x",
        toolCallId: "call_bash1",
        toolName: "Bash",
        status: "running",
        description: "sleep 3",
        outputPath: "/tmp/out.log",
      }),
    );
    await Promise.resolve();
    expect(server.calls).toHaveLength(1);
    const update = server.calls[0]!.update;
    // Routes to the launch card id, NOT a fresh bg_*.
    expect(update["toolCallId"]).toBe("call_bash1");
    expect(update["sessionUpdate"]).toBe("tool_call_update");
    expect(update["status"]).toBe("in_progress");
    expect((update["_meta"] as { backgroundTask: { taskId: string } }).backgroundTask.taskId).toBe(
      "exec_x",
    );
    // No tool_call (new card) was emitted.
    expect(server.calls.some((c) => c.update["sessionUpdate"] === "tool_call")).toBe(false);
  });

  it("streams the real command output on completion even when launch text was already streamed", async () => {
    // Regression: launch acknowledgement text ("Command running in background
    // with ID: …") is written to terminalSentData by the dispatcher, but it is
    // NOT the command's actual output. The real output (outputTail) must still
    // be streamed via terminal_output on completion, or the user never sees
    // what the background command printed.
    const server = makeServer();
    server.terminalSentData.set("call_bash2", "Command running in background with ID: exec_y\n");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_y",
        toolCallId: "call_bash2",
        status: "running",
      }),
    );
    await Promise.resolve();
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_y",
        toolCallId: "call_bash2",
        status: "completed",
        outputTail: "done\n",
      }),
    );
    // onTaskStatus awaits multiple notifyByZcodeSid calls; flush enough
    // microtasks for the whole async chain (including terminalSentData.delete)
    // to settle.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    // Exactly three updates: in_progress + terminal_output + terminal_exit.
    expect(server.calls).toHaveLength(3);
    const outputCall = server.calls[1]!.update;
    expect(outputCall["sessionUpdate"]).toBe("tool_call_update");
    expect(
      (outputCall["_meta"] as { terminal_output: { data: string } }).terminal_output.data,
    ).toBe("done\n");
    const exitCall = server.calls[2]!.update;
    expect(exitCall["status"]).toBe("completed");
    expect(exitCall["content"]).toEqual([{ type: "terminal", terminalId: "call_bash2" }]);
    const meta = exitCall["_meta"] as {
      terminal_exit: { terminal_id: string; exit_code: number };
      backgroundTask: { completed: boolean };
      claudeCode: { toolName: string };
    };
    expect(meta.terminal_exit.terminal_id).toBe("call_bash2");
    expect(meta.terminal_exit.exit_code).toBe(0);
    expect(meta.backgroundTask.completed).toBe(true);
    expect(meta.claudeCode.toolName).toBe("Bash");
    // terminalSentData cleared so the launch card is fully retired.
    expect(server.terminalSentData.has("call_bash2")).toBe(false);
  });

  it("streams terminal_output when launch text was never streamed (empty marker)", async () => {
    const server = makeServer();
    // Dispatcher seeded an empty marker (no launch text streamed yet).
    server.terminalSentData.set("call_bash3", "");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_z",
        toolCallId: "call_bash3",
        status: "running",
      }),
    );
    await Promise.resolve();
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_z",
        toolCallId: "call_bash3",
        status: "completed",
        outputTail: "result\n",
      }),
    );
    await Promise.resolve();
    // running update + terminal_output + terminal_exit.
    expect(server.calls).toHaveLength(3);
    const termOutput = server.calls[1]!.update;
    const termMeta = termOutput["_meta"] as { terminal_output: { data: string } };
    expect(termMeta.terminal_output.data).toBe("result\n");
  });

  it("diffs cumulative outputTail snapshots during running progress (no duplication)", async () => {
    // The backend pushes session.updated multiple times during a long-running
    // background task, each carrying a CUMULATIVE outputTail snapshot. Only the
    // suffix beyond what we last streamed must be emitted.
    const server = makeServer();
    server.terminalSentData.set("call_bash5", "");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_progress",
        toolCallId: "call_bash5",
        status: "running",
        outputTail: "line1\n",
      }),
    );
    await Promise.resolve();
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_progress",
        toolCallId: "call_bash5",
        status: "running",
        outputTail: "line1\nline2\n",
      }),
    );
    await Promise.resolve();
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_progress",
        toolCallId: "call_bash5",
        status: "completed",
        outputTail: "line1\nline2\nline3\n",
      }),
    );
    await Promise.resolve();
    // running(status update) + terminal_output(line1) + terminal_output(line2)
    // + terminal_output(line3) + terminal_exit.
    const outputs = server.calls
      .filter((c) => (c.update["_meta"] as { terminal_output?: unknown }).terminal_output)
      .map(
        (c) => (c.update["_meta"] as { terminal_output: { data: string } }).terminal_output.data,
      );
    expect(outputs).toEqual(["line1\n", "line2\n", "line3\n"]);
  });

  it("falls back to a fresh bg_* card when toolCallId is absent (sub-agent case)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "agent_sub1",
        status: "running",
        description: "research src/",
        terminalId: "agent_sub1",
      }),
    );
    await Promise.resolve();
    // No toolCallId → no terminalSentData entry → falls back to new bg_* card.
    const update = server.calls[0]!.update;
    expect(update["sessionUpdate"]).toBe("tool_call");
    expect(String(update["toolCallId"]).startsWith("bg_")).toBe(true);
    expect(update["title"]).toBe("[background] research src/");
  });

  it("falls back to a fresh bg_* card when terminalSentData does not track the toolCallId", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    // toolCallId present but dispatcher never seeded it (e.g. old backend).
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_untracked",
        toolCallId: "call_orphan",
        status: "running",
        description: "mystery task",
      }),
    );
    await Promise.resolve();
    const update = server.calls[0]!.update;
    expect(update["sessionUpdate"]).toBe("tool_call");
    expect(String(update["toolCallId"]).startsWith("bg_")).toBe(true);
    expect(update["title"]).toBe("[background] mystery task");
  });

  it("markCancelled emits terminal_exit for a reused launch card", async () => {
    const server = makeServer();
    server.terminalSentData.set("call_bash4", "bg launch text\n");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_cancel",
        toolCallId: "call_bash4",
        status: "running",
      }),
    );
    await Promise.resolve();
    await l.markCancelled("exec_cancel");
    // running update + cancel (terminal_exit with cancelled flag).
    expect(server.calls).toHaveLength(2);
    const cancel = server.calls[1]!.update;
    expect(cancel["status"]).toBe("failed");
    expect(cancel["content"]).toEqual([{ type: "terminal", terminalId: "call_bash4" }]);
    const meta = cancel["_meta"] as {
      backgroundTask: { cancelled: boolean };
      terminal_exit: { exit_code: number };
    };
    expect(meta.backgroundTask.cancelled).toBe(true);
    expect(meta.terminal_exit.exit_code).toBe(1);
    expect(server.terminalSentData.has("call_bash4")).toBe(false);
  });
});

describe("emitShutdownRecords (#194)", () => {
  it("emits a failed shutdown record for an in-flight task and skips terminal ones", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(zcodeEvent("session.updated", { taskId: "exec_live", status: "running" }));
    l.handleEvent(zcodeEvent("session.updated", { taskId: "exec_done", status: "completed" }));
    await Promise.resolve();
    server.calls.length = 0;

    await l.emitShutdownRecords();

    // Only the still-running task gets a record; the completed one is skipped.
    expect(server.calls).toHaveLength(1);
    const rec = server.calls[0]!.update;
    expect(rec["sessionUpdate"]).toBe("tool_call_update");
    expect(rec["status"]).toBe("failed");
    const meta = rec["_meta"] as { backgroundTask: { shutdown: boolean } };
    expect(meta.backgroundTask.shutdown).toBe(true);

    // Idempotent: a second sweep finds nothing in flight.
    server.calls.length = 0;
    await l.emitShutdownRecords();
    expect(server.calls).toHaveLength(0);
  });

  it("emits terminal_exit for a reused launch card on shutdown", async () => {
    const server = makeServer();
    server.terminalSentData.set("call_bash9", "bg launch text\n");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_shutdown",
        toolCallId: "call_bash9",
        status: "running",
      }),
    );
    await Promise.resolve();
    server.calls.length = 0;

    await l.emitShutdownRecords();

    expect(server.calls).toHaveLength(1);
    const rec = server.calls[0]!.update;
    expect(rec["toolCallId"]).toBe("call_bash9");
    expect(rec["status"]).toBe("failed");
    const meta = rec["_meta"] as {
      backgroundTask: { shutdown: boolean };
      terminal_exit: { exit_code: number };
    };
    expect(meta.backgroundTask.shutdown).toBe(true);
    expect(meta.terminal_exit.exit_code).toBe(1);
    expect(server.terminalSentData.has("call_bash9")).toBe(false);
  });
});
