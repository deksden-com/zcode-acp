/**
 * Session-scoped `session.titleUpdated` listener (app-server 0.16.5; observed
 * live + schema-verified against the 3.12.3 desktop bundle, 2026-09-18).
 *
 * The backend pushes authoritative conversation-title changes:
 *
 *   { previousTitle, source: "default" | "first_input" | "generated" |
 *     "custom", title, messageID? }
 *
 * The bridge seeds a PROVISIONAL title from the first prompt (session.ts
 * set-once gate) and never consumed the backend's GENERATED title — the title
 * that lands after the first turn ends — so tabs, remote lists, and the
 * tasks-index kept the truncated prompt line forever. This listener adopts
 * the authoritative pushes:
 *
 *   - `generated` — the backend's LLM-generated title; replaces the
 *     provisional seed. A manual user rename still wins: sessions marked in
 *     `server.titleUserSetBy` (the remote rename endpoint marks them) are
 *     left untouched, and the durable `title_overridden` flag in
 *     tasks-index.sqlite is consulted for renames that predate this bridge
 *     process (the in-memory pin does not survive a restart).
 *   - `custom` — a title set by another surface (the desktop app over the
 *     same session store); adopted so every window stays consistent, and
 *     marked user-set so later `generated` pushes cannot override it.
 *   - `default` / `first_input` — nothing to adopt (the bridge already seeds
 *     the first_input form itself from the prompt text).
 *
 * Alias semantics: clients can hold DIFFERENT acpSids for one backend
 * conversation (`server.sessionAliases`) — the pin check, the title maps, and
 * the `session_info_update` broadcast all run over the FULL alias list, never
 * a single last-write-wins id.
 *
 * Best-effort throughout: failures are logged and never thrown into the
 * event loop.
 */

import type { EventListener } from "../backend/client.js";
import type { ZcodeEvent } from "../backend/types.js";
import { isTitleOverridden, updateSessionTitle } from "../tasks-index.js";
import { refreshTerminalTabTitle } from "../terminal-title.js";
import type { ZcodeAcpServer } from "../server.js";
import { log } from "../utils.js";
import { sendSessionUpdate } from "./io.js";

/** Payload of a `session.titleUpdated` event (schema-verified, see above). */
interface TitleUpdatedPayload {
  source?: unknown;
  title?: unknown;
  previousTitle?: unknown;
  messageID?: unknown;
}

/** Mirror the auto-title/rename normalization: single line, trimmed, 80 chars. */
function normalizeTitle(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 80);
}

export class SessionTitleListener implements EventListener {
  private readonly server: ZcodeAcpServer;
  readonly zcodeSid: string;

  constructor(server: ZcodeAcpServer, zcodeSid: string) {
    this.server = server;
    this.zcodeSid = zcodeSid;
  }

  handleEvent(event: ZcodeEvent): void {
    if (event.type !== "session.titleUpdated") return;
    // Async: the durable-pin consult reads sqlite. Title pushes are rare, so
    // the (bounded) await before adopting is fine; every failure path logs.
    void this.onTitleUpdated(event.payload as TitleUpdatedPayload).catch((e) =>
      log(
        `SessionTitleListener: title update failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  private async onTitleUpdated(p: TitleUpdatedPayload): Promise<void> {
    const source = p.source;
    if (source !== "generated" && source !== "custom") return;
    if (typeof p.title !== "string") return;
    const title = normalizeTitle(p.title);
    if (!title) return;

    const primary = this.server.resolveAcpSid(this.zcodeSid);
    if (!primary) return; // no ACP alias attached yet — nothing to update
    const aliases = this.server.sessionAliases(primary);

    // A manual rename is the strongest title intent; a generated push must
    // not override it. The in-memory pin covers renames made through THIS
    // bridge; the durable tasks-index flag covers renames that predate the
    // process (a restart wipes the memory pin, `title_overridden` does not).
    let userPinned = aliases.some((sid) => this.server.titleUserSetBy.has(sid));
    if (!userPinned && source === "generated") {
      try {
        if (await isTitleOverridden(this.zcodeSid)) {
          userPinned = true;
          for (const sid of aliases) this.server.titleUserSetBy.add(sid);
        }
      } catch {
        // Best-effort consult — fall through and adopt.
      }
    }
    if (userPinned && source === "generated") return;
    // A `custom` push IS a manual rename (from another surface) — adopt and
    // pin it against later generated pushes.
    if (source === "custom") {
      for (const sid of aliases) this.server.titleUserSetBy.add(sid);
    }

    if (aliases.every((sid) => this.server.sessionTitles.get(sid) === title)) return;

    for (const sid of aliases) {
      this.server.sessionTitles.set(sid, title);
      this.server.touchSessionSummary(sid, title);
      refreshTerminalTabTitle(this.server, sid);
    }
    void updateSessionTitle(this.zcodeSid, title, title).catch((e) =>
      log(
        `SessionTitleListener: tasks-index persist failed (non-fatal): ${
          e instanceof Error ? e.message : String(e)
        }`,
      ),
    );
    // session_info_update per alias: clients route by the payload sessionId,
    // so a client holding a different alias would drop a single-id emit.
    for (const sid of aliases) {
      void sendSessionUpdate(this.server.clients.broadcast(), sid, {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date().toISOString(),
      }).catch((e) =>
        log(
          `SessionTitleListener: session_info_update broadcast failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
    }
    log(`  [title] adopted backend title (${source}): "${title}"`);
  }
}
