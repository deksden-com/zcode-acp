/**
 * JsonRpcChild — shared stdio JSON-RPC subprocess transport for backends
 * (ADR-0023).
 *
 * Every backend adapter reuses one read-loop multiplexer, watchdog, and
 * process-group lifecycle:
 *   - responses (id, no method) → resolve the matching pending request
 *   - id + method               → server→client request (hook first, then queue);
 *                                 response-shaped frames require matching method
 *   - method + no id            → notification (backend-specific hook)
 *
 * Wire dialects differ per backend: zcode sends BARE frames (no `jsonrpc`
 * field — the backend's strict validator rejects it) while a standard
 * JSON-RPC 2.0 backend sends versioned frames. Subclasses override
 * {@link decorateOutbound} for the write dialect and
 * {@link handleNotification} / {@link handleServerRequest} for inbound
 * routing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

import { log, warn } from "../utils.js";
import type {
  BackendAdapter,
  BackendCapabilities,
  EventListener,
  ServerRequest,
} from "./adapter.js";
import type { ZcodeEvent, ZcodeInbound, ZcodeResponse } from "./types.js";

/** Pending request resolver. Stored under the request id. */
interface PendingRequest {
  method: string;
  resolve: (resp: ZcodeResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  expired?: boolean;
  onLateResponse?: (response: ZcodeResponse) => void | Promise<void>;
}

export interface JsonRpcChildOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Backend name used in error strings (e.g. "zcode" → "zcode backend pipe broken"). */
  name: string;
  /** Human-readable label for the start log line. */
  logLabel: string;
  /** CLI display name for the ENOENT hint. */
  cliLabel: string;
  /** Env var users can set to point at the CLI binary (for the ENOENT hint). */
  binEnvVar: string;
}

export abstract class JsonRpcChild implements BackendAdapter {
  /** Feature flags of the concrete backend — each subclass binds its kind's table. */
  abstract readonly capabilities: BackendCapabilities;
  readonly proc: ChildProcess;
  protected readonly name: string;
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
  /** Watchdog process that kills the backend group if this bridge dies (SIGKILL). */
  private watchdog: ChildProcess | null = null;
  private closing?: Promise<void>;

  protected constructor(opts: JsonRpcChildOptions) {
    this.name = opts.name;
    this.proc = spawn(opts.argv[0]!, opts.argv.slice(1), {
      stdio: ["pipe", "pipe", "ignore"],
      env: opts.env,
      detached: true, // own process group → kill(-pid) reaps the whole tree
    });
    // Spawn failures (ENOENT when the CLI can't be resolved) arrive here
    // asynchronously — without a listener the bridge dies on an unhandled
    // 'error' event. Mark the backend dead so requests fail with a JSON-RPC
    // error instead of crashing the whole process.
    this.proc.on("error", (err) => {
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `${this.proc.spawnfile} not found — install the ${opts.cliLabel}, put it on PATH, or set ${opts.binEnvVar}`
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
    log(`backend: started ${opts.logLabel} (pid=${this.proc.pid})`);
  }

  /**
   * Spawn a tiny detached watchdog that kills the backend process group if this
   * bridge process disappears.
   *
   * The detached/kill(-pid) cleanup in `close()` only runs when the bridge
   * exits cleanly enough for the signal handlers to fire (SIGTERM/SIGINT/etc).
   * If the bridge is SIGKILLed (Zed force-kill on reconnect, crash, OOM), the
   * handler never runs and the backend subprocess group is orphaned. The
   * watchdog closes that gap: it polls the bridge pid every 2s and, once the
   * bridge is gone, sends SIGKILL to the backend process group, then exits.
   *
   * The watchdog is its own process-group leader (detached) and `unref`'d, so
   * it never holds the event loop open and is not part of the backend group it
   * kills. It self-terminates as soon as the backend process exits, so a
   * normal shutdown leaves no lingering watchdog.
   */
  private startWatchdog(): void {
    const bridgePid = process.pid;
    const backendPid = this.proc.pid;
    if (!bridgePid || !backendPid) return;
    // Inline script: poll bridge liveness, kill backend group on bridge death.
    const script = `
      const bridgePid = ${bridgePid};
      const backendPid = ${backendPid};
      const tick = () => {
        // Bridge gone? → reap the whole backend process group, then exit.
        try { process.kill(bridgePid, 0); }
        catch {
          try { process.kill(-backendPid, 'SIGKILL'); } catch {}
          process.exit(0);
        }
        // backend already exited? → watchdog has no job left.
        try { process.kill(-backendPid, 0); }
        catch { process.exit(0); }
      };
      setInterval(tick, 2000);
      tick();
    `;
    this.watchdog = spawn(process.execPath, ["-e", script], {
      stdio: "ignore",
      detached: true, // own process group, not part of the backend group
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
      // Response (id, no method) → resolve pending request. A late reply to a
      // fire-and-forget send has no pending entry and is safely dropped.
      this.resolvePending(id as number, msg as unknown as ZcodeResponse);
      return;
    }
    if (id !== undefined && method !== undefined) {
      // Direction is structural, not determined by a colliding request ID.
      // Late or mismatched response-shaped frames must never become requests.
      if ("result" in msg || "error" in msg) {
        if (this.pending.get(id as number)?.method === method) {
          this.resolvePending(id as number, msg as unknown as ZcodeResponse);
        }
      } else {
        const req: ServerRequest = {
          id,
          method,
          params: (msg.params ?? {}) as ServerRequest["params"],
        };
        if (!this.handleServerRequest(req)) {
          this.serverRequests.push(req);
        }
      }
      return;
    }
    if (method !== undefined) {
      // Notification — dialect-specific routing.
      this.handleNotification(method, (msg.params ?? {}) as Record<string, unknown>);
    }
  }

  /** Deliver a backend event to every listener registered for its session. */
  protected dispatchEvent(ev: ZcodeEvent): void {
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

  protected markReaderDead(reason: string, code = "native_backend_dead"): void {
    if (this.readerDead) return;
    this.readerDead = true;
    warn(`backend: reader exited (${reason})`);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({
        id,
        error: {
          code,
          message: `${this.name} backend reader exited (backend dead)`,
          data: { method: p.method, reason },
        },
      });
    }
    this.pending.clear();
  }

  // ---------- dialect hooks ----------

  /** Route an inbound notification. Unhandled methods are ignored. */
  protected abstract handleNotification(method: string, params: Record<string, unknown>): void;

  /**
   * Intercept an unmatched server→client request before it queues. Return
   * true when consumed (e.g. a handshake auto-reply, or an arrival-time
   * responder) so the original never reaches the interaction queue verbatim.
   */
  protected handleServerRequest(_req: ServerRequest): boolean {
    return false;
  }

  /** Adapt an outbound frame to the backend's wire dialect. */
  protected decorateOutbound(msg: Record<string, unknown>): Record<string, unknown> {
    return msg;
  }

  // ---------- listeners / server requests ----------

  registerEventListener(sessionId: string, listener: EventListener): void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
  }

  unregisterEventListener(sessionId: string, listener: EventListener): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(sessionId);
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

  /** Reply to a backend server→client request with a result (id + result). */
  sendReply(id: number | string, result: unknown): void {
    this.writeFrame({ id, result });
  }

  /** Reply to a backend server→client request with an error. */
  sendError(id: number | string, code: number, message: string): void {
    this.writeFrame({ id, error: { code, message } });
  }

  // ---------- send / request ----------

  /** Fire-and-forget notification to the backend (no id, no response). */
  notify(method: string, params?: Record<string, unknown>): void {
    this.writeFrame({ method, params });
  }

  /**
   * Send a message with an id but WITHOUT registering a pending response
   * (fire-and-forget). Some backends route by id presence, so carrying an id
   * is more robust than a bare notify. If the backend replies, the reader's
   * `resolvePending` finds no pending entry and safely discards it.
   */
  send(method: string, params?: Record<string, unknown>): void {
    this.writeFrame({ id: this.sendIdCounter++, method, params: params ?? {} });
  }

  private writeFrame(msg: Record<string, unknown>): void {
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      warn("backend: frame dropped (stdin closed)");
      return;
    }
    // Write errors (EPIPE) are delivered via the stdin 'error' listener
    // installed in the constructor (synchronous try/catch cannot catch them);
    // no try/catch needed here.
    stdin.write(JSON.stringify(this.decorateOutbound(msg)) + "\n");
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
          message: `${this.name} backend reader exited (backend dead)`,
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
      // Fast-fail a closed pipe BEFORE the pending wait: writeFrame only
      // warns and drops (fire-and-forget semantics), which would leave this
      // request hanging until timeoutMs with readerDead unset.
      const stdin = this.proc.stdin;
      if (!stdin || stdin.destroyed) throw new Error("stdin closed");
      this.writeFrame({ id, method, params: params ?? {} });
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
