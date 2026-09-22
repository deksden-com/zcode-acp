# Downstream patch inventory

## Current candidate: upstream v0.46.7

Base: `230dcdf74aa021f37dd6d8e69023e7e2a77aed2a` (`v0.46.7`).
Branch: `upgrade/zcode-acp-0.46.7`. Contract: `dd-zcode-harness@2`.

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

### Older uncommitted changes

The old main checkout contains independent experiments: backend timeout/late
allocation reconciliation, causal errors, lazy allocation persistence, provider
registry synchronization, model readback and related tests. They are not silently
included in this upgrade. Upstream now owns provider/model synchronization;
extension causal error preservation is implemented in harness.ts. The larger
late-allocation recovery experiment needs its own behavioral qualification and
must not replace current upstream session mechanics by file overwrite. Preserve
that work separately for review; it is not part of the @2 contract.

Preserved snapshot: `archive/zcode-0.13.1-native-recovery`, commit `c1d26da`.
It is explicitly unqualified. Original checkout files were not overwritten.

## Historical v0.43.2 overlay

Scope: the committed v0.43.2 overlay, upstream commit
`54acb495c30966f3d22d48ec09bbd749fd2d9475`, overlay head
`8c0a893f3c26a0b96cb138acf762db84c800298b` on `dd-eval/v0.43.2-overlay`.
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
