/**
 * Detached auto-compact (the compaction kill-chain fix): the armed turn's
 * response returns and running:false lands BEFORE the compaction finishes;
 * the finished turn is out of pendingTurns (nothing for cancel/preempt to
 * kill); a follow-up prompt during the compaction is REJECTED outright (one
 * resend notice, no send attempt, no stop pair, no drain-gate close
 * escalation) — queueing it would let its subscribed listener dispatch the
 * compaction's internal-turn stream as its own output.
 *
 * Mock layout mirrors tests/turn-state.test.ts, plus compaction controls:
 * session/read reports a HIGH contextUsed on the first read only (the
 * post-compaction refresh and later turns read low), session/goal show
 * reports the lock held until releaseGoal(), and follow-up session/sends
 * are busy (1308) while that lock is held.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { cancel, prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

/** cx recording turnState payloads and agent_message_chunk texts. */
function collectCx(): {
  cx: acp.AgentContext;
  turnStates: Array<{ sessionId: string; running: boolean }>;
  texts: string[];
} {
  const turnStates: Array<{ sessionId: string; running: boolean }> = [];
  const texts: string[] = [];
  const cx = {
    notify: async (method: string, params: Record<string, unknown>) => {
      if (method === "$/zcode/turnState") {
        turnStates.push(params as { sessionId: string; running: boolean });
      } else if (method === "session/update") {
        const u = (
          params as {
            update?: { sessionUpdate?: string; content?: { text?: string } };
          }
        ).update;
        if (u?.sessionUpdate === "agent_message_chunk") texts.push(u.content?.text ?? "");
      }
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { cx, turnStates, texts };
}

interface SentFrame {
  method: string;
}

function makeBackend(): {
  backend: ZcodeBackend;
  counts: Map<string, number>;
  sentFrames: SentFrame[];
  releaseGoal: () => void;
} {
  const counts = new Map<string, number>();
  const sentFrames: SentFrame[] = [];
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  let goalLock = true;
  let sendCount = 0;
  const bump = (m: string) => counts.set(m, (counts.get(m) ?? 0) + 1);
  const deliver = (events: ZcodeEvent[]) => {
    for (const e of events) for (const l of listeners) l.handleEvent(e);
  };
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      bump(method);
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
        case "session/subscribe":
          return { result: {} };
        case "session/read":
          return {
            result: {
              projection: {
                status: "idle",
                // Usage is HIGH until the compaction settles, LOW after —
                // turn 1's arming read trips the threshold; the post-compact
                // refresh and any later turn read the compacted usage.
                contextUsed: goalLock ? 150_000 : 1_000,
              },
              settings: {},
            },
          };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/compact":
          return { result: {} };
        case "session/goal":
          return goalLock
            ? { error: { code: -32000, message: "prompt is running" } }
            : { result: {} };
        case "session/send": {
          sendCount++;
          if (sendCount > 1 && goalLock) {
            return { error: { code: 1308, message: "prompt is running" } };
          }
          deliver([
            { type: "turn.started" },
            { type: "turn.completed", payload: { resultType: "success" } },
          ]);
          return { result: { accepted: true } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: (method: string) => {
      sentFrames.push({ method });
    },
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  } as unknown as ZcodeBackend;
  return { backend, counts, sentFrames, releaseGoal: () => (goalLock = false) };
}

/** Server with a pre-registered, backend-loaded session (no create/resume). */
function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_ac", "zs_ac");
  server.markBackendLoaded("sess_ac");
  return server;
}

function promptParams(): acp.PromptRequest {
  return { sessionId: "sess_ac", prompt: [{ type: "text", text: "hello" }] } as acp.PromptRequest;
}

/** Raw backend frames that would kill a generation — must stay empty here. */
const KILL_METHODS = ["v4/command", "session/stop", "session/close"];
const killFrames = (frames: SentFrame[]) => frames.filter((f) => KILL_METHODS.includes(f.method));

beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
  vi.stubEnv("ZCODE_ACP_AUTO_COMPACT_THRESHOLD", "100000");
});

describe("detached auto-compact", () => {
  it("returns the response and settles running:false BEFORE the compaction; the finished turn leaves nothing to preempt", async () => {
    const { backend, counts, sentFrames, releaseGoal } = makeBackend();
    const server = setup(backend);
    const { cx, turnStates } = collectCx();

    const result = await prompt(server, promptParams(), cx, 1);

    // The response returned while the compaction still holds the probe lock —
    // the pre-fix shape parked here for the whole compaction.
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(turnStates).toEqual([
      { sessionId: "sess_ac", running: true },
      { sessionId: "sess_ac", running: false },
    ]);
    expect(server.pendingTurns.size).toBe(0);

    // The detached compaction started: threshold read → session/compact.
    await vi.waitFor(() => expect(counts.get("session/compact")).toBe(1));
    expect(server.autoCompactInFlight.has("zs_ac")).toBe(true);
    // Nothing fired a stop or close — the kill chain is disarmed.
    expect(killFrames(sentFrames)).toEqual([]);

    // Settle the compaction so no probe loop outlives the test (the settle
    // path waits out one 2s probe gap, so the default 1s waitFor is short).
    releaseGoal();
    await vi.waitFor(() => expect(server.autoCompactInFlight.has("zs_ac")).toBe(false), {
      timeout: 10_000,
    });
  }, 15_000);

  it("a follow-up prompt during the compaction is REJECTED at once (one notice, no send, no kill)", async () => {
    const { backend, counts, sentFrames, releaseGoal } = makeBackend();
    const server = setup(backend);
    const { cx, turnStates, texts } = collectCx();

    await prompt(server, promptParams(), cx, 1); // turn 1 + detached compaction
    await vi.waitFor(() => expect(counts.get("session/compact")).toBe(1));

    // Rejected outright — the message is NOT queued behind the compaction
    // (a queued turn's already-subscribed listener would accumulate the
    // compaction's stream and dispatch it as this prompt's output once the
    // lock released).
    const r2 = await prompt(server, promptParams(), cx, 2);
    expect(r2).toEqual({ stopReason: "max_turn_requests" });
    // The resend notice fired exactly once; the send was never attempted
    // (turn 1's send is still the only one).
    const notices = texts.filter((t) => t.includes("auto-compact in progress"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("NOT sent");
    expect(counts.get("session/send")).toBe(1);
    // The rejected prompt never registered: no turnState pair for it, no
    // preempt victim, no stop pair, no drain-gate close escalation.
    expect(turnStates).toEqual([
      { sessionId: "sess_ac", running: true }, // turn 1 starts
      { sessionId: "sess_ac", running: false }, // turn 1 settles BEFORE the compaction
    ]);
    expect(killFrames(sentFrames)).toEqual([]);

    // Settle the compaction so no probe loop outlives the test; turn 2's
    // threshold read never happened (it was rejected), so no re-arm.
    releaseGoal();
    await vi.waitFor(() => expect(server.autoCompactInFlight.has("zs_ac")).toBe(false), {
      timeout: 10_000,
    });
    expect(counts.get("session/compact")).toBe(1);
  }, 20_000);

  it("ESC on a turn racing the compaction gate (registered, send never accepted) does not fire the stop pair at the compaction", async () => {
    const { backend, sentFrames } = makeBackend();
    const server = setup(backend);
    server.autoCompactInFlight.add("zs_ac");
    // The arm-race shape: a turn registered between the entry gate and its
    // first busy response — its send was never accepted, so it owns no
    // generation the compaction guard may stop.
    const turn = { zcodeSid: "zs_ac", cancelled: false };
    server.pendingTurns.set(999, turn as never);

    await cancel(server, { sessionId: "sess_ac" } as acp.CancelNotification);

    expect(turn.cancelled).toBe(true); // the prompt itself IS cancelled
    expect(killFrames(sentFrames)).toEqual([]); // …but nothing was stopped
  });

  it("ESC on an ACCEPTED turn without an execution id still fires the stop pair (no unstoppable generation)", async () => {
    const { backend, sentFrames } = makeBackend();
    const server = setup(backend);
    server.autoCompactInFlight.add("zs_ac");
    // The backend accepted the send but turn.started (and its execution id)
    // never arrived — a deaf stream. This turn may own a RUNNING generation:
    // the compaction guard must not spare it, or ESC leaves the model
    // unstoppable for up to the compaction's whole settle window.
    const turn = { zcodeSid: "zs_ac", cancelled: false, sendAccepted: true };
    server.pendingTurns.set(998, turn as never);

    await cancel(server, { sessionId: "sess_ac" } as acp.CancelNotification);

    expect(turn.cancelled).toBe(true);
    expect(sentFrames.map((f) => f.method)).toEqual(["session/stop", "v4/command"]);
  });
});
