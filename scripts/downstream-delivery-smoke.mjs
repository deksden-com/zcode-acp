import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const [artifact, version, commit] = process.argv.slice(2);
const prefix = await mkdtemp(path.join(os.tmpdir(), "bridge-delivery-"));
try {
  execFileSync("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", artifact], { stdio: "inherit" });
  const installed = path.join(prefix, "node_modules/zcode-acp-server");
  const packageInfo = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  if (packageInfo.version !== version) throw new Error("Installed upstream version mismatch");
  const cli = path.join(installed, "dist/cli.js");
  for (const [flag, expected] of [["--dd-harness-version", "dd-zcode-harness@2"], ["--dd-harness-commit", commit]]) {
    const actual = execFileSync(process.execPath, [cli, flag], { encoding: "utf8", env: { ...process.env, ZCODE_ACP_REMOTE: "0" } }).trim();
    if (actual !== expected) throw new Error(`Installed ${flag} mismatch: ${actual}`);
  }
} finally {
  await rm(prefix, { recursive: true, force: true });
}
