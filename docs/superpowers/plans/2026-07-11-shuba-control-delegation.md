# shuba-control + Multi-Harness Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `shuba-control` — a sidecar that lets Claude Code delegate a task to another harness CLI (opencode/gemini/qwen/cursor-agent/claude) running on its own provider, via an MCP tool, with async job tracking and hybrid harness/model selection.

**Architecture:** A runtime-agnostic **engine** (job store + classifier + runner) with two adapters on top: a **stdio MCP server** (for Claude Code) and an **HTTP+WS API** (for the Spec 3 console). Delegated CLIs run as child processes; jobs are async (enqueue → poll → result), mirrored durably to `~/.shuba/jobs/`. shuba starts `shuba-control` as a builtin sidecar and auto-registers its MCP entry into Claude Code config.

**Tech Stack:** Bun + TypeScript (Spec 0 foundation, already merged), `@modelcontextprotocol/sdk@^1.29`, `node:child_process`, `node:http`, cheap OpenRouter model (`deepseek/deepseek-v4-flash`) for the classifier — reusing the compact/watchdog pattern.

## Global Constraints

- Bun + TypeScript, `strict: true`; typecheck gate `bun run typecheck` clean; tests `bun test` (node:test/node:assert style, matching the existing suite).
- The engine core (store, classifier, runner) must be runtime-agnostic — NO MCP or HTTP imports in it; the MCP server and HTTP API are thin adapters over it. This is the spec's key boundary (Spec 1 §2).
- `harness` and `model` are independent optional fields on `shuba_delegate`. Explicit value wins; otherwise the classifier decides; otherwise the config `default`.
- Classifier and any cheap-model call go to the OpenRouter base (`https://openrouter.ai/api/v1`, key from `OPENROUTER_API_KEY`), model `deepseek/deepseek-v4-flash` by default — NEVER an Anthropic/Claude model, and never the user's Claude tokens.
- Jobs are async: `shuba_delegate` returns `{job_id, harness_chosen, model_chosen}` immediately; execution continues in the background.
- Durable job mirror at `~/.shuba/jobs/<id>.json` (record) + `<id>.log` (stdout+stderr). Concurrency cap from `delegate.concurrency` (default 3); excess jobs stay `queued`.
- Policy `when` hints are English strings.
- Delegated `claude` harness runs with `--dangerously-skip-permissions` (matches `shuba run`); non-claude harnesses use their own provider env — never inject Anthropic keys into them.
- Isolation per-call: `"none"` (default, runs in project cwd) or `"worktree"` (fresh git worktree, report path+diff, auto-remove if unchanged).
- All new code under `orchestrator/src/control/` and `orchestrator/bin/shuba-control.ts`; tests under `orchestrator/test/`.
- `Date.now()` is available in Bun runtime (this is app code, not a Workflow script) — timestamps are fine; inject a `now`/`clock` for deterministic tests where timing is asserted.

---

### Task 1: Job types + durable job store

**Files:**
- Create: `orchestrator/src/control/types.ts`, `orchestrator/src/control/store.ts`
- Test: `orchestrator/test/control-store.test.ts`

**Interfaces:**
- Produces (`types.ts`):
```ts
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type JobRecord = {
  id: string;
  task: string;
  harness: string;
  model: string | null;
  cwd: string;
  isolation: 'none' | 'worktree';
  status: JobStatus;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  worktreePath?: string;
  error?: string;
};
export type DelegateInput = {
  task: string; harness?: string; model?: string;
  cwd?: string; files?: string[]; isolation?: 'none' | 'worktree';
};
```
- Produces (`store.ts`): `createStore(opts: { dir?: string; now?: () => number }): Store` where
```ts
type Store = {
  create(rec: Omit<JobRecord,'status'|'startedAt'|'endedAt'|'exitCode'>): JobRecord; // status='queued'
  get(id: string): JobRecord | undefined;
  list(): JobRecord[];
  update(id: string, patch: Partial<JobRecord>): JobRecord;   // re-persists <id>.json
  appendLog(id: string, chunk: string): void;                 // appends to <id>.log
  readLog(id: string): string;                                // '' if none
  dir: string;
};
```
Store persists each record to `<dir>/<id>.json` on create/update and holds an in-memory map. `dir` defaults to `~/.shuba/jobs`. IDs: `job_${now()}_${counter}` (monotonic counter for uniqueness within a process — do NOT use Math.random).

- [ ] **Step 1: Write the failing test** (`test/control-store.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createStore } from '../src/control/store.ts';

function tmp() { return mkdtempSync(join(tmpdir(), 'shuba-store-')); }

test('create persists a queued record to <id>.json and returns it', () => {
  const dir = tmp();
  let t = 1000;
  const s = createStore({ dir, now: () => t });
  const rec = s.create({ id: '', task: 'do x', harness: 'opencode', model: null, cwd: '/repo', isolation: 'none' } as any);
  assert.equal(rec.status, 'queued');
  assert.ok(rec.id.startsWith('job_'));
  assert.deepEqual(s.get(rec.id), rec);
  const onDisk = JSON.parse(readFileSync(join(dir, `${rec.id}.json`), 'utf8'));
  assert.equal(onDisk.status, 'queued');
});

test('update patches, re-persists, and list reflects it', () => {
  const dir = tmp();
  const s = createStore({ dir, now: () => 5 });
  const rec = s.create({ id: '', task: 't', harness: 'gemini', model: 'gemini-flash', cwd: '/r', isolation: 'none' } as any);
  const upd = s.update(rec.id, { status: 'running', startedAt: 5 });
  assert.equal(upd.status, 'running');
  assert.equal(s.list().length, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, `${rec.id}.json`), 'utf8')).status, 'running');
});

test('appendLog + readLog round-trip', () => {
  const dir = tmp();
  const s = createStore({ dir, now: () => 5 });
  const rec = s.create({ id: '', task: 't', harness: 'qwen', model: null, cwd: '/r', isolation: 'none' } as any);
  s.appendLog(rec.id, 'line1\n'); s.appendLog(rec.id, 'line2\n');
  assert.equal(s.readLog(rec.id), 'line1\nline2\n');
  assert.ok(existsSync(join(dir, `${rec.id}.log`)));
});

test('ids are unique across rapid create at same timestamp', () => {
  const s = createStore({ dir: tmp(), now: () => 42 });
  const a = s.create({ id: '', task: 'a', harness: 'x', model: null, cwd: '/', isolation: 'none' } as any);
  const b = s.create({ id: '', task: 'b', harness: 'x', model: null, cwd: '/', isolation: 'none' } as any);
  assert.notEqual(a.id, b.id);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd orchestrator && bun test test/control-store.test.ts`
Expected: FAIL (`createStore` not found).

- [ ] **Step 3: Implement `src/control/types.ts` and `src/control/store.ts`**

Write the types exactly as in Interfaces. Implement `createStore` with an in-memory `Map<string, JobRecord>`, a monotonic `counter`, `mkdirSync(dir, {recursive:true})` on init, `writeFileSync` of the record JSON on create/update, `appendFileSync` for logs, `readFileSync` (guarded by existsSync) for readLog. The `create` arg's `id` field is ignored/overwritten with the generated id.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd orchestrator && bun test test/control-store.test.ts && bun run typecheck`
Expected: 4 pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/control/types.ts orchestrator/src/control/store.ts orchestrator/test/control-store.test.ts
git commit -m "feat(control): job types + durable job store"
```

---

### Task 2: Harness adapter registry

**Files:**
- Create: `orchestrator/src/control/harnesses.ts`
- Test: `orchestrator/test/control-harnesses.test.ts`

**Interfaces:**
- Produces:
```ts
export type HarnessAdapter = {
  id: string;
  bin: string;
  buildArgs(task: string, opts: { model?: string; files?: string[] }): string[];
  extractResult(stdout: string): string;
};
export const HARNESSES: Record<string, HarnessAdapter>;
export function detectHarnesses(which?: (bin: string) => boolean): Array<{ id: string; bin: string; installed: boolean }>;
```
Adapter invocations (verified against installed CLIs; keep as the initial mapping):
```
opencode     → ['run', '-m', <model?>, '--format', 'json', task]   extractResult: parse JSON events, else raw
gemini       → ['-m', <model?>, '-p', task]
qwen         → ['-p', task]                       (model via '-m' if provided)
cursor-agent → ['-p', task, '--output-format', 'text', ('-m', <model?>)]
claude       → ['--model', <model?>, '-p', task, '--dangerously-skip-permissions']
```
Omit the `-m <model>` pair when `model` is undefined. `extractResult` default returns `stdout.trim()`; opencode's may attempt `JSON.parse` and fall back to raw on error.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, detectHarnesses } from '../src/control/harnesses.ts';

test('claude adapter injects --dangerously-skip-permissions and model', () => {
  const a = HARNESSES['claude'];
  const args = a.buildArgs('fix bug', { model: 'haiku' });
  assert.deepEqual(args, ['--model', 'haiku', '-p', 'fix bug', '--dangerously-skip-permissions']);
});

test('gemini adapter omits -m when no model', () => {
  const args = HARNESSES['gemini'].buildArgs('summarize', {});
  assert.deepEqual(args, ['-p', 'summarize']);
});

test('opencode adapter uses run -m --format json', () => {
  const args = HARNESSES['opencode'].buildArgs('refactor', { model: 'deepseek/deepseek-v4-flash' });
  assert.deepEqual(args, ['run', '-m', 'deepseek/deepseek-v4-flash', '--format', 'json', 'refactor']);
});

test('extractResult trims plain stdout', () => {
  assert.equal(HARNESSES['gemini'].extractResult('  answer\n'), 'answer');
});

test('detectHarnesses marks installed via injected which', () => {
  const rows = detectHarnesses((bin) => bin === 'gemini' || bin === 'claude');
  const byId = Object.fromEntries(rows.map(r => [r.id, r.installed]));
  assert.equal(byId['gemini'], true);
  assert.equal(byId['claude'], true);
  assert.equal(byId['opencode'], false);
});
```

- [ ] **Step 2: Run, verify fail** — `cd orchestrator && bun test test/control-harnesses.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/control/harnesses.ts`** per Interfaces. `detectHarnesses` default `which` uses `execSync('command -v ' + bin)` in a try/catch returning boolean (same pattern as `cli.ts`'s `which`).

- [ ] **Step 4: Run, verify pass** — `cd orchestrator && bun test test/control-harnesses.test.ts && bun run typecheck` → 5 pass, clean.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/control/harnesses.ts orchestrator/test/control-harnesses.test.ts
git commit -m "feat(control): harness adapter registry + PATH detection"
```

---

### Task 3: Job runner (isolation=none)

**Files:**
- Create: `orchestrator/src/control/runner.ts`
- Test: `orchestrator/test/control-runner.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 1), `HarnessAdapter`/`HARNESSES` (Task 2).
- Produces:
```ts
export function createRunner(opts: {
  store: Store;
  harnesses?: Record<string, HarnessAdapter>;
  spawnImpl?: typeof import('node:child_process').spawn;
  now?: () => number;
}): {
  run(job: JobRecord): Promise<void>; // spawns adapter, streams stdout+stderr to store.appendLog,
                                       // sets status running→done/failed, endedAt, exitCode
};
```
`run` looks up the adapter by `job.harness`, builds args via `buildArgs(job.task, {model, files})`, spawns `adapter.bin` with `{ cwd: job.worktreePath ?? job.cwd }`, pipes child stdout+stderr into `store.appendLog(job.id, chunk)`, on close sets `exitCode`, `status = code===0 ? 'done' : 'failed'`, `endedAt = now()`. An unknown harness → status `failed` with `error`.

- [ ] **Step 1: Write the failing test** (use a fake `spawnImpl` returning an EventEmitter-like child with `stdout`/`stderr` streams and a `close` event)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/control/store.ts';
import { createRunner } from '../src/control/runner.ts';

function fakeSpawn(stdout: string, code: number) {
  return () => {
    const child: any = new EventEmitter();
    child.stdout = Readable.from([stdout]);
    child.stderr = Readable.from([]);
    queueMicrotask(() => child.stdout.on('end', () => child.emit('close', code)));
    return child;
  };
}

test('successful job → done, exitCode 0, stdout logged', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/r', isolation:'none' } as any);
  const runner = createRunner({ store, spawnImpl: fakeSpawn('hello\n', 0) as any, now: () => 9 });
  await runner.run(store.get(job.id)!);
  const done = store.get(job.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.exitCode, 0);
  assert.equal(done.endedAt, 9);
  assert.match(store.readLog(job.id), /hello/);
});

test('nonzero exit → failed', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/r', isolation:'none' } as any);
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 2) as any });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.status, 'failed');
  assert.equal(store.get(job.id)!.exitCode, 2);
});

test('unknown harness → failed with error', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'nope', model:null, cwd:'/r', isolation:'none' } as any);
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.status, 'failed');
  assert.match(store.get(job.id)!.error ?? '', /unknown harness/i);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `src/control/runner.ts`.** Wrap the child lifecycle in a `Promise<void>` that resolves on `close`. Set `status='running'`, `startedAt=now()` before spawn; on `close(code)` update terminal fields. Guard unknown harness before spawn.

- [ ] **Step 4: Run, verify pass** — `bun test test/control-runner.test.ts && bun run typecheck` → 3 pass, clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(control): job runner streaming to log (isolation=none)"`

---

### Task 4: Worktree isolation for the runner

**Files:**
- Modify: `orchestrator/src/control/runner.ts`
- Create: `orchestrator/src/control/worktree.ts`
- Test: `orchestrator/test/control-worktree.test.ts`

**Interfaces:**
- Produces (`worktree.ts`):
```ts
export function createWorktree(repoCwd: string, id: string, execImpl?): { path: string };  // git worktree add
export function finalizeWorktree(repoCwd: string, path: string, execImpl?): { diff: string; removed: boolean }; // capture diff; remove if unchanged
```
- Modifies runner: when `job.isolation === 'worktree'`, call `createWorktree(job.cwd, job.id)`, set `job.worktreePath`, run there, then `finalizeWorktree` and append the diff to the log; store `worktreePath` on the record.

- [ ] **Step 1: Write the failing test** — create a throwaway git repo fixture (`git init`, initial commit) via an injected `execImpl` OR real `execSync` in a tmp dir; assert `createWorktree` yields an existing path and `finalizeWorktree` on an unchanged worktree reports `removed: true`.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, finalizeWorktree } from '../src/control/worktree.ts';

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'wt-'));
  execSync('git init -q && git commit -q --allow-empty -m init', { cwd: d, shell: '/bin/bash' });
  return d;
}

test('createWorktree makes a path; unchanged → finalize removes it', () => {
  const d = repo();
  const { path } = createWorktree(d, 'job_1');
  assert.ok(existsSync(path));
  const { removed } = finalizeWorktree(d, path);
  assert.equal(removed, true);
  assert.equal(existsSync(path), false);
});

test('changed worktree → diff captured, not removed', () => {
  const d = repo();
  const { path } = createWorktree(d, 'job_2');
  writeFileSync(join(path, 'new.txt'), 'x');
  execSync('git add -A', { cwd: path, shell: '/bin/bash' });
  const { diff, removed } = finalizeWorktree(d, path);
  assert.match(diff, /new\.txt/);
  assert.equal(removed, false);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `worktree.ts`** using `git worktree add <path> -d` (detached) under `<repoCwd>/.shuba-worktrees/<id>`; `finalizeWorktree` runs `git -C <path> add -A && git -C <path> diff --cached`, and if empty removes via `git -C <repoCwd> worktree remove --force <path>` and returns `removed:true`. Wire into `runner.ts` per Interfaces.

- [ ] **Step 4: Run, verify pass** — `bun test test/control-worktree.test.ts test/control-runner.test.ts && bun run typecheck`.

- [ ] **Step 5: Commit** — `git commit -m "feat(control): git-worktree isolation for delegated jobs"`

---

### Task 5: Classifier (hybrid harness/model selection)

**Files:**
- Create: `orchestrator/src/control/classifier.ts`
- Test: `orchestrator/test/control-classifier.test.ts`

**Interfaces:**
- Produces:
```ts
export type DelegateConfig = {
  concurrency?: number; isolation?: 'none' | 'worktree';
  default: { harness: string; model: string };
  policy?: Array<{ when: string; harness: string; model: string }>;
  baseUrl?: string; classifierModel?: string; envKey?: string;
};
export async function selectHarnessModel(
  input: DelegateInput, cfg: DelegateConfig,
  opts?: { fetchImpl?: typeof fetch; apiKey?: string }
): Promise<{ harness: string; model: string }>;
```
Logic: if both `input.harness` and `input.model` set → return them. If one set, fill the other from the classifier or `default`. If neither set and `policy` present → call the cheap model (OpenRouter chat/completions) with the task + the policy hints, expect a JSON `{harness, model}`; on any error or missing policy → return `cfg.default`. Explicit input always overrides the classifier's field.

- [ ] **Step 1: Write the failing test** (inject `fetchImpl`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectHarnessModel } from '../src/control/classifier.ts';

const cfg = {
  default: { harness: 'opencode', model: 'deepseek/deepseek-v4-flash' },
  policy: [{ when: 'quick question', harness: 'gemini', model: 'gemini-flash' }],
};

test('explicit harness+model bypasses classifier (no fetch)', async () => {
  let called = false;
  const r = await selectHarnessModel({ task: 't', harness: 'claude', model: 'haiku' }, cfg as any,
    { fetchImpl: (async () => { called = true; return {} as any; }) });
  assert.deepEqual(r, { harness: 'claude', model: 'haiku' });
  assert.equal(called, false);
});

test('no hints → classifier result used', async () => {
  const fetchImpl = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"harness":"gemini","model":"gemini-flash"}' } }] }) })) as any;
  const r = await selectHarnessModel({ task: 'what is X' }, cfg as any, { fetchImpl, apiKey: 'k' });
  assert.deepEqual(r, { harness: 'gemini', model: 'gemini-flash' });
});

test('classifier error → default', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 500 })) as any;
  const r = await selectHarnessModel({ task: 'x' }, cfg as any, { fetchImpl, apiKey: 'k' });
  assert.deepEqual(r, { harness: 'opencode', model: 'deepseek/deepseek-v4-flash' });
});

test('explicit harness only → model filled from default when no classifier', async () => {
  const r = await selectHarnessModel({ task: 'x', harness: 'qwen' }, { default: { harness: 'opencode', model: 'm0' } } as any, {});
  assert.equal(r.harness, 'qwen');
  assert.equal(r.model, 'm0');
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `classifier.ts`.** Build an OpenRouter chat/completions request whose user message embeds the task and the policy hints and asks for a strict JSON object `{"harness","model"}`. Parse defensively (`JSON.parse` in try/catch; validate the harness exists in HARNESSES else fall to default). Reuse the `anthropicToOpenAI`-style direct fetch pattern from `compact/server.ts` (but here we author the OpenAI request directly). Timeout via AbortController (e.g., 20s).

- [ ] **Step 4: Run, verify pass** — `bun test test/control-classifier.test.ts && bun run typecheck` → 4 pass, clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(control): hybrid harness/model classifier (cheap model)"`

---

### Task 6: Engine facade (delegate/status/result/harness_list + concurrency)

**Files:**
- Create: `orchestrator/src/control/engine.ts`
- Test: `orchestrator/test/control-engine.test.ts`

**Interfaces:**
- Consumes: store, runner, classifier, harnesses.
- Produces:
```ts
export function createEngine(opts: {
  cfg: DelegateConfig; store?: Store; runner?: Runner;
  select?: typeof selectHarnessModel; apiKey?: string; projectCwd: string;
}): {
  delegate(input: DelegateInput): Promise<{ job_id: string; harness_chosen: string; model_chosen: string }>;
  status(id: string): { status: JobStatus; harness: string; model: string | null; elapsed_ms: number | null; tail: string } | { error: string };
  result(id: string): { status: JobStatus; result: string; exit_code: number | null; log_path: string } | { error: string };
  harnessList(): Array<{ id: string; bin: string; installed: boolean }>;
};
```
`delegate`: resolve harness+model via `select`, create a job record (status queued), then schedule `runner.run` respecting `cfg.concurrency` (a simple in-process semaphore — at most N running; excess stay queued and start as slots free). Returns immediately. `status.tail` = last ~2KB of the log. `result.result` = `adapter.extractResult(readLog)` once terminal (or the raw log while running).

- [ ] **Step 1: Write the failing test** with a fake runner (records invocations, lets the test control completion) and a stub `select` returning fixed harness/model. Assert: delegate returns immediately with chosen fields; concurrency cap keeps the 4th job `queued` while 3 run; status/result shapes; unknown id → `{error}`.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/control/store.ts';
import { createEngine } from '../src/control/engine.ts';

const cfg = { concurrency: 2, default: { harness: 'opencode', model: 'm' } };

function gatedRunner() {
  const gates: Array<() => void> = [];
  return {
    running: 0, max: 0,
    run(job: any) {
      this.running++; this.max = Math.max(this.max, this.running);
      return new Promise<void>((res) => gates.push(() => { this.running--; res(); }));
    },
    releaseOne() { gates.shift()?.(); },
  };
}

test('delegate returns chosen harness/model immediately; concurrency capped', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'e-')), now: () => 1 });
  const runner: any = gatedRunner();
  const select = (async () => ({ harness: 'opencode', model: 'm' })) as any;
  const engine = createEngine({ cfg: cfg as any, store, runner, select, projectCwd: '/r' });
  const a = await engine.delegate({ task: '1' });
  const b = await engine.delegate({ task: '2' });
  const c = await engine.delegate({ task: '3' });
  assert.equal(a.harness_chosen, 'opencode');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(runner.max <= 2, `max concurrency ${runner.max} must be <= 2`);
  assert.equal(engine.status(c.job_id)!.status, 'queued');
  runner.releaseOne();
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(engine.status(c.job_id)!.status, 'queued');
});

test('status/result on unknown id → error', () => {
  const engine = createEngine({ cfg: cfg as any, store: createStore({ dir: mkdtempSync(join(tmpdir(),'e-')), now:()=>1 }), runner: gatedRunner() as any, select: (async()=>({harness:'x',model:'m'})) as any, projectCwd: '/r' });
  assert.ok('error' in engine.status('nope'));
  assert.ok('error' in engine.result('nope'));
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `engine.ts`** with a semaphore (counter + a queue of pending job ids). On each `delegate`, create record and call `pump()`; `pump` starts queued jobs while `running < concurrency`, decrementing on each `runner.run(...).finally()`. `harnessList` delegates to `detectHarnesses`.

- [ ] **Step 4: Run, verify pass** — `bun test test/control-engine.test.ts && bun run typecheck`.

- [ ] **Step 5: Commit** — `git commit -m "feat(control): engine facade with concurrency-capped scheduling"`

---

### Task 7: stdio MCP server over the engine

**Files:**
- Create: `orchestrator/src/control/mcp.ts`
- Test: `orchestrator/test/control-mcp.test.ts`
- Modify: `orchestrator/package.json` (add `@modelcontextprotocol/sdk`)

**Interfaces:**
- Consumes: engine (Task 6).
- Produces: `createMcpServer(engine): McpServer` registering four tools — `shuba_delegate`, `shuba_job_status`, `shuba_job_result`, `shuba_harness_list` — whose handlers call the matching engine methods and return the results as MCP tool content (JSON stringified in a text block). Also `connectStdio(server): Promise<void>` wrapping `StdioServerTransport`.

- [ ] **Step 1: Add the SDK** — `cd orchestrator && bun add @modelcontextprotocol/sdk`.

- [ ] **Step 2: Write the failing test** — construct `createMcpServer` with a stub engine (records calls, returns canned objects) and use the SDK's in-memory linked transport (`InMemoryTransport.createLinkedPair()`) + an MCP `Client` to `listTools` (assert the four names) and `callTool('shuba_delegate', {task:'t'})` (assert the engine received it and the response carries the canned `job_id`).

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/control/mcp.ts';

function stubEngine() {
  return {
    calls: [] as any[],
    async delegate(i: any){ this.calls.push(['delegate', i]); return { job_id:'job_1', harness_chosen:'opencode', model_chosen:'m' }; },
    status(){ return { status:'running', harness:'opencode', model:'m', elapsed_ms:5, tail:'…' }; },
    result(){ return { status:'done', result:'ok', exit_code:0, log_path:'/x.log' }; },
    harnessList(){ return [{ id:'opencode', bin:'opencode', installed:true }]; },
  };
}

test('MCP exposes four tools and routes delegate', async () => {
  const engine = stubEngine();
  const server = createMcpServer(engine as any);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const tools = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(tools, ['shuba_delegate','shuba_harness_list','shuba_job_result','shuba_job_status']);
  const res: any = await client.callTool({ name: 'shuba_delegate', arguments: { task: 'do it' } });
  assert.equal(engine.calls[0][0], 'delegate');
  assert.match(JSON.stringify(res.content), /job_1/);
});
```
(If the exact SDK import paths differ in `@modelcontextprotocol/sdk@1.29`, adjust to the installed package's entry points — verify with the package's `exports` — but keep the test's behavior identical.)

- [ ] **Step 3: Run, verify fail.**

- [ ] **Step 4: Implement `src/control/mcp.ts`** using `McpServer`/`registerTool` from the SDK with zod input schemas matching `DelegateInput` and `{job_id}` / `{}`. Each handler returns `{ content: [{ type:'text', text: JSON.stringify(result) }] }`.

- [ ] **Step 5: Run, verify pass** — `bun test test/control-mcp.test.ts && bun run typecheck`.

- [ ] **Step 6: Commit** — `git commit -m "feat(control): stdio MCP server exposing delegation tools"`

---

### Task 8: HTTP + WS API over the engine

**Files:**
- Create: `orchestrator/src/control/http.ts`
- Test: `orchestrator/test/control-http.test.ts`

**Interfaces:**
- Produces: `createControlHttp(engine, opts?: { staticDir?: string }): import('node:http').Server` serving:
  - `GET /health` → `{"status":"ok"}`
  - `GET /api/harnesses` → `engine.harnessList()`
  - `GET /api/jobs` → all job records (`engine` gains a `listJobs()` passthrough to store.list)
  - `GET /api/jobs/:id` → `engine.status(id)`
  - `GET /api/jobs/:id/result` → `engine.result(id)`
  - `POST /api/delegate` (JSON body = DelegateInput) → `engine.delegate(body)`
  - `WS /api/stream/logs/:id` → streams new log chunks (Task 8 keeps a minimal poll-based WS; the console spec refines channels).
- Add `listJobs()` to the engine (Task 6 file) as a thin `store.list()` passthrough — a small modify.

- [ ] **Step 1: Write the failing test** — start the server on port 0 with a stub engine, hit `GET /health`, `GET /api/harnesses`, and `POST /api/delegate` with a JSON body; assert status codes and that delegate routed to the engine.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `http.ts`** with `node:http`, a tiny router (method+path match, `:id` extraction), JSON body parse for POST, and (optionally) a WS upgrade handler for `/api/stream/logs/:id` that polls `store.readLog` deltas every 500ms. Keep the WS minimal; Spec 3 extends it. Serve `staticDir` if provided (for Spec 3's SPA) — a simple file read with content-type by extension.

- [ ] **Step 4: Run, verify pass** — `bun test test/control-http.test.ts && bun run typecheck`.

- [ ] **Step 5: Commit** — `git commit -m "feat(control): HTTP+WS API over the delegation engine"`

---

### Task 9: Config `delegate` block + `control` builtin + supervisor wiring

**Files:**
- Modify: `orchestrator/src/types.ts` (add `delegate?: DelegateConfig` to `Config`)
- Modify: `orchestrator/src/registry.ts` (register `control` builtin sidecar)
- Test: `orchestrator/test/registry.test.ts` (extend), `orchestrator/test/control-config.test.ts`

**Interfaces:**
- `Config.delegate?: DelegateConfig` (import the type from `control/classifier.ts` or re-declare in types.ts — prefer declaring the shape in types.ts and having classifier import it, to avoid a cycle).
- `control` registry entry: `{ id:'control', builtin:true, bin: process.execPath, defaultPort: 47830, dialect:'anthropic', terminal:false, healthPath:'/health', build({port, config}) → { args:[CONTROL_BIN], env:{ PORT, OPENROUTER_API_KEY passthrough, DELEGATE_JSON: JSON.stringify(config?.delegate ?? defaults) } } }`.
- NOTE: `control` is a **sidecar**, not part of the ANTHROPIC chain. The planner builds the proxy chain from `compressors`; `control` must be started separately by the supervisor when `config.control?.enabled !== false`. Add a minimal `sidecars` concept: `plan()` returns `sidecars: PlannedStage[]` alongside `chain`, and `up()` starts both. Keep it small — one extra array threaded through.

- [ ] **Step 1: Write failing tests** — (a) `registry.test.ts`: `REGISTRY.control` exists with port 47830 and healthPath `/health`; (b) `control-config.test.ts`: a config with a `delegate` block validates/round-trips through `loadConfig` (write+read a temp file). Also assert `plan()` surfaces `control` as a sidecar when enabled.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** the `Config.delegate` type, the `control` registry entry, and the `sidecars` threading in `planner.ts` + `supervisor.ts` (supervisor `up` starts sidecars with the same health-wait). Keep the proxy chain wiring untouched.

- [ ] **Step 4: Run, verify pass** — `bun test test/registry.test.ts test/control-config.test.ts test/planner.test.ts test/supervisor.test.ts && bun run typecheck`.

- [ ] **Step 5: Commit** — `git commit -m "feat(control): register control sidecar + delegate config + supervisor wiring"`

---

### Task 10: MCP auto-registration into Claude Code config

**Files:**
- Create: `orchestrator/src/control/mcp-register.ts`
- Test: `orchestrator/test/control-mcp-register.test.ts`

**Interfaces:**
- Produces:
```ts
export function registerMcp(configPath: string, entry: { command: string; args: string[] }): void; // idempotent add of mcpServers.shuba-control
export function unregisterMcp(configPath: string): void;                                            // remove it, restore prior state
```
Reads the JSON config (create `{}` if absent), sets `mcpServers['shuba-control'] = { command, args }` only if not already equal (idempotent), writes back preserving other keys. `unregister` deletes just that key.

- [ ] **Step 1: Write failing test** — on a temp JSON file: `registerMcp` adds the entry; calling twice is idempotent (no duplicate, stable content); `unregisterMcp` removes only that key and leaves siblings intact.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `mcp-register.ts`.** Wire the call into `cli.ts doRun`: on `shuba run`, after the chain is up, `registerMcp(<claude config path>, { command: 'bun', args: [CONTROL_BIN...] })`; on teardown, `unregisterMcp`. (Determine the Claude Code MCP config path — user-level `~/.claude.json` or project `.mcp.json`; default to project `.mcp.json` in the launch cwd. Keep the path a parameter so the test injects a temp file.)

- [ ] **Step 4: Run, verify pass** — `bun test test/control-mcp-register.test.ts && bun run typecheck`.

- [ ] **Step 5: Commit** — `git commit -m "feat(control): idempotent MCP auto-registration for Claude Code"`

---

### Task 11: Entry bin + doctor + end-to-end smoke

**Files:**
- Create: `orchestrator/bin/shuba-control.ts`
- Modify: `orchestrator/src/registry.ts` (`CONTROL_BIN` → this `.ts`), `orchestrator/src/cli.ts` (doctor lists control + harnesses)
- Test: `orchestrator/test/control-e2e.test.ts`

**Interfaces:**
- `bin/shuba-control.ts` (`#!/usr/bin/env bun`): reads `PORT`, `DELEGATE_JSON`, `OPENROUTER_API_KEY`, `projectCwd = process.cwd()`; builds the engine; starts BOTH the HTTP server (on PORT) and connects the stdio MCP server; logs a start line to stderr.

- [ ] **Step 1: Write the failing e2e test** — build an engine with a **fake harness** (an adapter whose `bin` is a tiny echo script written to a temp file, e.g. a shell script printing a known string and exiting 0) registered into a custom `HARNESSES`, drive `engine.delegate({task, harness:'echo'})`, poll `engine.status` until `done`, assert `engine.result().result` contains the echoed string. (This exercises store+runner+engine end-to-end without a real CLI.)

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `bin/shuba-control.ts`**; point `CONTROL_BIN` at it; extend `cli.ts doDoctor` to print the `control` sidecar and `detectHarnesses()` rows.

- [ ] **Step 4: Run, verify pass + full suite + typecheck**

Run: `cd orchestrator && bun test && bun run typecheck`
Expected: all pass (70 prior + the new control tests), typecheck clean.

- [ ] **Step 5: Manual smoke** — `cd orchestrator && DELEGATE_JSON='{"default":{"harness":"opencode","model":"deepseek/deepseek-v4-flash"}}' PORT=47830 bun bin/shuba-control.ts & sleep 1; curl -s 127.0.0.1:47830/health; curl -s 127.0.0.1:47830/api/harnesses; kill %1`
Expected: `{"status":"ok"}` then a JSON array of harnesses with `installed` flags.

- [ ] **Step 6: Commit** — `git commit -m "feat(control): shuba-control entry bin + doctor integration + e2e"`

---

## Self-Review

**Spec coverage** (against `2026-07-11-shuba-control-delegation-design.md`):
- §2 architecture (engine core + stdio MCP + HTTP/WS adapters; control as sidecar; auto-registration) → Tasks 6/7/8/9/10. ✓
- §3 four MCP tools + async return shape → Task 7 (tools), Task 6 (shapes). ✓
- §4 job store (in-memory + durable mirror + concurrency) → Tasks 1, 6. ✓
- §5 hybrid harness+model independent fields + policy + cheap classifier → Task 5. ✓
- §6 adapters (opencode/gemini/qwen/cursor-agent/claude, model optional, PATH detect) → Task 2. ✓
- §7 isolation none|worktree per-call → Tasks 3 (none) + 4 (worktree). ✓
- §8 config `delegate` block + control registry + supervisor start → Task 9. ✓
- §9 security (claude skip-permissions, no Anthropic key into others, stdio no inbound) → Task 2 (claude args) + Global Constraints + Task 7 (stdio). ✓
- §10 testing (unit per unit + fake-harness e2e + MCP round-trip) → Tasks 1–11. ✓
- §11 deferred (exact flags) → Task 2 note. ✓
- Spec 1 update: auto-registration → Task 10; dual frontend on one engine → Tasks 6 (engine) + 7/8 (adapters). ✓

**Placeholder scan:** No "TBD/handle edge cases". Each task has concrete test code or concrete assertions. The one deferral (exact CLI flags) is explicitly scoped in Task 2 and grounded by the verified `--help` output in this plan's research.

**Type consistency:** `JobRecord`/`DelegateInput`/`JobStatus` (Task 1) are used consistently by runner (3), engine (6), mcp (7), http (8). `DelegateConfig` (Task 5) is used by engine (6) and config (9). `HarnessAdapter`/`HARNESSES`/`detectHarnesses` (Task 2) used by runner (3), engine (6), harnessList. Engine method names (`delegate`/`status`/`result`/`harnessList`/`listJobs`) match across MCP (7) and HTTP (8).
