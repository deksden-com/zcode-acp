/**
 * Background-notification busy window: while a background task's
 * NOTIFICATION turn runs (the model summarising the finished task), the
 * backend's prompt lock is held and session/send answers busy
 * (-32010 "A prompt is already running for this session" — observed live
 * 2026-09-18). A notification turn is a real model turn that easily outlives
 * the normal 30s busy budget; the prompt path extends the budget while
 * server.notifyTurnActiveSince marks the session (session.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

/** Mutable fake clock: advances 20s per session/send attempt. */
let fakeNow = 0;
const REAL_NOW = Date.now;

function fakeBackend(busySends: number): ZcodeBackend {
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  let sends = 0;
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
        case "session/subscribe":
          return { result: {} };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/send": {
          fakeNow += 20_000; // each attempt costs 20s of wall clock
          sends += 1;
          if (sends <= busySends) {
            return {
              error: { code: -32010, message: "A prompt is already running for this session" },
            };
          }
          const events: ZcodeEvent[] = [
            { sessionId: "zs_bw", seq: 1, type: "turn.started", payload: {} },
            {
              sessionId: "zs_bw",
              seq: 2,
              type: "turn.completed",
              payload: { resultType: "success" },
            },
          ];
          for (const e of events) for (const l of listeners) l.handleEvent(e);
          return { result: { accepted: true } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_bw", "zs_bw");
  server.markBackendLoaded("sess_bw");
  return server;
}

function promptParams(text: string): acp.PromptRequest {
  return { sessionId: "sess_bw", prompt: [{ type: "text", text }] } as acp.PromptRequest;
}

function collectCx(): acp.AgentContext {
  return {
    notify: async () => undefined,
    request: async () => ({}),
  } as unknown as acp.AgentContext;
}

describe("send busy-retry window during a background notification turn", () => {
  beforeEach(() => {
    fakeNow = REAL_NOW();
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps retrying past the 30s busy budget while the notification turn runs", async () => {
    // Two busy attempts put the fake clock 40s past sendT0 — beyond the
    // normal 30s budget. With the notification window active the loop must
    // still accept on the third attempt.
    const server = setup(fakeBackend(2));
    server.notifyTurnActiveSince.set("zs_bw", REAL_NOW());
    const result = await prompt(server, promptParams("next message"), collectCx(), 1);
    expect(result).toEqual({ stopReason: "end_turn" });
  });

  it("still fails after the normal 30s budget without a notification turn", async () => {
    const server = setup(fakeBackend(99)); // always busy
    const promise = prompt(server, promptParams("next message"), collectCx(), 1);
    await expect(promise).rejects.toThrow(/backend still busy after 30s/);
  });

  it("a busy streak past 30s WITHOUT the notification window still fails", async () => {
    // Mirror of the first case without the window: 40s of busy must fail.
    const server = setup(fakeBackend(2));
    await expect(prompt(server, promptParams("next message"), collectCx(), 1)).rejects.toThrow(
      /backend still busy after 30s/,
    );
  });

  it("the extended window is bounded: always-busy still fails after 180s", async () => {
    const server = setup(fakeBackend(99)); // always busy
    server.notifyTurnActiveSince.set("zs_bw", REAL_NOW());
    await expect(prompt(server, promptParams("next message"), collectCx(), 1)).rejects.toThrow(
      /backend still busy after 180s/,
    );
  });

  it("a STALE notification marker (>10 min old) does not extend the window", async () => {
    const server = setup(fakeBackend(2));
    server.notifyTurnActiveSince.set("zs_bw", REAL_NOW() - 601_000);
    await expect(prompt(server, promptParams("next message"), collectCx(), 1)).rejects.toThrow(
      /backend still busy after 30s/,
    );
  });
});
