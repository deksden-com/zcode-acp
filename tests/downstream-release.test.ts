import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
// @ts-expect-error The release helper is a standalone Node ESM script.
import { assertChangedInputs, assertContractInputs, contractDescriptor, prepareBuildOutput, prepareOutput, validateSelection, verificationJobs } from "../scripts/downstream-release.mjs";

const selection = () => ({
  schema_id: "dd-zcode/release-selection@2",
  base: "a".repeat(40),
  required_contracts: [{
    id: "native-harness",
    inputs: ["src/handlers/harness.ts"],
    dependency_inputs: ["pnpm-lock.yaml"],
    tests: ["tests/dd-harness.test.ts"],
    reasons: ["Changed native inspection contract"],
    execution_class: "isolated",
    requires_build: false,
  }],
});

it("cleans only owned dist before building and rejects output aliases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-clean-build-"));
  try {
    const source = path.join(root, "source");
    const neighbor = path.join(root, "neighbor");
    await mkdir(path.join(source, "dist"), { recursive: true });
    await mkdir(neighbor);
    await writeFile(path.join(source, "dist", "deleted-source.js"), "obsolete payload");
    await writeFile(path.join(neighbor, "retained.js"), "retained evidence");
    await prepareBuildOutput(source);
    expect(existsSync(path.join(source, "dist"))).toBe(false);
    expect(await readFile(path.join(neighbor, "retained.js"), "utf8")).toBe("retained evidence");
    await symlink(neighbor, path.join(source, "dist"), "dir");
    await expect(prepareBuildOutput(source)).rejects.toThrow("owned real directory");
    expect(await readFile(path.join(neighbor, "retained.js"), "utf8")).toBe("retained evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("recomputes consumed inputs before reusing or publishing a contract receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-contract-inputs-"));
  try {
    const contract = selection().required_contracts[0];
    for (const directory of ["src/handlers", "tests"]) await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1", devDependencies: { vitest: "2", typescript: "5" } }));
    await writeFile(path.join(root, contract.inputs[0]), "original runtime");
    await writeFile(path.join(root, contract.tests[0]), "test placeholder");
    const descriptor = await contractDescriptor(contract, root);
    await expect(assertContractInputs(descriptor, root)).resolves.toBeUndefined();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2", devDependencies: { vitest: "2", typescript: "5" } }));
    await expect(assertContractInputs(descriptor, root)).resolves.toBeUndefined();
    await writeFile(path.join(root, contract.inputs[0]), "changed runtime while test was running");
    await expect(assertContractInputs(descriptor, root)).rejects.toThrow("consumed inputs changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("honors only the one/two-job fallback and preserves existing or aliased output attempts", async () => {
  expect(verificationJobs("1")).toBe(1);
  expect(verificationJobs("2")).toBe(2);
  for (const value of ["0", "3", "", "1.0"]) expect(() => verificationJobs(value)).toThrow();
  const root = await mkdtemp(path.join(tmpdir(), "bridge-output-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    const alias = path.join(root, "alias");
    await symlink(source, alias, "dir");
    await expect(prepareOutput(path.join(alias, "archive"), source)).rejects.toThrow("outside");
    expect(existsSync(path.join(source, "archive"))).toBe(false);
    const output = path.join(root, "output");
    expect(await prepareOutput(output, source)).toBe(path.join(await realpath(root), "output"));
    await writeFile(path.join(output, "previous-receipt.json"), "retained attempt");
    await expect(prepareOutput(output, source)).rejects.toThrow("nonempty");
    expect(await readFile(path.join(output, "previous-receipt.json"), "utf8")).toBe("retained attempt");
    const outputAlias = path.join(root, "output-alias");
    await symlink(output, outputAlias, "dir");
    await expect(prepareOutput(outputAlias, source)).rejects.toThrow("symlink");
    await expect(prepareOutput(path.join(root, "missing-parent", "archive"), source)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("blocks unmapped executable helpers and consumed package declarations, not version-only metadata", () => {
  const empty = { ...selection(), required_contracts: [] };
  for (const file of ["scripts/new-runner.mjs", "tools/new-helper.mjs", "src/new-consumer.ts"]) {
    expect(() => assertChangedInputs(empty, [file], {}, {})).toThrow(file);
  }
  expect(() => assertChangedInputs(empty, ["package.json"], { version: "2" }, { version: "1" })).not.toThrow();
  for (const declarations of [{ scripts: { test: "other-runner" } }, { dependencies: { ws: "new" } }, { bin: "other.js" }]) {
    expect(() => assertChangedInputs(empty, ["package.json"], declarations, {})).toThrow("consumed declarations");
  }
  const declared = selection();
  declared.required_contracts[0].inputs.push("scripts/new-runner.mjs", "package.json");
  expect(() => assertChangedInputs(declared, ["scripts/new-runner.mjs", "package.json"], { scripts: { build: "tsc" } }, {})).not.toThrow();
});

it("requires exact reviewed tests, input closure and immutable upstream base", () => {
  expect(validateSelection(selection()).required_contracts).toHaveLength(1);
  for (const change of [
    { tests: ["tests/*.test.ts"] },
    { inputs: [] },
    { dependency_inputs: [] },
    { reasons: [] },
    { execution_class: "unknown" },
    { requires_build: undefined },
  ]) {
    const value = selection();
    Object.assign(value.required_contracts[0], change);
    expect(() => validateSelection(value)).toThrow();
  }
  expect(() => validateSelection({ ...selection(), base: "HEAD" })).toThrow();
  expect(() => validateSelection({ ...selection(), schema_id: "unknown" })).toThrow();
});

it("downstream delivery suppresses upstream test and hub-notification lifecycle hooks", () => {
  const source = (name: string) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");
  const pack = source("downstream-pack.mjs");
  const install = source("downstream-delivery-smoke.mjs");
  expect(pack).toContain('["pack", "--ignore-scripts"');
  expect(install).toContain('"--ignore-scripts"');
  expect(source("downstream-release.mjs")).not.toMatch(/args: \["run", "test"\]/);
  expect(install).toContain('"--dd-harness-commit"');
});

it("packs and reads back an offline installed archive without running package lifecycle hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-offline-delivery-"));
  const fixture = path.join(root, "package");
  const output = path.join(root, "artifacts");
  const markers = path.join(root, "lifecycle");
  const readbacks = path.join(root, "installed-readbacks.jsonl");
  const version = "0.0.0-offline-fixture";
  const commit = "b".repeat(40);
  const run = promisify(execFile);
  try {
    await mkdir(path.join(fixture, "dist"), { recursive: true });
    await mkdir(output); await mkdir(markers);
    await writeFile(path.join(root, "user.npmrc"), "");
    await writeFile(path.join(root, "global.npmrc"), "");
    await writeFile(path.join(fixture, "package.json"), JSON.stringify({
      name: "zcode-acp-server", version, type: "module", main: "dist/index.js",
      bin: { "zcode-acp": "dist/cli.js" }, files: ["dist", "lifecycle.cjs"],
      scripts: { prepack: "node lifecycle.cjs", prepublishOnly: "node lifecycle.cjs", postinstall: "node lifecycle.cjs" },
    }));
    await writeFile(path.join(fixture, "lifecycle.cjs"),
      "require('node:fs').writeFileSync(require('node:path').join(process.env.BRIDGE_LIFECYCLE_MARKERS, process.env.npm_lifecycle_event), 'unexpected hook');\n");
    await writeFile(path.join(fixture, "dist/constants.js"),
      `export const contract = "dd-zcode-harness@2"; export const commit = ${JSON.stringify(commit)};\n`);
    await writeFile(path.join(fixture, "dist/index.js"), "export { contract, commit } from './constants.js';\n");
    await writeFile(path.join(fixture, "dist/dd-harness-build.json"), JSON.stringify({ source_commit: commit, upstream_version: version, dirty: false }));
    await writeFile(path.join(fixture, "dist/code-fingerprint.json"), JSON.stringify({ fingerprint: "offline-fixture", fileCount: 3 }));
    await writeFile(path.join(fixture, "dist/cli.js"), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contract, commit } from "./constants.js";
const build = JSON.parse(readFileSync(new URL("./dd-harness-build.json", import.meta.url), "utf8"));
const code = JSON.parse(readFileSync(new URL("./code-fingerprint.json", import.meta.url), "utf8"));
if (build.source_commit !== commit || code.fingerprint !== "offline-fixture") throw new Error("Installed metadata mismatch");
const flag = process.argv[2];
if (!["--dd-harness-version", "--dd-harness-commit"].includes(flag)) throw new Error("No native session allowed in this fixture");
appendFileSync(process.env.BRIDGE_INSTALLED_READBACKS, JSON.stringify({ flag, contract, commit, version: build.upstream_version, cli: fileURLToPath(import.meta.url) }) + "\\n");
process.stdout.write((flag === "--dd-harness-version" ? contract : commit) + "\\n");
`);
    const env = { ...process.env, npm_config_offline: "true", npm_config_cache: path.join(root, "npm-cache"),
      npm_config_userconfig: path.join(root, "user.npmrc"), npm_config_globalconfig: path.join(root, "global.npmrc"),
      npm_config_registry: "http://127.0.0.1:1", npm_config_audit: "false", npm_config_fund: "false",
      BRIDGE_LIFECYCLE_MARKERS: markers, BRIDGE_INSTALLED_READBACKS: readbacks };
    const packedReceipt = path.join(output, "pack.json");
    await run(process.execPath, [fileURLToPath(new URL("../scripts/downstream-pack.mjs", import.meta.url)), output, packedReceipt],
      { cwd: fixture, env, timeout: 60_000 });
    const packed = JSON.parse(await readFile(packedReceipt, "utf8"));
    expect(packed).toMatchObject({ package_name: "zcode-acp-server", version, lifecycle_scripts: false });
    expect(packed.sha256).toBe(createHash("sha256").update(await readFile(packed.file)).digest("hex"));
    expect(packed.files).toEqual(expect.arrayContaining(["dist/cli.js", "dist/constants.js", "dist/dd-harness-build.json", "dist/code-fingerprint.json"]));
    await run(process.execPath, [fileURLToPath(new URL("../scripts/downstream-delivery-smoke.mjs", import.meta.url)), packed.file, version, commit],
      { cwd: fixture, env, timeout: 120_000 });
    const installed = (await readFile(readbacks, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(installed.map(item => item.flag)).toEqual(["--dd-harness-version", "--dd-harness-commit"]);
    for (const item of installed) {
      expect(item).toMatchObject({ contract: "dd-zcode-harness@2", commit, version });
      expect(item.cli).toContain(`${path.sep}node_modules${path.sep}zcode-acp-server${path.sep}dist${path.sep}cli.js`);
      expect(item.cli).not.toBe(path.join(fixture, "dist/cli.js"));
    }
    for (const hook of ["prepack", "prepublishOnly", "postinstall"]) expect(existsSync(path.join(markers, hook))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 210_000);
