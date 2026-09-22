# Downstream patch inventory

## Current candidate: upstream v0.46.7

Base: `230dcdf74aa021f37dd6d8e69023e7e2a77aed2a` (`v0.46.7`).
Integration branch: `main`. Contract: `dd-zcode-harness@2`.

- Native inspection/control is isolated in `src/handlers/harness.ts`; registration
  and native tool identity metadata are the small upstream integration points.
- Usage is a native passthrough. Per-request accounting moved to dd-zcode;
  consumers needing the old aggregated fields must use an @2-capable adapter.
- Alias persistence retains the upstream model-choice and workspace guards.
- The old unconditional quiet-window stop patch is removed: upstream now has
  foreground/compaction ownership guards. The consumer owns bounded cancellation
  and explicit native close plus residency/tree verification.
- Native extension errors preserve method, session ID and original error data.
- Build-time identity replaces runtime Git lookup; dirty builds are not
  qualified. The artifact is named dd-zcode-acp in its build receipt. Upstream
  publishing is gated to the upstream repository; fork builds do not notify hubs.

Tests: dd-harness, session-lazy, background tasks, adapter usage and cancellation
regressions, plus upstream CI checks. Native qualification remains a separate
requirement before selecting this tuple for a scored run.

### Native recovery integration (reviewed archive)

The old experiment was reviewed by behavior, not transplanted by file:

| Retained behavior | Implementation / regression | Upstream removal condition |
| --- | --- | --- |
| Bidirectional RPC correlation, causal errors and bounded late observation | `backend/client.ts`, `backend/errors.ts`, `native-recovery.test.ts` | Equivalent routing and serialized errors, including pipe death and late create |
| No duplicate allocation after unknown outcome or restart | `session-allocation.ts`, `ensureRealSession`, native-recovery/session-lazy tests | Native idempotency key or equivalent durable reconciliation |
| No resume replay or model overlay on unknown outcome | Shared error classifier, existing resume single-flight; native-recovery tests | Equivalent outcome-aware native recovery |
| Confirmed close settles only the captured turns, without stop/revival | harness close + PendingTurn flag, native-recovery tests | Equivalent upstream close primitive and turn settlement |
| Cleanup checks process group, not just exited leader | backend close; native-recovery test | Equivalent owned-group teardown |
| Distinguish inferred/failed completion from success | `_meta.zcodeCompletionEvidence`; stale-running-recovery tests | Standard completion-evidence representation |

The adapter decides whether inferred completion is acceptable; the bridge has
no `DD_FLOW_RUNTIME_OWNER` branch. Allocation notifications go only to the
requesting resolve client. Late allocation updates identity, never starts a
listener/model switch/prompt. The response-observation window is bounded to
60 seconds after timeout; unresolved durable intents have no automatic expiry.
Restart or an expired observer cannot prove create had no effect. Do not delete
an unresolved intent to retry: reconcile native identity first. A confirmed
native rejection releases the intent; corrupt records fail closed.

Not retained: obsolete mandatory provider-registry RPC, duplicated upstream
alias/model persistence, bridge-side dd-flow usage aggregation, raw stderr
dumping, unused late-response cache and unlimited late callbacks. Provider and
model compatibility remain upstream-owned. Tests isolate allocation homes.

Original experiment: archive tag `archive/zcode-0.13.1-native-recovery`, commit
`c1d26da`. It is unqualified historical evidence, not an active development
branch. Original dirty checkout files remain untouched. Integration checks do
not substitute for native tuple qualification.

## Historical v0.43.2 overlay

Scope: the committed v0.43.2 overlay, upstream commit
`54acb495c30966f3d22d48ec09bbd749fd2d9475`, overlay head
`8c0a893f3c26a0b96cb138acf762db84c800298b` at archive tag
`archive/dd-eval-v0.43.2-overlay` (formerly branch `dd-eval/v0.43.2-overlay`).
This is a historical source baseline, not a declaration that any checkout or
installed binary is qualified. Uncommitted changes in the older main checkout
are outside this inventory and must be reviewed separately before inclusion.

| Overlay commit | Purpose and reason for bridge placement | Checks / removal condition |
| --- | --- | --- |
| `dbcf6d3` | Expose harness contract and build identity to callers. | Identity CLI and dd-harness checks; replace when upstream exposes equivalent identity/capabilities. |
| `622faa3` | Expose native session resolution, read, subagents and usage evidence unavailable through standard ACP. | `tests/dd-harness.test.ts`; remove individual extensions when upstream offers equivalent data and semantics. |
| `2cb9999` | Persist native-session/workspace aliases across bridge processes. | dd-harness session resolution tests; remove when upstream preserves equivalent routing. |
| `f08f74d` | Handle background completion at the bridge's prompt/turn boundary. | `tests/background-tasks.test.ts` and session turn tests; remove when upstream completion semantics cover the same cases. |
| `5939247` | Expose per-request usage and stable native identity. Usage aggregation currently remains in the bridge. | dd-harness usage tests; move aggregation to the consumer only once raw facts are available without losing detail. |
| `027748a` | Provide close/residency checks without implicitly resuming the session being inspected. | dd-harness close/resident tests; replace with equivalent upstream primitives. |
| `8c0a893` | Read retained subagent evidence without reviving closed native sessions. | dd-harness retained-subagent tests; replace when upstream exposes the same side-effect-free read. |

The desired boundary is native facts/control in the bridge and consumer policy
in the adapter. The existing usage projection and background-turn handling
require explicit review when reducing the patch set; documentation does not
mean that this migration has already happened. Backend protocol errors must
retain method, native code and causal details; translating them into consumer
outcomes belongs to the consumer.

Use Git commits as the patch source of truth, not a second maintained set of
patch files. Every new patch needs its purpose, test and deletion condition here.
Propose generally useful fixes upstream and remove our equivalent only after
the replacement passes its regression checks.
