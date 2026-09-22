# Updating the downstream fork

This document covers only fork maintenance. System qualification belongs to the
[consumer runbook](https://github.com/deksden-com/dd-eval/blob/main/runbooks/update-zcode.md).

## Source and branch rules

Use `origin` for `https://github.com/deksden-com/zcode-acp.git` and `upstream` for
`https://github.com/william0wang/zcode-acp.git`. Verify `git remote -v` before a
fetch or push: older qualification clones may use different remote names.
Keep upstream refs unmodified. A local `upstream` tracking branch, if used,
must fast-forward only and contain no downstream commits. Candidate branches
start at an exact upstream tag; release tags and already qualified commits are
immutable. The existing `dd-eval/v0.43.2-overlay` is one such source baseline.

Our default integration branch is `main`. Use `upgrade/zcode-acp-<version>` for
upstream candidates and short-lived `fix/` or `docs/` branches for downstream
changes. Merge through review after relevant checks pass. Preserve upstream and
patch ancestry with a merge commit for upgrades; inspect the merge result against
the tested candidate and recheck resolution changes. Never force-reset main to
the rebuilt patch stack. Repository protection settings must be configured
separately; these rules do not assert that enforcement is already enabled.

1. Record current upstream base and downstream head, and inspect `git status`.
   Preserve uncommitted changes; use a separate checkout/worktree for upgrades.
2. Fetch upstream and inspect the target release, dependencies and protocol
   changes. Resolve the selected tag to a full commit; never build from a moving
   branch reference. Do not overwrite conflicting local tags.
3. Create a candidate branch from that commit. Review each entry in
   [PATCHES.md](../PATCHES.md), drop patches superseded by upstream and cherry-pick
   the remaining commits in dependency order. Resolve conflicts by checking the
   new upstream behavior, not by accepting the old file wholesale.
4. Update the inventory with the resulting commits and changed contracts.
   Pin the peeled upstream tag in `upstream-base.json`; builds use this committed
   identity rather than depending on tags being available in shallow CI clones.
   Keep transport extensions near the existing extension handlers; avoid
   invasive rewrites of upstream session machinery for consumer-only policy.
5. Use the Node/pnpm versions required by the selected revision. Run
   `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`,
   `pnpm exec vitest run tests/dd-harness.test.ts`, and affected session/turn
   tests. Run the upstream CI-required checks before releasing the candidate.
   Check exact script/test names at that revision. Build may execute upstream
   post-build hooks; run in the isolated candidate environment.
6. Verify `node dist/cli.js --dd-harness-version` and
   `node dist/cli.js --dd-harness-commit` against the intended contract and
   source commit. Build from clean committed sources and retain artifact hashes.
7. Publish a separate candidate ref/artifact. Hand its immutable identity and
   test results to the consumer's qualification process. A successful bridge
   build alone does not make the complete integration supported.

## Artifact identity

Current overlays retain upstream package name/version (`zcode-acp-server`,
`0.46.7` for the current candidate); full downstream commit and artifact checksum
are therefore mandatory. Do not present this artifact as unmodified upstream.
For future separately published packages, use a distinct downstream identity
such as `dd-zcode-acp` and a downstream suffix such as `0.43.2-dd.1`; this policy
does not claim that such a package has already been published or rename current
CLI binaries. Include upstream tag/commit, downstream source commit, extension
contract, lockfile, toolchain and artifact checksum in the release record.

The @2 candidate stamps `dist/dd-harness-build.json` during build and reads its
commit from this receipt, not the surrounding checkout at runtime. Dirty builds
report an unknown commit. Build deliberately omits the upstream hub-notification
step. Upstream release automation is restricted to the upstream repository;
publishing a downstream npm package requires its own explicit release setup.

Do not add evaluation profiles, workflow policy, model configuration or complete
system upgrade instructions to this fork. Link to their owning repositories.
