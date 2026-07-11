# Spec 3 — shuba management console (local frontend)

**Date:** 2026-07-11
**Status:** approved design, pre-implementation
**Repo:** develop in `claude-code-token-savers/orchestrator/` (Bun+TS), re-export to `suenot/shuba`.
**Depends on:** Spec 0 (Bun+TS), Spec 1 (shuba-control HTTP+WS API), Spec 2 (graphify tools). Consumes the HTTP+WS API; builds no backend of its own.

## 1. Purpose

A local, loopback-only web console to see and control the whole shuba stack from a browser: chain health, delegation jobs, the knowledge graph, config, and token-savings analytics — one pane instead of scattered per-proxy dashboards (pxpipe :47821, headroom :8787) and CLI-only status.

## 2. Stack decision — lightweight Bun + React SPA

**Not Next.js.** For a single-user loopback control panel, Next.js's SSR/app-router/build server is overhead with no payoff. Instead:
- **Bun serves a static React SPA** (built with `bun build`) from the shuba-control HTTP server on a dedicated path (e.g. `http://127.0.0.1:47830/`).
- The SPA talks to the shuba-control **HTTP + WebSocket API** (defined in Spec 1) for all data — REST for reads/actions, WebSocket for live streams (job logs, request feed, health).
- One process, one port, no separate Node/Next server. `bun build --watch` for dev.
- React + a small state layer (TanStack Query for REST, native WS). Charts via a light lib (uPlot/Recharts). No CSS framework mandate — follow a clean minimal system.

Rationale: keeps shuba a self-contained tool the user starts with `shuba run`; the console comes up with it, no extra install.

## 3. Surfaces (comprehensive)

**Approved four:**
1. **Chain & health** — every stage (compact-router, context-watchdog, headroom, pxpipe, rate-limiter, control) with health, port, uptime, upstream wiring diagram; per-stage start/stop/restart.
2. **Delegation (jobs)** — job list with status/harness/model/elapsed; create a delegation (task + optional harness/model/isolation); **live logs over WebSocket**; results, cancel, re-run. History with durations and per-harness counts.
3. **Graph & config** — graph status (built/watching/node count/last build), manual build/query, results view; `chain.json` editor with schema validation and safe apply (re-plan preview before save).
4. **Token savings** — unified analytics from pxpipe (`events.jsonl`), headroom (`/stats`), compact-router and context-watchdog (interception counts, cheap-model spend) — totals, per-tool breakdown, time-series charts, estimated USD saved.

**Additional surfaces (added per "do everything you can imagine"):**
5. **Live request feed** — real-time stream of proxied `/v1/messages`: timestamp, method/path, status, duration, compressed?/reason, tokens in/out, cache_read — the unified version of pxpipe's terse console line, filterable, with a 429 highlight.
6. **Rate-limiter monitor** — current rps, burst tokens, queue depth, active cooldown countdown (from upstream Retry-After), recent 429 events.
7. **Context-watchdog panel** — current session context size vs threshold, summary-cache hits/reuse, where cuts land, cheap-model summarize latency.
8. **Harness registry** — which CLIs are on PATH, their models, a "test invoke" button (trivial task) to verify each adapter works.
9. **Log viewer** — tail each stage's stderr live (WebSocket), download.
10. **Quick actions bar** — global optimization kill switch, per-proxy toggle, rebuild graph, (un)register MCP, tear down chain.
11. **Alerts/toasts** — 429 storm, job failed, stage down, graph build finished.

## 4. Architecture

```
Browser (React SPA, served by Bun) ──REST + WS──> shuba-control HTTP/WS API ──> engine + stage stats
```

- SPA is a pure client of the Spec 1 API; **no business logic duplicated** in the frontend.
- The HTTP/WS API (Spec 1) is extended with read endpoints the console needs: `GET /api/chain`, `GET /api/jobs`, `GET /api/graph`, `GET /api/stats`, `GET /api/harnesses`, `WS /api/stream` (multiplexed channels: `requests`, `jobs/<id>`, `logs/<stage>`, `health`). These are thin reads over data the stages already produce (pxpipe events.jsonl, headroom /stats, supervisor status, job store).
- Aggregation for surface 4 (token savings) is a small server-side collector that fans out to each stage's existing stats endpoint/file and merges — the SPA gets one merged payload.

## 5. Security

- **Loopback only** (`127.0.0.1`), no inbound token — consistent with the rest of shuba. The console binds the same interface as the proxies.
- Config editing and stage control are powerful; because it is loopback single-user, no auth layer (documented assumption). If ever exposed beyond loopback, that is a separate spec.

## 6. Build & serve

- Source in `orchestrator/console/` (React+TS). `bun build console/index.tsx --outdir console/dist`.
- shuba-control serves `console/dist` statically at its root path and mounts the `/api` routes.
- Dev: `bun build --watch` + the console points at the running shuba-control API.
- `shuba run` prints the console URL (like it prints the chain today).

## 7. Testing / acceptance

- API: each read endpoint returns the expected shape against a running chain; WS channels emit on real events (a delegation streams logs; a proxied request appears in the feed).
- Component: job-create form, config editor validation (rejects an invalid chain with the planner's errors), charts render from a fixture stats payload.
- E2E (light): start chain + control, open console, confirm chain health renders, create a fake-harness delegation and watch it stream to `done`.
- Manual: full walkthrough against a live session — see request feed, savings totals, delegate a task, query the graph, edit and apply config.

## 8. Open items deferred to implementation

- Chart library pick (uPlot vs Recharts) — decide at build time by bundle size.
- Exact merged schema for the token-savings collector — derive from each stage's actual stats output during implementation.
- Whether stage start/stop from the console needs the supervisor to expose a control channel (today teardown is tied to the foreground process) — may scope a minimal supervisor control API into Spec 1's HTTP layer.
