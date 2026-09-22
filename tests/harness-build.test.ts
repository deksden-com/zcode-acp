import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("stamps provenance without upstream refs and rejects a stale upstream pin", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-build-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "dist"));
    for (const file of ["scripts/write-harness-build.mjs", "upstream-base.json", "package.json"]) {
      cpSync(new URL(`../${file}`, import.meta.url), join(root, file));
    }
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    expect(git("tag", "--list")).toBe("");
    execFileSync(process.execPath, ["scripts/write-harness-build.mjs"], { cwd: root });
    const identity = JSON.parse(readFileSync(join(root, "dist/dd-harness-build.json"), "utf8"));
    expect(identity).toMatchObject({
      source_commit: git("rev-parse", "HEAD"),
      upstream_commit: "230dcdf74aa021f37dd6d8e69023e7e2a77aed2a",
      dirty: false,
    });
    writeFileSync(
      join(root, "upstream-base.json"),
      JSON.stringify({ version: "0.0.0", commit: identity.upstream_commit }),
    );
    expect(() =>
      execFileSync(process.execPath, ["scripts/write-harness-build.mjs"], {
        cwd: root,
        stdio: "pipe",
      }),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
