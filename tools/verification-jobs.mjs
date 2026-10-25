// SSOT for the cooperating verification entrypoints. Standalone consumers vendor
// this file byte-for-byte; contract catalogs and report validators stay local.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import process from 'node:process';

const realHome = os.userInfo().homedir; // OS identity, never a fixture's HOME.
const providerCredentials = ['OPENAI_API_KEY','OPENROUTER_API_KEY','OPENAI_DECISIONS_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','XAI_API_KEY','ZAI_API_KEY','NODE_AUTH_TOKEN','NPM_TOKEN','NPM_ACCESS_TOKEN'];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const optional = file => { try { return read(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const blocked = message => Object.assign(new Error(message), { code: 'verification_ownership_unknown' });
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') error.cleanup_error = cleanup; }
    throw error;
  }
}

// Same physical identity fields as EVAL's process-snapshot helper. Observation
// failure is never interpreted as an empty process table.
function snapshot() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat='], {
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, LC_ALL: 'C', TZ: 'UTC' },
  }).trim().split('\n').flatMap(line => {
    const p = line.trim().split(/\s+/);
    return p.length >= 9 ? [{ pid: +p[0], ppid: +p[1], pgid: +p[2], birth: p.slice(3, 8).join(' '), zombie: p[8].startsWith('Z') }] : [];
  });
}
const same = (a, b) => a && b && a.pid === b.pid && a.birth === b.birth && !b.zombie;
function self() {
  const identity = snapshot().find(p => p.pid === process.pid && !p.zombie);
  if (!identity) throw blocked('Cannot establish verification owner identity');
  return identity;
}
function alive(owner, processes = snapshot()) { return same(owner, processes.find(p => p.pid === owner?.pid)); }
function release(lock, owner) {
  // Only one reclaimer can remove this unique fence. A late reclaimer cannot
  // unlink the next owner's record after the directory has been reacquired.
  fs.unlinkSync(path.join(lock, `fence-${owner.token}`));
  fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
}
async function claim(lock, signal) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const identity = self();
  for (;;) {
    signal?.throwIfAborted();
    try {
      fs.mkdirSync(lock);
      const owner = { ...identity, token: randomUUID(), groups: [] };
      fs.writeFileSync(path.join(lock, `fence-${owner.token}`), '', { flag: 'wx' });
      atomicJson(path.join(lock, 'owner.json'), owner);
      return owner;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const owner = optional(path.join(lock, 'owner.json'));
    if (owner) {
      const processes = snapshot();
      if (!alive(owner, processes)) {
        // A dead coordinator is NOT cleanup. A surviving process group keeps
        // the whole lease until its physical absence is positively observed.
        if (!Array.isArray(owner.groups)) throw blocked(`Unconfirmed lease groups: ${lock}`);
        if (!owner.groups.some(g => !g.pgid || processes.some(p => p.pgid === g.pgid && !p.zombie))) {
          // Recheck the immutable owner token before removing its record.
          if (optional(path.join(lock, 'owner.json'))?.token === owner.token) {
            try { release(lock, owner); } catch (e) { if (!['ENOENT', 'ENOTEMPTY'].includes(e.code)) throw e; }
          }
          continue;
        }
      }
    }
    await delay(50, undefined, { signal });
  }
}

/** One immutable producer attempt. The index is scheduling state, not proof;
 * callers must validate the returned report bytes and meaningful inputs. */
export async function withContractAttempt(index, { rerun = false, reason, signal, validate, validationKey } = {}, action) {
  if (rerun && !reason) throw new Error('Explicit rerun requires a reason');
  const lock = `${index}.claim`;
  const initial = optional(index);
  if (initial?.status === 'running' && !rerun) {
    const result = await joinAttempt(initial, signal);
    await validate?.(result.result, initial);
    return result;
  }
  let joined = null;
  const owner = await claim(lock, signal);
  let attempt;
  try {
    const current = optional(index); // Mandatory reread under claim.
    if (current?.status === 'running' && !rerun) { joined = current; }
    else if (current && !rerun) {
      if (current.status !== 'passed') throw blocked(`Retained ${current.status} attempt requires explicit rerun: ${index}`);
      try {
        const terminal = read(current.report);
        if (terminal.attemptId !== current.attemptId || terminal.status !== 'passed') throw new Error('Invalid terminal attempt');
        await validate?.(terminal.result, current);
        return { ...terminal, reused: true, joined: false };
      } catch (error) {
        atomicJson(index, { ...current, status: 'evidence_invalid', reason: String(error.message) });
        reason = `Invalid evidence: ${error.message}`;
      }
    }
    if (!joined) {
      if (current?.status === 'running') throw blocked('Cannot supersede an active producer');
      const attemptId = randomUUID();
      const root = path.join(`${index}.attempts`, attemptId);
      fs.mkdirSync(root, { recursive: true });
      attempt = { attemptId, root, report: path.join(root, 'terminal.json'), owner, status: 'running', reason: reason ?? null, validationKey };
      // Accepted rerun supersedes an old PASS before dispatch.
      atomicJson(index, attempt);
    }
  } finally { release(lock, owner); }
  if (joined) {
    const result = await joinAttempt(joined, signal);
    await validate?.(result.result, joined);
    return result;
  }
  try {
    signal?.throwIfAborted();
    const result = await action({ attemptId: attempt.attemptId, root: attempt.root });
    await validate?.(result, attempt);
    const terminal = { attemptId: attempt.attemptId, result, status: 'passed' };
    atomicJson(attempt.report, terminal);
    atomicJson(index, { ...attempt, status: 'passed' });
    return { ...terminal, reused: false, joined: false };
  } catch (error) {
    const terminal = { attemptId: attempt.attemptId, status: signal?.aborted ? 'interrupted' : 'failed', error: String(error.stack ?? error) };
    atomicJson(attempt.report, terminal);
    atomicJson(index, { ...attempt, status: terminal.status });
    throw error;
  }
}
async function joinAttempt(attempt, signal) {
  for (;;) {
    signal?.throwIfAborted(); // Cancels only this waiter.
    const terminal = optional(attempt.report);
    if (terminal) {
      if (terminal.attemptId !== attempt.attemptId || terminal.status !== 'passed') throw blocked(`Producer attempt did not pass: ${attempt.attemptId}`);
      return { ...terminal, reused: false, joined: true };
    }
    if (!alive(attempt.owner)) throw blocked(`Producer died without terminal evidence: ${attempt.attemptId}`);
    await delay(50, undefined, { signal });
  }
}

function inheritedSlot(env, home) {
  if (!env.DD_FLOW_VERIFICATION_SLOT) return false;
  let context;
  try { context = JSON.parse(env.DD_FLOW_VERIFICATION_SLOT); } catch { throw blocked('Malformed inherited slot'); }
  const owner = optional(path.join(home, 'lease', 'owner.json'));
  const processes = snapshot();
  const group = owner?.groups?.find(g => g.token === context.token);
  let cursor = processes.find(p => p.pid === process.pid);
  const seen = new Set();
  while (cursor && !seen.has(cursor.pid)) {
    if (group && same(group, cursor) && owner.token === context.owner && alive(owner, processes)) return true;
    seen.add(cursor.pid); cursor = processes.find(p => p.pid === cursor.ppid);
  }
  throw blocked('Inherited slot is not owned by an ancestor job');
}

/** FIFO host-wide pool; descriptors are child commands, never callbacks sharing
 * process.env. Exclusive drains both slots; inherited runners use one slot. */
export async function runJobs(jobs, { jobs: budget = 2, signal, env = process.env, coordinationHome } = {}) {
  const queuedAt = Date.now();
  if (![1, 2].includes(budget)) throw new Error('Verification budget must be 1 or 2');
  if (Array.isArray(jobs) && jobs.some(job => job?.credentialKeys !== undefined && (!Array.isArray(job.credentialKeys) || job.credentialKeys.some(name => typeof name !== 'string' || !providerCredentials.includes(name))))) throw new Error('Invalid credential allowlist');
  if (!Array.isArray(jobs) || jobs.some(job=>!job || typeof job.id!=='string' || !job.id || typeof job.command!=='string' || !job.command || job.args && (!Array.isArray(job.args)||job.args.some(arg=>typeof arg!=='string')) || job.executionClass!==undefined && !['isolated','exclusive'].includes(job.executionClass)) || new Set(jobs.map(job=>job.id)).size!==jobs.length) throw new Error('Invalid/duplicate verification job descriptor');
  const home = coordinationHome ?? env.DD_FLOW_VERIFICATION_COORDINATION_HOME ?? path.join(realHome, '.dd-flow', 'verification-coordinator');
  const nested = inheritedSlot(env, home);
  const lock = path.join(home, 'lease');
  const owner = nested ? null : await claim(lock, signal);
  const results = new Array(jobs.length);
  const active = new Set();
  let failure;
  const save = () => { if (owner) atomicJson(path.join(lock, 'owner.json'), owner); };
  const start = (job, index) => {
    if (failure) throw failure;
    const promise = execute(job, { home, owner, signal, env, save, queuedAt }).then(result => { results[index] = result; }, error => { failure ??= error; }).finally(() => active.delete(promise));
    active.add(promise); return promise;
  };
  try {
    for (let i = 0; i < jobs.length; i++) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (jobs[i].executionClass === 'exclusive') { await Promise.all(active); await start(jobs[i], i); }
      else { while (active.size >= (nested ? 1 : budget)) await Promise.race(active); start(jobs[i], i); }
    }
    await Promise.all(active);
    if (failure) throw failure;
    return results;
  } finally {
    await Promise.allSettled(active);
    // Never release a lease after unknown cleanup.
    if (owner && owner.groups.length === 0) release(lock, owner);
  }
}

async function execute(job, { home, owner, signal, env, save, queuedAt }) {
  const started = Date.now();
  const attemptId = randomUUID();
  const root = path.join(home, 'jobs', attemptId);
  fs.mkdirSync(root, { recursive: true });
  const childEnv = { ...env, ...job.env };
  for (const name of providerCredentials) if (!job.credentialKeys?.includes(name)) delete childEnv[name];
  childEnv.DD_FLOW_VERIFICATION_COORDINATION_HOME = home;
  // node:test sets this private flag for its own children; a separately managed
  // test command must produce a standalone report, not use its parent's IPC.
  delete childEnv.NODE_TEST_CONTEXT;
  for (const name of ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'CODEX_HOME', 'AGY_HOME', 'DD_FLOW_HOME', 'DD_FLOW_RESOURCE_HOME', 'DD_FLOW_CONFIG_HOME']) {
    childEnv[name] = path.join(root, name.toLowerCase()); fs.mkdirSync(childEnv[name], { recursive: true });
  }
  // Only an explicit native/delivery descriptor may opt into provider credentials.
  const token = randomUUID();
  if (owner) {
    childEnv.DD_FLOW_VERIFICATION_SLOT = JSON.stringify({ owner: owner.token, token });
    // Unknown spawn outcome must retain the lease after coordinator death.
    owner.groups.push({ token, attemptId, root, pgid: null }); save();
  }
  const child = spawn(job.command, job.args ?? [], { cwd: job.cwd, env: childEnv, stdio: job.stdio ?? 'inherit', detached: Boolean(owner) });
  let spawnError;
  const completion = new Promise(resolve => { child.once('error', error => { spawnError = error; }); child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal })); });
  let identity;
  if (child.pid) identity = snapshot().find(p => p.pid === child.pid);
  if (identity && owner) { identity = { ...identity, token, attemptId, root }; owner.groups = owner.groups.map(g => g.token === token ? identity : g); save(); }
  let cleanupError;
  const stop = (killSignal = 'SIGTERM') => {
    if (!identity) return;
    try {
      const current = snapshot().find(p => p.pid === identity.pid);
      if (same(identity, current)) process.kill(owner ? -identity.pgid : identity.pid, killSignal);
    } catch (error) { if (error.code !== 'ESRCH') cleanupError = error; }
  };
  let forceTimer;
  const cancel = () => { stop(); forceTimer = setTimeout(() => stop('SIGKILL'), 1000); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const result = await completion;
  clearTimeout(forceTimer);
  signal?.removeEventListener('abort', cancel);
  if (cleanupError) throw cleanupError;
  if (identity && owner) {
    for (let n = 0; n < 100 && snapshot().some(p => p.pgid === identity.pgid && !p.zombie); n++) {
      stop(); await delay(50);
    }
    if (snapshot().some(p => p.pgid === identity.pgid && !p.zombie)) throw blocked(`Owned group cleanup unconfirmed: ${identity.pgid}`);
    if (owner) { owner.groups = owner.groups.filter(g => g.token !== token); save(); }
  }
  if (!child.pid && owner) { owner.groups = owner.groups.filter(g => g.token !== token); save(); }
  if (child.pid && !identity) throw blocked(`Spawned process identity unconfirmed: ${child.pid}`);
  if (spawnError) throw spawnError;
  const finished = Date.now();
  const terminal = { id: job.id, attemptId, root, ...result, started_at: new Date(started).toISOString(), finished_at: new Date(finished).toISOString(), queue_ms: started - queuedAt, elapsed_ms: finished - started, status: signal?.aborted ? 'interrupted' : result.code === 0 ? 'passed' : 'failed' };
  atomicJson(path.join(root, 'terminal.json'), terminal);
  return terminal;
}
