import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson } from "../tools/verification-jobs.mjs";

const [output, receipt] = process.argv.slice(2);
const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], { encoding: "utf8" }));
const files = packed.files.map(item => item.path);
for (const required of ["package.json", "dist/cli.js", "dist/index.js", "dist/dd-harness-build.json", "dist/code-fingerprint.json"]) {
  if (!files.includes(required)) throw new Error(`Missing production payload: ${required}`);
}
if (files.some(file => /(^|\/)\.env($|\.)|\.(pem|key)$|(^|\/)(credentials|auth)\.json$/.test(file))) throw new Error("Potential secret in archive payload");
const file = path.resolve(output, packed.filename);
await atomicJson(receipt, { file, sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
  package_name: packed.name, version: packed.version, files, lifecycle_scripts: false });
