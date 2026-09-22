import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const packageInfo = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const identity = {
  artifact: "dd-zcode-acp",
  contract: "dd-zcode-harness@2",
  upstream_version: packageInfo.version,
  upstream_commit: git("rev-parse", `v${packageInfo.version}^{commit}`),
  source_commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain", "--untracked-files=normal") !== "",
};
writeFileSync(new URL("dist/dd-harness-build.json", root), `${JSON.stringify(identity, null, 2)}\n`);
