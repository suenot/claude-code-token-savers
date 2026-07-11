# shuba Management Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A local, loopback-only web console (lightweight Bun + React SPA) served by `shuba-control`, showing chain health, delegation jobs (with live logs), the knowledge graph, config, and token-savings analytics.

**Architecture:** The SPA is a pure client of the Spec 1/2 control HTTP+WS API. New backend work is limited to a few read endpoints (`/api/chain`, `/api/stats`) and serving the built SPA from `staticDir`. The SPA is built with `bun build` and served statically by the control HTTP server on its port. No Next.js — one process, one port.

**Tech Stack:** Bun+TS (strict) backend; React 18 + TypeScript SPA built via `bun build`; native fetch + WebSocket; a light charting approach (inline SVG or a tiny lib). Backend endpoints get TDD; the SPA gets API-client unit tests + a build/serve smoke.

## Global Constraints

- Bun+TS strict; backend tests `bun test` (node:test/node:assert), `bun run typecheck` clean.
- Loopback-only; the console reuses the control server's CSRF/Origin/Host guards. Same-origin fetches from the served SPA omit/ set a loopback Origin and pass.
- The SPA is a pure API client — NO business logic duplicated from the engine.
- SPA source under `orchestrator/console/`; built output `orchestrator/console/dist/` (gitignored). Backend additions under `orchestrator/src/control/`.
- MVP surfaces (this plan): chain+health, delegation jobs with live logs, graph+config viewer, token-savings summary, live request feed, rate-limiter/watchdog monitors, harness registry. Additional polish surfaces (full log viewer, quick-actions beyond restart) are structured to extend but may be stubbed — any stub is `log()`-noted, never presented as complete.
- Charets/stats read from existing stage outputs (pxpipe `~/.pxpipe/events.jsonl`, headroom `/stats`) via a server-side collector — the SPA gets one merged payload.

---

### Task 1: `/api/chain` + `/api/stats` backend endpoints

**Files:** Create `orchestrator/src/control/collector.ts`; Modify `orchestrator/src/control/http.ts`; Test `orchestrator/test/control-collector.test.ts`, extend `orchestrator/test/control-http.test.ts`

**Interfaces:**
```ts
export function createCollector(opts: { pxpipeEventsPath?: string; fetchImpl?: typeof fetch; stageUrls?: Record<string,string> }): {
  chain(): Promise<Array<{ id: string; port: number; healthy: boolean }>>;   // GET each stage /health
  stats(): Promise<{ pxpipe?: any; headroom?: any; totals: { saved_pct?: number; events?: number } }>;
};
```
`chain()` reads the planned stages (passed in) and GETs each `/health`. `stats()` tails `~/.pxpipe/events.jsonl` (count + rough saved_pct average) and GETs headroom `/stats`; merges into `totals`. All network/file guarded (missing → omitted, never throws). New HTTP routes: `GET /api/chain` → `collector.chain()`; `GET /api/stats` → `collector.stats()` (Origin-guarded like the rest).

- [ ] **Step 1: Write the failing test** — `collector.chain()` with a stub `fetchImpl` marking one stage healthy/one down; `collector.stats()` with a temp events.jsonl of 3 lines → `totals.events===3`; missing files/urls → omitted, no throw. HTTP: `GET /api/chain` and `GET /api/stats` return the collector output.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `collector.ts` + routes.
- [ ] **Step 4: Run, verify pass** — `bun test test/control-collector.test.ts test/control-http.test.ts && bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(console): chain + stats collector endpoints`

---

### Task 2: SPA scaffold + build pipeline

**Files:** Create `orchestrator/console/index.html`, `console/src/main.tsx`, `console/src/App.tsx`, `console/tsconfig.json` (or extend root), `console/README.md`; Modify `orchestrator/package.json` (scripts `console:build`, `console:dev`), `orchestrator/.gitignore` (`console/dist`)

- [ ] **Step 1: Add React deps** — `cd orchestrator && bun add react react-dom && bun add -d @types/react @types/react-dom`.
- [ ] **Step 2: Create the scaffold** — `index.html` with a `#root` div + `<script type="module" src="/main.js">`; `main.tsx` renders `<App/>` into `#root`; `App.tsx` renders a placeholder shell (`<h1>shuba console</h1>` + nav tabs stub). Add `console:build` = `bun build console/src/main.tsx --outdir console/dist --target browser` and `console:dev` = same with `--watch`.
- [ ] **Step 3: Build smoke** — `cd orchestrator && bun run console:build && test -f console/dist/main.js && echo OK`.
- [ ] **Step 4: Commit** — `feat(console): React SPA scaffold + bun build pipeline`

(No unit test this task — the deliverable is a building scaffold; the build smoke is the gate.)

---

### Task 3: API client + typed models

**Files:** Create `orchestrator/console/src/api.ts`, `console/src/types.ts`; Test `orchestrator/test/console-api.test.ts`

**Interfaces:** `console/src/api.ts` exports typed functions: `getChain()`, `getStats()`, `getJobs()`, `getJob(id)`, `getJobResult(id)`, `delegate(input)`, `getHarnesses()`, `getGraph()`, `graphQuery(q)` — each a `fetch` to the matching `/api/...` route (relative URLs, same-origin), returning parsed JSON, with a shared error wrapper. `openLogStream(id, onChunk)` opens the `/api/stream/logs/:id` WebSocket. Mirror the backend response shapes in `console/src/types.ts`.

- [ ] **Step 1: Write the failing test** (runs under bun test with a stub global fetch) — assert `delegate({task})` POSTs to `/api/delegate` with `Content-Type: application/json` and returns parsed JSON; `getChain()` GETs `/api/chain`. (Import the api module; inject/override `globalThis.fetch` with a recording stub.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `api.ts` + `types.ts`. Ensure `delegate` sets the JSON content-type (required by the CSRF guard).
- [ ] **Step 4: Run, verify pass** — `bun test test/console-api.test.ts && bun run typecheck && bun run console:build`.
- [ ] **Step 5: Commit** — `feat(console): typed API client`

---

### Task 4: Chain & health + harness views

**Files:** Create `console/src/views/ChainView.tsx`, `console/src/views/HarnessView.tsx`, `console/src/components/Card.tsx`; Modify `App.tsx` (tab nav)

- [ ] **Step 1: Implement** `ChainView` (polls `getChain()` every ~2s, renders each stage id/port with a green/red health dot) and `HarnessView` (`getHarnesses()` → table of id + installed). Add a minimal `Card` component and wire both into `App`'s tab nav. Use a small `useInterval` hook.
- [ ] **Step 2: Build smoke** — `cd orchestrator && bun run console:build && test -f console/dist/main.js`.
- [ ] **Step 3: Commit** — `feat(console): chain/health + harness views`

(Component rendering is validated by the build + the served smoke in Task 8; API calls are unit-tested in Task 3.)

---

### Task 5: Delegation view with live logs

**Files:** Create `console/src/views/JobsView.tsx`, `console/src/components/DelegateForm.tsx`, `console/src/hooks/useLogStream.ts`; Modify `App.tsx`

- [ ] **Step 1: Implement** `JobsView`: `getJobs()` list (id/status/harness/model/elapsed), a `DelegateForm` (task textarea + optional harness/model/isolation → `delegate()`), and per-job "view logs" that opens `openLogStream(id, onChunk)` via `useLogStream` and appends chunks live; a "result" button calls `getJobResult(id)`. Poll the job list every ~2s.
- [ ] **Step 2: Build smoke** — build succeeds.
- [ ] **Step 3: Commit** — `feat(console): delegation view with live log streaming`

---

### Task 6: Graph + config + savings views

**Files:** Create `console/src/views/GraphView.tsx`, `console/src/views/ConfigView.tsx`, `console/src/views/SavingsView.tsx`; Modify `App.tsx`

- [ ] **Step 1: Implement**:
  - `GraphView`: `getGraph()` status (built/node_count/watching) + a query box → `graphQuery(q)` result.
  - `ConfigView`: read-only render of the running config (add a `GET /api/config` route to the collector/http in this task — returns the loaded `Config` minus secrets; test it in `control-http.test.ts`). Editing is a stretch — render + a "copy" button; note inline that live-edit is deferred.
  - `SavingsView`: `getStats()` → totals (events, saved_pct) + a simple inline-SVG bar per stage. No heavy chart lib.
- [ ] **Step 2: Add + test the `GET /api/config` route** (Origin-guarded; returns config with any `*ApiKey`/secret fields omitted). `bun test test/control-http.test.ts`.
- [ ] **Step 3: Build smoke** + `bun run typecheck`.
- [ ] **Step 4: Commit** — `feat(console): graph, config, savings views + /api/config`

---

### Task 7: Request feed + monitors

**Files:** Create `console/src/views/RequestFeedView.tsx`, `console/src/views/MonitorsView.tsx`; Modify `console/src/api.ts` (feed source), `orchestrator/src/control/http.ts` (a `GET /api/requests?since=` reading recent `~/.pxpipe/events.jsonl` lines via the collector)

- [ ] **Step 1: Add + test `GET /api/requests`** — collector method `recentRequests(limit)` tails events.jsonl → last N parsed entries (timestamp/status/durationMs/reason/tokens). Test in `control-collector.test.ts` with a temp events file.
- [ ] **Step 2: Implement** `RequestFeedView` (polls `/api/requests`, table with a 429 highlight) and `MonitorsView` (derives rate-limiter/watchdog signals from `/api/stats` + `/api/chain` — best-effort; where a signal isn't exposed yet, show "n/a" and note it, don't fabricate).
- [ ] **Step 3: Build smoke** + typecheck + `bun test test/control-collector.test.ts`.
- [ ] **Step 4: Commit** — `feat(console): request feed + monitors`

---

### Task 8: Serve the SPA from control + doctor + smoke

**Files:** Modify `orchestrator/bin/shuba-control.ts` (pass `staticDir: console/dist` to `createControlHttp`), `orchestrator/src/cli.ts` (print console URL on `shuba run`), `orchestrator/README.md` / `orchestrator/console/README.md`

- [ ] **Step 1: Wire static serving** — in `bin/shuba-control.ts`, when HTTP role is active, resolve `console/dist` (via `fileURLToPath(new URL('../console/dist', import.meta.url))`) and pass as `staticDir` so `GET /` serves the SPA. Confirm `http.ts`'s static handler (Task 8 of Spec 1) serves `index.html` for `/` and assets; if it only serves exact files, add an SPA fallback (unknown non-/api GET → `index.html`).
- [ ] **Step 2: Test** the SPA-fallback route in `control-http.test.ts` (with a temp staticDir containing `index.html`, `GET /` and `GET /someroute` → the index html; `GET /api/...` unaffected).
- [ ] **Step 3: Build + full gate** — `cd orchestrator && bun run console:build && bun test && bun run typecheck`.
- [ ] **Step 4: Manual smoke** — `cd orchestrator && bun run console:build && SHUBA_CONTROL_HTTP=1 PORT=47832 bun bin/shuba-control.ts & sleep 1; curl -s 127.0.0.1:47832/ | grep -qi '<div id="root"' && echo "SPA-OK"; curl -s 127.0.0.1:47832/api/harnesses | head -c 80; kill %1`. Expect `SPA-OK` + harness JSON.
- [ ] **Step 5: Doctor** — add a `console: http://127.0.0.1:<port>/` line to `doctor` when control HTTP is enabled. Print the console URL on `shuba run`.
- [ ] **Step 6: Commit** — `feat(console): serve SPA from control server + doctor/url + docs`

---

## Self-Review

**Spec coverage** (against `2026-07-11-shuba-frontend-console-design.md`):
- §2 lightweight Bun+React SPA served by control (no Next.js) → Tasks 2, 8. ✓
- §3 surfaces: chain+health (4), delegation+live logs (5), graph+config (6), savings (6), request feed (7), monitors (7), harness registry (4) → covered. Log viewer / advanced quick-actions → structured-extendable, noted as MVP boundary in Global Constraints. ✓ (with explicit MVP note)
- §4 architecture (SPA pure client; thin read endpoints; server-side collector merges stats) → Tasks 1, 3, 7. ✓
- §5 loopback-only, reuse guards → Global Constraints + reuse of Spec 1 CSRF/Origin. ✓
- §6 build & serve (bun build, served at control root, URL printed) → Tasks 2, 8. ✓
- §7 testing (endpoint TDD + API-client unit + build/serve smoke) → Tasks 1/3/6/7 TDD, 2/4/5 build smoke, 8 serve smoke. ✓
- §8 deferred (chart lib, exact stats schema, supervisor control channel) → SavingsView uses inline SVG (no lib); stats schema derived in Task 1; stage start/stop from console is NOT in this MVP (only health view) — noted. ✓

**Placeholder scan:** MVP boundaries are explicitly `log()`/noted, not silent. No "TBD". Frontend component tasks use build-smoke gates (honest — full component TDD for a dashboard is out of scope) with API logic unit-tested separately.

**Type consistency:** `console/src/types.ts` mirrors backend shapes (JobRecord/GraphStatus/harness rows/stats). `api.ts` function names used by all views. Collector `chain()/stats()/recentRequests()` consumed by `/api/chain|stats|requests` and their views.
