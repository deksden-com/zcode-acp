/**
 * ZCode subprocess client: spawn, read-loop multiplexer, async request/response.
 *
 * The ZCode app-server is launched as a subprocess (`zcode app-server --stdio`)
 * speaking line-delimited JSON over stdio. A single async read loop demultiplexes
 * inbound messages into three channels:
 *   - responses (id, no method) → resolve the matching pending request promise
 *   - server→client requests (id + method, id not pending) → server-request queue
 *   - notifications (no id):
 *       - `session/event` → routed to the registered session listener
 *       - anything else   → general notification queue
 *
 * Process-group isolation: the subprocess is its own process-group leader
 * (`detached: true`) so `close()` can kill the whole tree (zcode + its model
 * workers) with `process.kill(-pid)` and leave no orphans.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

import { log, warn } from "../utils.js";
import type {
  ZcodeEvent,
  ZcodeInbound,
  ZcodeInteractionPermissionParams,
  ZcodeInteractionUserInputParams,
  ZcodeResponse,
} from "./types.js";

/** Pending request resolver. Stored under the request id. */
interface PendingRequest {
  method: string;
  resolve: (resp: ZcodeResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  expired?: boolean;
  onLateResponse?: (response: ZcodeResponse) => void | Promise<void>;
}

/** A server→client request that we must reply to. */
export interface ServerRequest {
  id: number | string;
  method: string;
  params:
    ZcodeInteractionPermissionParams | ZcodeInteractionUserInputParams | Record<string, unknown>;
}

/** Listener for `session/event` pushes on a given session. */
export interface EventListener {
  handleEvent(event: ZcodeEvent): void;
}

export class ZcodeBackend {
  readonly proc: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly serverRequests: ServerRequest[] = [];
  // Per-session listener SET so a long-lived session listener (e.g. background
  // task monitor) can coexist with a per-turn EventStreamListener. Each event
  // is delivered to every registered listener for the session.
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readerDead = false;
  /** Monotonic id for fire-and-forget sends (send()). Uses a high range to
   *  avoid collisions with the server's request ids (low range). */
  private sendIdCounter = 1_000_000_000;
  /** Watchdog process that kills the zcode group if this bridge dies (SIGKILL). */
  private watchdog: ChildProcess | null = null;
  private closing?: Promise<void>;
  /**
   * Arrival-time responder for `interaction/requestProviderRuntimeHeaders`.
   * The backend asks before EVERY model request on a zhipu-account provider,
   * and a request that lands while no turn loop is polling the server-request
   * queue (compact's internal turn, session/goal set, any backend-owned
   * generation) dies at the backend's 180s cap as "Captcha verification
   * request timed out" — auto-compact silently failed that way (observed
   * 2026-09-19). Wired by ZcodeAcpServer.ensureBackend to the coding-plan key
   * answer; returning false falls back to queueing (turn-loop handling).
   */
  providerRuntimeHeadersResponder?: (id: number, params: Record<string, unknown>) => boolean;
  /**
   * Arrival-time hook for compact terminal states. `session/compact` runs its
   * internal turn in the background and NEVER reports failure on the RPC —
   * the outcome only surfaces as a `state.updated` notification whose reason
   * is one of `session_compacted` / `session_compact_cancelled` /
   * `session_compact_failed` (source: server-operations.ts
   * `runCompactTurnInBackground` → `afterStateMutation`). Wired by
   * ZcodeAcpServer.ensureBackend to record per-session outcomes so compact()
   * can report real failure instead of assuming success from the RPC ack.
   */
  onCompactOutcome?: (sessionId: string, reason: string) => void;

  constructor(argv: string[], env: NodeJS.ProcessEnv) {
    this.proc = spawn(argv[0]!, argv.slice(1), {
      stdio: ["pipe", "pipe", "ignore"],
      env,
      detached: true, // own process group → kill(-pid) reaps the whole tree
    });
    // Spawn failures (ENOENT when the CLI can't be resolved) arrive here
    // asynchronously — without a listener the bridge dies on an unhandled
    // 'error' event. Mark the backend dead so requests fail with a JSON-RPC
    // error instead of crashing the whole process.
    this.proc.on("error", (err) => {
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `${this.proc.spawnfile} not found — install the zcode CLI, put it on PATH, or set ZCODE_BIN`
          : err.message;
      this.markReaderDead(`spawn failed: ${hint}`);
    });
    // Node stream write errors (EPIPE on a closed stdin) are emitted as async
    // 'error' events, NOT thrown synchronously — without a listener the process
    // crashes with an unhandled 'error' event. Catch them here and mark the
    // reader dead so the rest of the bridge stops talking to a gone backend.
    this.proc.stdin?.on("error", (err) => {
      this.markReaderDead(`stdin error: ${err.message}`, "native_backend_pipe_broken");
    });
    this.startReader();
    this.startWatchdog();
    log(`backend: started zcode app-server (pid=${this.proc.pid})`);
  }

  /**
   * Spawn a tiny detached watchdog that kills the zcode process group if this
   * bridge process disappears.
   *
   * The detached/kill(-pid) cleanup in `close()` only runs when the bridge
   * exits cleanly enough for the signal handlers to fire (SIGTERM/SIGINT/etc).
   * If the bridge is SIGKILLed (Zed force-kill on reconnect, crash, OOM), the
   * handler never runs and the zcode subprocess group is orphaned. The
   * watchdog closes that gap: it polls the bridge pid every 2s and, once the
   * bridge is gone, sends SIGKILL to the zcode process group, then exits.
   *
   * The watchdog is its own process-group leader (detached) and `unref`'d, so
   * it never holds the event loop open and is not part of the zcode group it
   * kills. It self-terminates as soon as the zcode process exits, so a normal
   * shutdown leaves no lingering watchdog.
   */
  private startWatchdog(): void {
    const bridgePid = process.pid;
    const zcodePid = this.proc.pid;
    if (!bridgePid || !zcodePid) return;
    // Inline script: poll bridge liveness, kill zcode group on bridge death.
    const script = `
      const bridgePid = ${bridgePid};
      const zcodePid = ${zcodePid};
      const tick = () => {
        // Bridge gone? → reap the whole zcode process group, then exit.
        try { process.kill(bridgePid, 0); }
        catch {
          try { process.kill(-zcodePid, 'SIGKILL'); } catch {}
          process.exit(0);
        }
        // zcode already exited? → watchdog has no job left.
        try { process.kill(-zcodePid, 0); }
        catch { process.exit(0); }
      };
      setInterval(tick, 2000);
      tick();
    `;
    this.watchdog = spawn(process.execPath, ["-e", script], {
      stdio: "ignore",
      detached: true, // own process group, not part of the zcode group
    });
    this.watchdog.unref();
  }

  // ---------- read loop ----------

  private startReader(): void {
    const stdout = this.proc.stdout;
    if (!stdout) {
      this.markReaderDead("no stdout");
      return;
    }
    const rl = createInterface({ input: stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: ZcodeInbound;
      try {
        msg = JSON.parse(trimmed) as ZcodeInbound;
      } catch {
        return; // unparseable line: ignore
      }
      this.route(msg);
    });
    rl.on("close", () => this.markReaderDead("stdout closed"));
  }

  private route(msg: ZcodeInbound): void {
    const method = msg.method;
    const id = msg.id;
    if (id !== undefined && method === undefined) {
      // Response (id, no method) → resolve pending request.
      this.resolvePending(id, msg as unknown as ZcodeResponse);
      return;
    }
    if (id !== undefined && method !== undefined) {
      // Response-shaped frames must never become reverse requests after expiry.
      if ("result" in msg || "error" in msg) {
        if (this.pending.get(id)?.method === method) {
          this.resolvePending(id, msg as unknown as ZcodeResponse);
        }
      } else if (method === "session/requestRuntimePreferences") {
        // Newer app-servers block `session/create` until this handshake is
        // answered. Reply with defaults — no editor interaction needed.
        // Keep askUserQuestionAutoResolutionEnabled false so AskUserQuestion
        // still flows through the bridge's interaction path instead of being
        // auto-resolved server-side. Without this reply, create hangs.
        log(`backend: auto-replying ${method} (id=${String(id)}) with default preferences`);
        this.sendReply(id, {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: false,
        });
      } else if (
        method === "interaction/requestProviderRuntimeHeaders" &&
        this.providerRuntimeHeadersResponder?.(id, (msg.params ?? {}) as Record<string, unknown>)
      ) {
        // Answered at arrival — see providerRuntimeHeadersResponder. This is
        // what keeps compact's internal model turn alive outside any turn loop.
      } else {
        this.serverRequests.push({
          id,
          method,
          params: (msg.params ?? {}) as ServerRequest["params"],
        });
      }
      return;
    }
    if (method !== undefined) {
      // Notification.
      if (method === "session/event") {
        const ev = (msg.params ?? {}) as unknown as ZcodeEvent;
        this.dispatchEvent(ev);
      } else if (method === "state.updated") {
        // Session settings changed (model/mode/thoughtLevel switch, incl.
        // mid-turn). The params carry the authoritative full settings patch:
        //   { patch: {mode, model, thoughtLevel, …}, reason, revision, sessionId }
        // Wrap as a ZcodeEvent so it flows through the same listener pipeline.
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const reason = typeof params["reason"] === "string" ? params["reason"] : "";
        if (reason.startsWith("session_compact_") && params["sessionId"] !== undefined) {
          this.onCompactOutcome?.(String(params["sessionId"]), reason);
        }
        const ev: ZcodeEvent = {
          sessionId: String(params.sessionId ?? ""),
          seq: 0,
          type: "state.updated",
          payload: params,
        };
        this.dispatchEvent(ev);
      } else if (method === "interaction/providerRuntimeHeadersCancelled") {
        // The backend aborted a pending runtime-headers refresh (turn cancel,
        // 180s cap). Our responder answers at frame arrival, so the reply is
        // already out and there is nothing to un-answer — acknowledge only.
        log(
          `provider runtime headers ask cancelled by backend: ${JSON.stringify(msg.params ?? {})}`,
        );
      }
      // Other notifications are currently ignored (process/resourceSample, …).
    }
  }

  /** Deliver a ZcodeEvent to every listener registered for its session. */
  private dispatchEvent(ev: ZcodeEvent): void {
    const sid = ev.sessionId;
    const set = sid ? this.listeners.get(sid) : undefined;
    if (set) {
      // Iterate a snapshot so a listener that (un)registers during dispatch
      // doesn't mutate the set under us.
      for (const listener of [...set]) {
        try {
          listener.handleEvent(ev);
        } catch (e) {
          warn(
            `backend: listener.handleEvent threw: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  }

  private resolvePending(id: number, resp: ZcodeResponse): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (p.expired) {
      void Promise.resolve()
        .then(() => p.onLateResponse?.(resp))
        .catch((error) => {
          warn(`backend: late response reconciliation failed (${p.method}): ${String(error)}`);
        });
      return;
    }
    p.resolve(resp);
  }

  private markReaderDead(reason: string, code = "native_backend_dead"): void {
    if (this.readerDead) return;
    this.readerDead = true;
    warn(`backend: reader exited (${reason})`);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({
        id,
        error: {
          code,
          message: "zcode backend reader exited (backend dead)",
          data: { method: p.method },
        },
      });
    }
    this.pending.clear();
  }

  // ---------- listeners / server requests ----------

  registerEventListener(zcodeSid: string, listener: EventListener): void {
    let set = this.listeners.get(zcodeSid);
    if (!set) {
      set = new Set();
      this.listeners.set(zcodeSid, set);
    }
    set.add(listener);
  }

  unregisterEventListener(zcodeSid: string, listener: EventListener): void {
    const set = this.listeners.get(zcodeSid);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(zcodeSid);
  }

  /** Non-blocking drain of pending server→client requests. */
  pollServerRequests(): ServerRequest[] {
    if (this.serverRequests.length === 0) return [];
    return this.serverRequests.splice(0, this.serverRequests.length);
  }

  /**
   * Re-queue server→client requests that belong to a different session (prepended
   * to preserve arrival order). Used by `handleServerRequests` to put back
   * requests it popped but doesn't own.
   */
  requeueServerRequests(reqs: ServerRequest[]): void {
    if (reqs.length === 0) return;
    this.serverRequests.unshift(...reqs);
  }

  /** Reply to a zcode server→client request with a result (id + result). */
  sendReply(id: number | string, result: unknown): void {
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      warn("backend: sendReply dropped (stdin closed)");
      return;
    }
    // Write errors (EPIPE) are delivered via the stdin 'error' listener
    // installed in the constructor (synchronous try/catch cannot catch them);
    // no try/catch needed here.
    stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  /** Reply to a zcode server→client request with an error. */
  sendError(id: number | string, code: number, message: string): void {
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      warn("backend: sendError dropped (stdin closed)");
      return;
    }
    stdin.write(JSON.stringify({ id, error: { code, message } }) + "\n");
  }

  // ---------- send / request ----------

  /** Fire-and-forget notification to ZCode (no id, no response). */
  notify(method: string, params?: Record<string, unknown>): void {
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      warn("backend: notify dropped (stdin closed)");
      return;
    }
    stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  /**
   * Send a message with an id but WITHOUT registering a pending response
   * (fire-and-forget). Mirrors Python's `_backend.send({"id": ..., ...})` for
   * `session/stop`: some backends route by id presence, so carrying an id is
   * more robust than a bare notify. If the backend replies, the reader's
   * `resolvePending` finds no pending entry and safely discards it.
   */
  send(method: string, params?: Record<string, unknown>): void {
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      warn("backend: send dropped (stdin closed)");
      return;
    }
    const id = this.sendIdCounter++;
    stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + "\n");
  }

  /**
   * Synchronous request/response: register a pending promise, send, await.
   * Other notifications arriving during the wait are routed async by the
   * reader loop (they don't get swallowed).
   *
   * Returns `{error}` on dead backend, broken pipe, or timeout — never throws.
   */
  async request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30000,
    onLateResponse?: (response: ZcodeResponse) => void | Promise<void>,
  ): Promise<ZcodeResponse> {
    if (this.readerDead) {
      return {
        id,
        error: {
          code: "native_backend_dead",
          message: "zcode backend reader exited (backend dead)",
        },
      };
    }
    if (this.pending.has(id)) throw new Error(`Duplicate native request id ${id}`);
    const promise = new Promise<ZcodeResponse>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        if (onLateResponse) {
          pending.expired = true;
          // Bounded observation; durable allocation intent survives this window.
          pending.timer = setTimeout(() => this.pending.delete(id), 60_000);
          pending.timer.unref();
        } else this.pending.delete(id);
        resolve({
          id,
          error: {
            code: "native_timeout",
            message: "timeout",
            data: { method, timeout_ms: timeoutMs },
          },
        });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, method, onLateResponse });
    });
    try {
      const stdin = this.proc.stdin;
      if (!stdin || stdin.destroyed) throw new Error("stdin closed");
      stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + "\n");
    } catch (e) {
      this.markReaderDead(`pipe broken: ${String(e)}`, "native_backend_pipe_broken");
    }
    return promise;
  }

  // ---------- lifecycle ----------

  /**
   * Kill the whole zcode process group and wait for it to die.
   *
   * SIGTERM → bounded group wait → SIGKILL. Leader exit is insufficient.
   * Share teardown across shutdown paths and never re-signal a retired PGID.
   */
  close(): Promise<void> {
    return (this.closing ??= this.closeGroup());
  }

  private async closeGroup(): Promise<void> {
    const proc = this.proc;
    if (!proc.pid) return;
    this.markReaderDead("bridge closing");
    const groupGone = () => {
      try {
        process.kill(-proc.pid!, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    // The leader can exit before its workers. Only group absence proves cleanup.
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (groupGone()) break;
      try {
        process.kill(-proc.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + 3000;
      while (!groupGone() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!groupGone()) throw new Error("Native process group cleanup is unconfirmed");
    this.killWatchdog();
  }

  /** Terminate the watchdog process if it is still running. */
  private killWatchdog(): void {
    const wd = this.watchdog;
    if (!wd) return;
    this.watchdog = null;
    if (wd.pid && wd.exitCode === null) {
      try {
        process.kill(wd.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  get isDead(): boolean {
    return this.readerDead;
  }
}
