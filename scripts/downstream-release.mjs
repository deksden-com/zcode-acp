#!/usr/bin/env node
// Explicit downstream archive preparation. Never calls npm publish or lifecycle hooks.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, runJobs, withContractAttempt } from "../tools/verification-jobs.mjs";

const repository = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const digest = value => createHash("sha256").update(value).digest("hex");
const hash = value => digest(JSON.stringify(value));
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const consumedPackage = value => Object.fromEntries(["name", "type", "bin", "main", "types", "files", "exports", "imports", "scripts", "dependencies", "peerDependencies", "optionalDependencies", "engines", "devDependencies"]
  .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

export function verificationJobs(value = process.env.DD_FLOW_VERIFICATION_JOBS ?? "2") {
  assert(value === "1" || value === "2", "DD_FLOW_VERIFICATION_JOBS must be 1 or 2");
  return Number(value);
}

export async function prepareOutput(output, sourceRoot = repository) {
  const requested = path.resolve(output);
  // Resolve an existing parent before creation, so aliases cannot hide a path
  // inside the checkout. Keep all subsequent writes on that canonical path.
  const parent = await realpath(path.dirname(requested));
  const source = await realpath(sourceRoot);
  const canonical = path.join(parent, path.basename(requested));
  assert(canonical !== source && !canonical.startsWith(`${source}${path.sep}`), "Keep release artifacts outside the source checkout");
  let existing;
  try { existing = await lstat(canonical); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    assert(existing.isDirectory() && !existing.isSymbolicLink(), "Release output must be a real directory, not a symlink");
    assert((await readdir(canonical)).length === 0, "Release output is nonempty; preserve the prior attempt and choose a new directory");
  } else await mkdir(canonical);
  return canonical;
}

export function assertChangedInputs(selection, changed, currentPackage, basePackage) {
  const claimed = new Set(selection.required_contracts.flatMap(contract => [...contract.inputs, ...contract.tests, ...contract.dependency_inputs]));
  for (const file of changed.filter(file => /^(src\/|assets\/|tests\/|scripts\/|tools\/)|^(pnpm-lock.yaml|tsconfig.json|vitest.config.ts)$/.test(file))) {
    assert(claimed.has(file), `Unknown changed bridge input: ${file}`);
  }
  if (changed.includes("package.json") && hash(consumedPackage(currentPackage)) !== hash(consumedPackage(basePackage))) {
    assert(claimed.has("package.json"), "Unknown changed bridge input: package.json (consumed declarations)");
  }
}

async function inventory(root, names) {
  return Promise.all([...new Set(names)].sort().map(async name => {
    assert(typeof name === "string" && name !== "" && !path.isAbsolute(name)
      && !name.split(/[\\/]/).includes(".."), `Invalid input path: ${name}`);
    const full = path.join(root, name);
    try {
      const stat = await lstat(full);
      assert(stat.isFile(), `Input must be a regular file: ${name}`);
      assert((await realpath(full)).startsWith(`${await realpath(root)}${path.sep}`), `Input escaped root: ${name}`);
      const bytes = await readFile(full);
      return { path: name, sha256: name === "package.json" ? hash(consumedPackage(JSON.parse(bytes))) : digest(bytes), mode: stat.mode & 0o777 };
    } catch (error) {
      if (error.code === "ENOENT") return { path: name, missing: true };
      throw error;
    }
  }));
}

export function validateSelection(selection) {
  assert(selection?.schema_id === "dd-zcode/release-selection@2", "Unknown bridge selection schema");
  assert(/^[a-f0-9]{40}$/.test(selection.base ?? ""), "Selection requires an immutable upstream base");
  assert(Array.isArray(selection.required_contracts), "Selection requires reviewed contracts");
  const ids = new Set();
  for (const contract of selection.required_contracts) {
    assert(/^[a-z][a-z0-9-]+$/.test(contract.id ?? "") && !ids.has(contract.id), "Invalid/duplicate contract ID");
    ids.add(contract.id);
    assert(Array.isArray(contract.inputs) && contract.inputs.length > 0, `${contract.id}: exact input closure required`);
    assert(Array.isArray(contract.tests) && contract.tests.length > 0 && contract.tests.every(file => /^tests\/[a-zA-Z0-9_-]+\.test\.ts$/.test(file)), `${contract.id}: exact test files required`);
    assert(Array.isArray(contract.reasons) && contract.reasons.length > 0, `${contract.id}: selection reasons required`);
    assert(["isolated", "exclusive"].includes(contract.execution_class), `${contract.id}: execution class required`);
    assert(typeof contract.requires_build === "boolean", `${contract.id}: declare compiled-input consumption`);
    assert(Array.isArray(contract.dependency_inputs) && contract.dependency_inputs.length > 0, `${contract.id}: reviewed dependency closure required`);
  }
  return selection;
}

export async function prepareBuildOutput(sourceRoot = repository) {
  const root = await realpath(sourceRoot);
  const output = path.join(root, "dist");
  try {
    const existing = await lstat(output);
    assert(existing.isDirectory() && !existing.isSymbolicLink() && await realpath(output) === output, "Build output must be an owned real directory");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  // tsc overwrites files but never removes JS from deleted/renamed sources.
  await rm(output, { recursive: true, force: true });
}

export async function contractDescriptor(contract, root = repository) {
  const packageInfo = await readJson(path.join(root, "package.json"));
  const common = ["vitest.config.ts", "tests/setup/hermetic-home.ts", "tsconfig.json"];
  const inputs = await inventory(root, [...contract.inputs, ...contract.tests, ...contract.dependency_inputs, ...common,
    ...(contract.requires_build ? ["dist/code-fingerprint.json"] : [])]);
  assert(contract.tests.every(file => !inputs.find(input => input.path === file)?.missing), `${contract.id}: selected test is missing`);
  const declaration = { id: contract.id, inputs: contract.inputs, tests: contract.tests, dependency_inputs: contract.dependency_inputs, execution_class: contract.execution_class, requires_build: contract.requires_build };
  return { contract, inputs, execution_key: hash({ declaration, inputs, toolchain: { node: process.version, platform: process.platform, arch: process.arch },
    runner: { vitest: packageInfo.devDependencies.vitest, typescript: packageInfo.devDependencies.typescript }, dependencies: packageInfo.dependencies, peers: packageInfo.peerDependencies }),
    validation_key: "dd-zcode/vitest-json-complete@2" };
}

export async function assertContractInputs(descriptor, root = repository) {
  const current = await contractDescriptor(descriptor.contract, root);
  assert(current.execution_key === descriptor.execution_key && JSON.stringify(current.inputs) === JSON.stringify(descriptor.inputs), `${descriptor.contract.id}: consumed inputs changed`);
}

async function verifyContract(descriptor, { jobs = 1, signal, sourceCommit } = {}) {
  const { contract, execution_key, validation_key } = descriptor;
  const index = path.join(os.userInfo().homedir, ".dd-flow", "bridge-verification", `${contract.id}-${execution_key}.json`);
  await mkdir(path.dirname(index), { recursive: true });
  const assertCurrent = async () => {
    assert(git("rev-parse", "HEAD") === sourceCommit && git("status", "--porcelain", "--untracked-files=normal") === "", `${contract.id}: frozen source changed`);
    await assertContractInputs(descriptor);
  };
  const validate = async retained => {
    await assertCurrent();
    assert(retained?.schema_id === "dd-zcode/contract-receipt@2" && retained.execution_key === execution_key
      && retained.validation_key === validation_key && retained.status === "PASS"
      && digest(await readFile(retained.report)) === retained.report_sha256, `${contract.id}: invalid retained proof`);
    const result = await readJson(retained.report);
    assert(result.success === true && result.numTotalTests > 0 && result.numFailedTests === 0
      && result.numPendingTests === 0 && result.numTodoTests === 0, `${contract.id}: incomplete retained inventory`);
    const actual = result.testResults.map(item => `tests/${path.basename(item.name)}`).sort();
    assert(JSON.stringify(actual) === JSON.stringify([...contract.tests].sort()) && JSON.stringify(retained.tests) === JSON.stringify(actual), `${contract.id}: retained file inventory differs`);
    assert(result.testResults.every(item => item.status === "passed" && item.assertionResults.length > 0
      && item.assertionResults.every(item => item.status === "passed")), `${contract.id}: incomplete retained cases`);
  };
  const proof = await withContractAttempt(index, { signal, validate, validationKey: validation_key }, async ({ root, attemptId }) => {
    await assertCurrent();
    const report = path.join(root, "vitest.json");
    const [job] = await runJobs([{ id: contract.id, command: "pnpm", cwd: repository,
      args: ["exec", "vitest", "run", ...contract.tests, "--reporter=json", `--outputFile=${report}`, "--maxWorkers=1", "--minWorkers=1", "--fileParallelism=false"],
      executionClass: contract.execution_class }], { jobs, signal });
    assert(job.status === "passed" && job.code === 0, `${contract.id}: verification ${job.status}`);
    const result = await readJson(report);
    assert(result.success === true && result.numTotalTests > 0 && result.numFailedTests === 0
      && result.numPendingTests === 0 && result.numTodoTests === 0, `${contract.id}: incomplete or failed test inventory`);
    const actual = result.testResults.map(item => path.relative(repository, item.name)).sort();
    assert(JSON.stringify(actual) === JSON.stringify([...contract.tests].sort()), `${contract.id}: report file inventory differs`);
    assert(result.testResults.every(item => item.status === "passed" && item.assertionResults.length > 0
      && item.assertionResults.every(item => item.status === "passed")), `${contract.id}: nonpassing selected cases`);
    return { schema_id: "dd-zcode/contract-receipt@2", execution_key, validation_key, attempt_id: attemptId,
      inputs: descriptor.inputs, tests: actual, cases: result.numTotalTests, report, report_sha256: digest(await readFile(report)), status: "PASS" };
  });
  await validate(proof.result);
  return { contract: contract.id, outcome: proof.reused || proof.joined ? "reused" : "executed", ...proof.result };
}

export async function prepareDownstream({ selectionFile, output, jobs = verificationJobs(), signal }) {
  const selection = validateSelection(await readJson(selectionFile));
  const upstream = await readJson(path.join(repository, "upstream-base.json"));
  assert(selection.base === upstream.commit, "Selection must cover the pinned upstream base, not HEAD or a previous PASS");
  assert(git("status", "--porcelain", "--untracked-files=normal") === "", "Release preparation requires clean committed sources");
  const sourceCommit = git("rev-parse", "HEAD");
  const assertFrozen = () => assert(git("rev-parse", "HEAD") === sourceCommit
    && git("status", "--porcelain", "--untracked-files=normal") === "", "Source changed during release preparation");
  output = await prepareOutput(output);
  const packageInfo = await readJson(path.join(repository, "package.json"));
  assert(packageInfo.version === upstream.version, "Upstream version differs from committed pin");
  const changed = git("diff", "--name-only", "--no-renames", selection.base, "HEAD").split("\n").filter(Boolean);
  assertChangedInputs(selection, changed, packageInfo, JSON.parse(git("show", `${selection.base}:package.json`)));
  const buildInputs = await inventory(repository, ["package.json", "pnpm-lock.yaml", "tsconfig.json", "upstream-base.json", "scripts/write-harness-build.mjs", "scripts/write-code-fingerprint.mjs", ...git("ls-files", "src", "assets").split("\n").filter(Boolean)]);
  let identity;
  const buildOnce = async () => {
    if (identity) return;
    assertFrozen();
    const [build] = await runJobs([{ id: "bridge-build", command: process.execPath, args: [fileURLToPath(import.meta.url), "build"], cwd: repository, executionClass: "exclusive" }], { jobs, signal });
    assert(build.code === 0, "Bridge build failed");
    identity = await readJson(path.join(repository, "dist/dd-harness-build.json"));
    assert(identity.upstream_version === upstream.version && identity.upstream_commit === upstream.commit
      && identity.source_commit === sourceCommit && identity.dirty === false, "Build requires clean committed source provenance");
    assertFrozen();
  };
  if (selection.required_contracts.some(contract => contract.requires_build)) await buildOnce();
  const descriptors = await Promise.all(selection.required_contracts.map(contract=>contractDescriptor(contract)));
  const selected = path.join(output, "selection.json");
  await atomicJson(selected, { ...selection, jobs, descriptors, source_commit: sourceCommit });
  const workerJobs = descriptors.map(({ contract }, index) => ({ id: contract.id, command: process.execPath,
    args: [fileURLToPath(import.meta.url), "worker", selected, String(index), path.join(output, `contract-${index}.json`)],
    cwd: repository, executionClass: contract.execution_class }));
  const outcomes = workerJobs.length ? await runJobs(workerJobs, { jobs, signal }) : [];
  assert(outcomes.every(job => job.status === "passed" && job.code === 0), "A required bridge contract did not pass");
  const receipts = await Promise.all(descriptors.map((_descriptor, index) => readJson(path.join(output, `contract-${index}.json`))));
  await buildOnce();
  assertFrozen();
  const packed = path.join(output, "pack.json");
  const [pack] = await runJobs([{ id: "bridge-pack", command: process.execPath,
    args: ["scripts/downstream-pack.mjs", output, packed], cwd: repository, executionClass: "isolated" }], { jobs, signal });
  assert(pack.code === 0, "Bridge archive failed");
  const artifact = await readJson(packed);
  const [smoke] = await runJobs([{ id: "bridge-installed-delivery", command: process.execPath,
    args: ["scripts/downstream-delivery-smoke.mjs", artifact.file, upstream.version, identity.source_commit], cwd: repository, executionClass: "isolated" }], { jobs, signal });
  assert(smoke.code === 0, "Installed bridge delivery failed");
  assertFrozen();
  const receipt = { schema_id: "dd-zcode/downstream-release@2", source_commit: identity.source_commit, upstream,
    requirements: selection.required_contracts, receipts, build: { inputs: buildInputs, identity }, artifact,
    delivery: { status: "PASS", install_scripts: false }, publish: "not_requested" };
  await atomicJson(path.join(output, "release.json"), receipt);
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => controller.abort());
  if (process.argv[2] === "build") {
    assert(process.argv.length === 3, "Build worker accepts no external output path");
    // Cleanup belongs inside the exclusive slot, not before waiting for it.
    await prepareBuildOutput();
    const [built] = await runJobs([{ id: "bridge-build-content", command: "pnpm", args: ["run", "build"], cwd: repository }], { jobs: 1, signal: controller.signal });
    assert(built.status === "passed" && built.code === 0, "Bridge build failed or interrupted");
  } else if (process.argv[2] === "worker") {
    assert(process.argv.length === 6, "Worker requires selection, contract index and receipt output");
    const selected = await readJson(process.argv[3]);
    validateSelection(selected);
    const index = Number(process.argv[4]);
    assert(Number.isSafeInteger(index) && index >= 0 && index < selected.descriptors.length, "Invalid contract index");
    assert(/^[a-f0-9]{40}$/.test(selected.source_commit ?? ""), "Worker requires frozen source identity");
    await atomicJson(process.argv[5], await verifyContract(selected.descriptors[index], { signal: controller.signal, sourceCommit: selected.source_commit }));
  } else {
    assert(process.argv.length === 4, "Usage: node scripts/downstream-release.mjs reviewed-selection.json /absolute/output");
    await prepareDownstream({ selectionFile: process.argv[2], output: process.argv[3], signal: controller.signal });
  }
}
