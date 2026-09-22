import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const packageInfo = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
// Pin the upstream base independently of fetched refs (CI uses shallow clones).
const upstream = JSON.parse(readFileSync(new URL("upstream-base.json", root), "utf8"));
if (upstream.version !== packageInfo.version || !/^[a-f0-9]{40}$/.test(upstream.commit)) {
  throw new Error("Update upstream-base.json for this upstream package version");
}
const identity = {
  artifact: "dd-zcode-acp",
  contract: "dd-zcode-harness@2",
  upstream_version: packageInfo.version,
  upstream_commit: upstream.commit,
  source_commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain", "--untracked-files=normal") !== "",
};
writeFileSync(
  new URL("dist/dd-harness-build.json", root),
  `${JSON.stringify(identity, null, 2)}\n`,
);
