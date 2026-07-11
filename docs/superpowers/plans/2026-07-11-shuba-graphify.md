# shuba graphify Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** shuba manages a per-project knowledge graph (build/watch via the existing graphify CLI on cheap OpenRouter, never Claude tokens) and exposes it to Claude Code as MCP tools on the existing `shuba-control` server.

**Architecture:** A thin wrapper (`src/control/graph.ts`) shells out to the installed `graphify` CLI and reads `graphify-out/graph.json`. Two new MCP tools (`shuba_graph_query`, `shuba_graph_status`) + HTTP routes mount on the Spec 1 control server. shuba auto-disables the client-side graphify SessionStart hook while it manages the graph.

**Tech Stack:** Bun+TS (strict), the `graphify` CLI (`~/.local/bin/graphify`), OpenRouter/deepseek via `GRAPHIFY_OPENROUTER_MODEL`.

## Global Constraints

- Bun+TS strict; `bun test` (node:test/node:assert); `bun run typecheck` clean.
- Graph build/extraction ALWAYS runs on the cheap OpenRouter model (`GRAPHIFY_OPENROUTER_MODEL`, default `deepseek/deepseek-v4-flash`) — NEVER Claude tokens. shuba sets this env when spawning graphify.
- The wrapper shells out to the installed `graphify` CLI; it does NOT reimplement graph logic.
- `graph.json` default path: `<cwd>/graphify-out/graph.json`.
- graphify invocations (verified against installed CLI): `graphify watch <path>` (watch+rebuild), `graphify update <path>` (no-LLM re-extract), `graphify explain "<q>"` / `graphify path "A" "B"` (query, `--graph <path>`). The initial full build command is the one `graphify/build-and-watch.sh` uses — the implementer verifies it against the installed CLI in Task 2 and records it.
- All git/CLI subprocess calls use `execFile`-style argv (no shell string interpolation) — same security posture as `worktree.ts`.
- New code under `orchestrator/src/control/`; tests under `orchestrator/test/`.
- The control server is loopback-only; graph tools reuse its existing MCP/HTTP adapters and CSRF/Origin/Host guards.

---

### Task 1: Graph status reader

**Files:** Create `orchestrator/src/control/graph.ts`; Test `orchestrator/test/control-graph-status.test.ts`

**Interfaces:**
```ts
export type GraphStatus = { built: boolean; path: string; node_count: number; last_built: number | null; watching: boolean };
export function createGraph(opts: { cwd: string; model?: string; execFileImpl?; watchImpl?; now?: () => number }): {
  status(): GraphStatus;
  // query + lifecycle added in later tasks
};
```
`status()` reads `<cwd>/graphify-out/graph.json`: if absent → `{built:false, path, node_count:0, last_built:null, watching:false}`; if present → parse, `node_count` = length of the graph's nodes array (graph.json shape: an object with a `nodes` array — the implementer confirms the key by inspecting a real graph.json or the graphify README; fall back to counting a `nodes`/`entities` array, else 0), `last_built` = file mtime (ms), `watching` reflects whether a watcher is active (false until Task 3 wires it).

- [ ] **Step 1: Write the failing test** — with a temp cwd: no graph → `built:false`; write a fake `graphify-out/graph.json` with `{"nodes":[{},{}]}` → `built:true, node_count:2, last_built` a number.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraph } from '../src/control/graph.ts';

test('status: no graph → built false', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  assert.deepEqual(createGraph({ cwd }).status().built, false);
});

test('status: graph present → built true, node_count from nodes[]', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  mkdirSync(join(cwd, 'graphify-out'));
  writeFileSync(join(cwd, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{}, {}, {}] }));
  const s = createGraph({ cwd }).status();
  assert.equal(s.built, true);
  assert.equal(s.node_count, 3);
  assert.equal(typeof s.last_built, 'number');
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `graph.ts` `status()`** per Interfaces (existsSync guard, JSON.parse in try/catch → built:false on parse error, mtimeMs via statSync).
- [ ] **Step 4: Run, verify pass** — `cd orchestrator && bun test test/control-graph-status.test.ts && bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(control): graph status reader`

---

### Task 2: Graph query (shell to graphify explain/path)

**Files:** Modify `orchestrator/src/control/graph.ts`; Test `orchestrator/test/control-graph-query.test.ts`

**Interfaces:** add `query(q: string, opts?: { path?: string }): { ok: boolean; result: string }` to the createGraph return. It runs the graphify CLI with the graph path `--graph <cwd>/graphify-out/graph.json`: if `q` contains ` -> ` (two node names) run `graphify path "A" "B"`, else `graphify explain "<q>"`. Uses the injected `execFileImpl('graphify', args, {cwd})` (default = `execFileSync` wrapper returning stdout). On non-zero/throw → `{ok:false, result:<stderr/message>}`. Sets `GRAPHIFY_OPENROUTER_MODEL` in the child env from `opts.model ?? 'deepseek/deepseek-v4-flash'` (query is no-LLM but keep env consistent).

- [ ] **Step 1: Write the failing test** — inject an `execFileImpl` recording `(file,args,opts)` and returning a canned string; assert `query('foo')` invokes `graphify explain foo --graph <...>` and returns `{ok:true, result:<canned>}`; `query('A -> B')` invokes `graphify path A B`. Assert a throwing execFileImpl → `{ok:false}`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `query`.** Also, while here, RECORD in the report the exact initial-build command the installed graphify uses (run `graphify --help` and inspect `graphify/build-and-watch.sh`) — the build command is needed by Task 3.
- [ ] **Step 4: Run, verify pass** — `bun test test/control-graph-query.test.ts && bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(control): graph query via graphify explain/path`

---

### Task 3: Build/watch lifecycle

**Files:** Modify `orchestrator/src/control/graph.ts`; Test `orchestrator/test/control-graph-lifecycle.test.ts`

**Interfaces:** add:
```ts
ensure(opts?: { autobuild?: boolean }): Promise<{ action: 'watch' | 'built-then-watch' | 'skipped'; reason?: string }>;
stopWatch(): void;
```
Logic (mirrors `graphify/build-and-watch.sh`): if `graph.json` exists → start `graphify watch <cwd>` (spawn, keep handle, set watching=true) → `'watch'`. Else if `autobuild` (from config or `~/.shuba/autobuild` marker) → run the initial build command (recorded in Task 2) with `GRAPHIFY_OPENROUTER_MODEL` set, then watch → `'built-then-watch'`. Else → `'skipped'` with `reason:'not initialized — run graphify build'` (never silently index a huge folder). `stopWatch` kills the watcher. Inject `spawnImpl`/`execFileImpl` for tests.

- [ ] **Step 1: Write the failing test** — inject spawn/execFile fakes; (a) graph present → ensure() returns `'watch'`, spawn called with `['watch', cwd]`, status().watching true; (b) no graph + autobuild:false → `'skipped'`, no spawn; (c) no graph + autobuild:true → build execFile called then watch spawned → `'built-then-watch'`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `ensure`/`stopWatch`; track the watcher child + `watching` flag (reflected in `status()`).
- [ ] **Step 4: Run, verify pass** — `bun test test/control-graph-lifecycle.test.ts && bun run typecheck`, then full `bun test`.
- [ ] **Step 5: Commit** — `feat(control): graph build/watch lifecycle (deepseek-only)`

---

### Task 4: graph MCP tools + HTTP routes

**Files:** Modify `orchestrator/src/control/mcp.ts`, `orchestrator/src/control/http.ts`; Test `orchestrator/test/control-graph-tools.test.ts`

**Interfaces:** `createMcpServer(engine, graph?)` and `createControlHttp(engine, opts?)` gain graph wiring. New MCP tools:
- `shuba_graph_query({query})` → `graph.query(query)`
- `shuba_graph_status({})` → `graph.status()`
New HTTP routes: `GET /api/graph` → `graph.status()`; `POST /api/graph/query` (JSON `{query}`, Origin+JSON-content-type guarded like /api/delegate) → `graph.query(query)`. When `graph` is undefined (not configured), the tools/routes return `{error:'graph not enabled'}` rather than crashing.

- [ ] **Step 1: Write the failing test** — MCP: with a stub graph, `listTools` now includes `shuba_graph_query`+`shuba_graph_status` (plus the 4 delegation tools = 6), and callTool routes to the stub. HTTP: `GET /api/graph` returns the stub status; `POST /api/graph/query` with `Content-Type: application/json` returns the stub query result; cross-origin Origin → 403 (reuses existing guard).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the tool/route additions; thread an optional `graph` param through `createMcpServer`/`createControlHttp`.
- [ ] **Step 4: Run, verify pass** — `bun test test/control-graph-tools.test.ts && bun run typecheck`, full `bun test`.
- [ ] **Step 5: Commit** — `feat(control): graph MCP tools + HTTP routes`

---

### Task 5: Config `graph` block + bin wiring

**Files:** Modify `orchestrator/src/types.ts` (add `graph?` to Config), `orchestrator/bin/shuba-control.ts`; Test `orchestrator/test/control-graph-config.test.ts`

**Interfaces:** `Config.graph?: { model?: string; autobuild?: boolean; noMedia?: boolean; enabled?: boolean }`. `bin/shuba-control.ts`: build `createGraph({ cwd: projectCwd, model: graphCfg.model })`, pass it to `createMcpServer`/`createControlHttp`, and call `graph.ensure({autobuild})` on startup (fire-and-forget, logged) unless `graph.enabled === false`. Read graph config from a `GRAPH_JSON` env (set by the registry like `DELEGATE_JSON`).

- [ ] **Step 1: Write the failing test** — a config with a `graph` block round-trips through `loadConfig` (temp file); `Config` type accepts it (typecheck). Assert the registry `control.build` env includes `GRAPH_JSON` (extend registry).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the type, the registry `GRAPH_JSON` env, and the bin wiring (graph built + ensure called; HTTP-role sidecar runs ensure/watch, stdio role can also answer status/query since it reads graph.json). Keep the CSRF/Origin guards intact.
- [ ] **Step 4: Run, verify pass** — `bun test test/control-graph-config.test.ts && bun run typecheck`, full `bun test`.
- [ ] **Step 5: Commit** — `feat(control): graph config block + control bin wiring`

---

### Task 6: Auto-disable the client-side graphify SessionStart hook

**Files:** Create `orchestrator/src/control/graphify-hook.ts`; Modify `orchestrator/src/cli.ts`; Test `orchestrator/test/control-graphify-hook.test.ts`

**Interfaces:**
```ts
export function disableClientGraphifyHook(settingsPath: string): { disabled: boolean; restore: () => void };
```
Reads the Claude Code `settings.json`, finds SessionStart hooks whose command references `graphify` (e.g. `build-and-watch.sh`), removes/neutralizes them, writes back, and returns a `restore()` that puts the original back. Idempotent; no-op (disabled:false) if none found or file absent. Wire into `cli.ts doRun` when `config.graph?.enabled !== false`: disable on run, `restore()` on teardown. Guard in try/catch so a settings write failure never crashes `shuba run`.

- [ ] **Step 1: Write the failing test** — a temp settings.json containing a SessionStart hook with a `graphify` command + an unrelated hook; `disableClientGraphifyHook` removes only the graphify one, leaves the other; `restore()` reinstates it; absent file → `{disabled:false}` no throw.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `graphify-hook.ts` + cli wiring.
- [ ] **Step 4: Run, verify pass** — `bun test test/control-graphify-hook.test.ts && bun run typecheck`, full `bun test`.
- [ ] **Step 5: Commit** — `feat(control): auto-disable client graphify SessionStart hook while shuba manages the graph`

---

### Task 7: Doctor + end-to-end smoke

**Files:** Modify `orchestrator/src/cli.ts` (doctor shows graph status); Test `orchestrator/test/control-graph-e2e.test.ts`

- [ ] **Step 1: Write the failing e2e test** — build a `createGraph` over a temp cwd with a stub `execFileImpl` that, for `explain`, writes nothing but returns canned text, and pre-seed a `graphify-out/graph.json`; assert `status().built` true and `query('X')` returns the canned text. (Full CLI is stubbed — this proves the wrapper wiring.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** doctor addition: after the plan/harness section, print `graph: <built|not-initialized> (<node_count> nodes)` for the launch cwd via `createGraph({cwd:process.cwd()}).status()`.
- [ ] **Step 4: Run, verify pass + full suite + typecheck** — `cd orchestrator && bun test && bun run typecheck`.
- [ ] **Step 5: Manual smoke** — `cd orchestrator && bun bin/shuba.ts doctor` prints a `graph:` line for this repo.
- [ ] **Step 6: Commit** — `feat(control): graph doctor line + e2e`

---

## Self-Review

**Spec coverage** (against `2026-07-11-shuba-graphify-integration-design.md`):
- §2 wrapper over graphify CLI (no reimpl) → Tasks 1-3. ✓
- §3 shuba_graph_query/status MCP tools → Task 4. ✓
- §4 auto build/watch, not-initialized guard → Task 3. ✓
- §5 model guarantee (GRAPHIFY_OPENROUTER_MODEL, never Claude) → Global Constraints + Tasks 2/3/5. ✓
- §6 auto-disable client hook → Task 6. ✓
- §7 testing (status/query/lifecycle/guarantee/e2e) → all tasks. ✓
- §8 deferred exact CLI flags → grounded in Global Constraints + Task 2 verification. ✓

**Placeholder scan:** none. The one verification (exact initial-build command) is an explicit Task 2 step, grounded by the installed CLI's `--help` and `build-and-watch.sh`.

**Type consistency:** `GraphStatus` (Task 1) used by status/tools/doctor; `createGraph` return grows across Tasks 1-3 (`status`→`query`→`ensure`/`stopWatch`); `Config.graph` (Task 5) consumed by the bin. MCP/HTTP graph wiring (Task 4) matches the `graph` object shape.
