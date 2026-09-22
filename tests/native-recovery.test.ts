import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ZcodeBackend } from "../src/backend/client.js";
import { backendError, isUnknownBackendOutcome } from "../src/backend/errors.js";
import { closeSession } from "../src/handlers/harness.js";
import { ensureRealSession, reloadBackendSession } from "../src/handlers/session.js";
import { beginAllocation, finishAllocation, readAllocation } from "../src/session-allocation.js";
import { ZcodeAcpServer } from "../src/server.js";

function transport() {
  // Exercise the real multiplexer without starting native processes.
  return Object.assign(Object.create(ZcodeBackend.prototype), {
    pending: new Map(),
    serverRequests: [],
    listeners: new Map(),
    readerDead: false,
    proc: { stdin: { destroyed: false, write() {} } },
  });
}

describe("native recovery invariants", () => {
  it("checks and signals the group even after its leader exited", async () => {
    const backend = transport();
    backend.proc = { pid: 12345678, exitCode: 0, signalCode: null };
    let present = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (!present) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal === "SIGTERM") present = false;
      return true;
    });
    try {
      await backend.close();
      expect(kill).toHaveBeenCalledWith(-12345678, "SIGTERM");
      expect(present).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });
  it("does not consume a reverse-direction request with a colliding id", async () => {
    const backend = transport();
    const response = backend.request(7, "session/create", {}, 1000);
    backend.route({ id: 7, method: "interaction/requestPermission", params: {} });
    expect(backend.pollServerRequests()).toHaveLength(1);
    expect(backend.pending.size).toBe(1);
    backend.route({ id: 7, result: { sessionId: "sess_ok" } });
    expect((await response).result.sessionId).toBe("sess_ok");
  });

  it("bounds late observation and delivers a late response only once", async () => {
    vi.useFakeTimers();
    try {
      const backend = transport();
      const late = vi.fn();
      const response = backend.request(7, "session/create", {}, 10, late);
      await vi.advanceTimersByTimeAsync(10);
      expect((await response).error.code).toBe("native_timeout");
      backend.route({ id: 7, result: { sessionId: "sess_late" } });
      backend.route({ id: 7, result: { sessionId: "sess_duplicate" } });
      await Promise.resolve();
      expect(late).toHaveBeenCalledTimes(1);
      const lost = backend.request(8, "session/create", {}, 10, late);
      await vi.advanceTimersByTimeAsync(60_010);
      await lost;
      expect(backend.pending.size).toBe(0);
      backend.route({ id: 8, method: "session/create", result: { sessionId: "sess_expired" } });
      expect(backend.pollServerRequests()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles all requests with their own ids and serializable cause on pipe death", async () => {
    const backend = transport();
    const responses = [backend.request(42, "session/read"), backend.request(43, "session/create")];
    backend.markReaderDead("fixture", "native_backend_pipe_broken");
    for (const [i, response] of (await Promise.all(responses)).entries()) {
      expect(response.id).toBe(42 + i);
      const error = backendError("session/read", response);
      expect(isUnknownBackendOutcome(error)).toBe(true);
      expect(error.toResult().error.data).toMatchObject({
        code: "native_backend_pipe_broken",
        request_id: 42 + i,
      });
    }
    expect(backend.pending.size).toBe(0);
  });

  it("blocks duplicate create across processes until rejection or identity is durable", () => {
    const alias = randomUUID();
    const owner = beginAllocation(alias, "/project");
    expect(() => beginAllocation(alias, "/project")).toThrow("unknown");
    expect(() => finishAllocation(alias, "foreign", "sess_wrong")).toThrow("unknown");
    finishAllocation(alias, owner); // confirmed rejection allows a fresh dispatch
    const next = beginAllocation(alias, "/project");
    finishAllocation(alias, next, "sess_ok");
    expect(readAllocation(alias)).toMatchObject({ sessionId: "sess_ok", cwd: "/project" });
    expect(() => beginAllocation(alias, "/project")).toThrow("unknown");
  });

  it("retains late allocation without background work and blocks replay after timeout", async () => {
    const server = new ZcodeAcpServer();
    const alias = randomUUID();
    server.pendingSessions.set(alias, { cwd: "/project" });
    let reconcile: (response: unknown) => Promise<void>;
    const request = vi.fn(async (_id, method, _params, _timeout, late) => {
      if (method === "session/create") {
        reconcile = late;
        return { id: 1, error: { code: "native_timeout", message: "timeout" } };
      }
      return { id: 1, result: {} };
    });
    vi.spyOn(server, "ensureBackend").mockReturnValue({ request, isDead: false } as never);
    const listener = vi.spyOn(server, "ensureBackgroundListener").mockImplementation(() => {});
    const observer = vi.fn();
    await expect(ensureRealSession(server, alias, { onAllocated: observer })).rejects.toThrow(
      "timeout",
    );
    await expect(ensureRealSession(server, alias)).rejects.toThrow("unknown");
    expect(request.mock.calls.filter((call) => call[1] === "session/create")).toHaveLength(1);
    await reconcile!({ id: 1, result: { session: { sessionId: "sess_late" } } });
    expect(server.resolveSid(alias)).toBe("sess_late");
    expect(readAllocation(alias)?.sessionId).toBe("sess_late");
    expect(observer).toHaveBeenCalledWith("sess_late");
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not retry or overlay resume after an unknown result", async () => {
    const server = new ZcodeAcpServer();
    server.registerSession("acp_resume", "sess_resume");
    const request = vi.fn(async (_id, method) =>
      method === "session/resume"
        ? { id: 9, error: { code: "native_timeout", message: "timeout" } }
        : { id: 9, result: {} },
    );
    vi.spyOn(server, "ensureBackend").mockReturnValue({ request } as never);
    await expect(reloadBackendSession(server, "acp_resume", "sess_resume")).rejects.toThrow(
      "timeout",
    );
    expect(request.mock.calls.filter((call) => call[1] === "session/resume")).toHaveLength(1);
  });

  it("close settles only snapshotted turns after confirmed success", async () => {
    const server = new ZcodeAcpServer();
    server.registerSession("acp_close", "sess_close");
    const old = { zcodeSid: "sess_close", cancelled: false };
    const replacement = { zcodeSid: "sess_close", cancelled: false };
    server.pendingTurns.set(1, old);
    const request = vi.fn(async () => {
      server.pendingTurns.set(1, replacement);
      return { id: 1, result: { closed: true } };
    });
    vi.spyOn(server, "ensureBackend").mockReturnValue({ request } as never);
    await closeSession(server, { sessionId: "acp_close" });
    expect(old).toMatchObject({ closed: true, cancelled: true });
    expect(replacement.cancelled).toBe(false);
    request.mockResolvedValueOnce({ id: 2, result: {} } as never);
    await closeSession(server, { sessionId: "acp_close" });
    expect(replacement.cancelled).toBe(false);
  });
});
