# shuba — design spec

**Date:** 2026-07-10
**Status:** approved design, pre-implementation
**Repo:** `claude-code-token-savers` (new subfolder `orchestrator/`)

## 1. Purpose

Only one server can own `ANTHROPIC_BASE_URL` at a time, but the token-saving proxies each transform a Claude Code request in a different, complementary way:

- **pxpipe** — renders bulky request parts to dense PNGs (Fable-only reader).
- **headroom** — content-aware compression of the request (JSON/code/text).
- **link-assistant/router** — translates the Anthropic Messages API to another provider (Codex/Gemini/Qwen); terminal.

Run bare, they fight over the single base-URL slot. **shuba** is a thin Node launcher that starts the enabled proxies each on its own port, wires each proxy's *upstream* to the next stage (a chain), points Claude Code at the head, and launches `claude` — so the proxies **layer** instead of collide.

Metaphor: Clother is a shirt (swap the provider); **shuba is a fur coat** — multiple warm layers worn in order over Claude Code. Each proxy is one layer of the coat.

Non-goals (v1): no vendored proxy code (uses the installed global binaries), no auto-install, no unified aggregated dashboard, no new compression/routing logic of its own.

## 2. Facts about the wrapped proxies (verified from source, 2026-07-10)

| Proxy | Default port | How its upstream is set | Dialect | Terminal? | Constraint |
|---|---|---|---|---|---|
| **pxpipe** (`pxpipe-proxy`) | 47821 (`PORT`) | `ANTHROPIC_UPSTREAM` (overrides `PXPIPE_UPSTREAM`; default `https://api.anthropic.com`) | anthropic → anthropic | no | **reader is Fable-only** — imaged content only valid when the terminal provider is Anthropic-Fable |
| **headroom** (`headroom proxy`) | 8787 (`--port`) | proxy upstream (default anthropic; supports LiteLLM/Bedrock targets) — exact flag to be confirmed in implementation from `headroom proxy --help` | anthropic → anthropic | no | none material |
| **router** (`link-assistant-router`) | 8080 (`ROUTER_PORT`) | `UPSTREAM_PROVIDER=codex\|gemini\|qwen\|openai-compatible\|…`, `UPSTREAM_BASE_URL` (default anthropic) | anthropic → provider | **yes** | client must use path suffix `/api/latest/anthropic` and an `ANTHROPIC_API_KEY=la_sk_…` token minted via `POST /api/tokens` |

## 3. Chain validity rules (the core of the tool)

1. **Order is fixed:** compressors (pxpipe, headroom) operate on the Anthropic dialect, so they come **before** any translation. The router translates Anthropic → provider, so it is **always last** (terminal).
2. **pxpipe requires an Anthropic-Fable terminal.** Images target Fable's vision channel; Codex/Gemini/Qwen cannot read them. → `pxpipe` + `terminal != anthropic` is a **hard error**.
3. **Exactly one terminal.** If `terminal == anthropic`, the chain ends at `https://api.anthropic.com`. Otherwise the router is auto-appended as the terminal with the matching `UPSTREAM_PROVIDER`.
4. **Each stage's upstream = the base URL of the next stage.** The head's base URL (+ token/path if the head chain includes the router at the tail) is exported to Claude Code.

Valid example chains:

- `Claude Code → pxpipe → headroom → api.anthropic.com` (compress on Anthropic-Fable)
- `Claude Code → headroom → router(codex)` (compress + route to Codex; pxpipe excluded)
- `Claude Code → router(codex)` (route only)

## 4. Architecture (isolated modules)

Each module has one purpose, a clear interface, and is independently testable.

### 4.1 `registry` — static proxy descriptors
A pure data map. For each proxy: `{ id, bin, defaultPort, portEnvOrFlag, upstreamEnvOrFlag, healthPath, dialect: 'anthropic'|'translates', terminal: bool, readerConstraint?: 'fable-only', extraEnv?, requiresToken?: bool, clientPathSuffix? }`.
- **Interface:** `registry[id] -> descriptor`.
- **Depends on:** nothing.

### 4.2 `planner` — pure config → ordered chain + env
Takes the config object (§5) + registry, returns either `{ ok: true, chain: Stage[], head: { baseUrl, apiKey?, extraEnv } }` or `{ ok: false, errors: string[] }`.
- Applies §3 rules; assigns ports; computes each stage's upstream from the next stage's base URL; appends router when `terminal != anthropic`.
- **Interface:** `plan(config, registry) -> PlanResult`. No I/O, no network, no spawning.
- **Depends on:** `registry`.
- **This is the primary unit under test.**

### 4.3 `router-bootstrap` — token minting for the router stage
If the plan contains the router stage: start it (or reach it), `POST /api/tokens` to mint an `la_sk_…` token, and produce the head `ANTHROPIC_API_KEY` + `/api/latest/anthropic` path suffix.
- **Interface:** `bootstrapRouter(routerStage) -> { apiKey, pathSuffix }`.
- **Depends on:** a running router process (from supervisor) + http client.

### 4.4 `supervisor` — process lifecycle
Given the ordered chain, spawn each stage as a child process with its computed env, poll each `healthPath` until ready (timeout → abort + report the failing stage), track PIDs, and tear the whole chain down on any child exit or on `SIGINT`/`SIGTERM`. Aggregates each child's stdout/stderr with an `[id]` prefix.
- **Interface:** `up(chain) -> handle`, `handle.down()`, `handle.status()`.
- **Depends on:** `child_process`, http client for health checks.

### 4.5 `launcher` — hand off to Claude Code
After the chain is healthy, spawn `claude` (inheriting stdio) with `ANTHROPIC_BASE_URL = head.baseUrl` (+ `ANTHROPIC_API_KEY`, extra env) plus any user-passed `-- <claude args>`. When `claude` exits, call `handle.down()`.
- **Interface:** `run(head, claudeArgs, handle)`.
- **Depends on:** `supervisor` handle.

### 4.6 `cli` — command surface
`shuba run [-- <claude args>]` (default: plan → up → bootstrap → launch), `shuba up`, `shuba down`, `shuba status`, `shuba doctor`, `shuba config` (show/edit path).
- **Depends on:** all of the above.

## 5. Config — `~/.shuba/chain.json`

```json
{
  "terminal": "anthropic",
  "compressors": ["headroom", "pxpipe"],
  "ports": { "pxpipe": 47821, "headroom": 8787, "router": 8080 }
}
```

- `terminal`: `anthropic` | `codex` | `gemini` | `qwen` | `openai-compatible`.
- `compressors`: subset of `["headroom", "pxpipe"]`, in chain order (first = closest to Claude Code).
- `ports`: optional overrides; registry defaults otherwise.
- Router is implied (auto-appended) when `terminal != anthropic`.
- Missing file → a sensible default (`terminal: anthropic`, `compressors: ["headroom"]`) is written on first run and reported.

## 6. `shuba doctor`

Detects which proxy binaries are installed (`pxpipe`, `headroom`, `link-assistant-router`) and their versions; for each missing one referenced by the config, prints the install command (`npm i -g pxpipe-proxy`, `uv tool install headroom-ai`, router install). Also validates the current config through `planner` and prints the resolved chain (or the validation errors) **without starting anything**.

## 7. Error handling

- **Validation errors** (from `planner`) are printed and the process exits **before** any child is spawned.
- **Health-check timeout**: tear down every already-started stage and report which stage failed and its last log lines.
- **Missing binary**: fail fast with the `doctor` hint.
- **Router token mint failure**: tear down, print the router's error body.
- **Signal handling**: `SIGINT`/`SIGTERM` → graceful `handle.down()` of the whole chain.

## 8. Testing

- **Unit (primary):** `planner` — table of `(config) → expected ordered chain + env` and every rejection case (pxpipe+codex, unknown terminal, empty chain, port collisions). Pure, no network.
- **Unit:** `registry` shape sanity; `router-bootstrap` against a mock HTTP server returning a fake `la_sk_` token.
- **Integration (smoke):** start one real stage (headroom or router) pointed at a local mock upstream; assert health-check passes and teardown kills the PID. Keep it single-stage to stay fast and hermetic.
- No end-to-end test against real provider APIs in v1.

## 9. Deliverables / layout

```
orchestrator/
  package.json          # bin: { "shuba": "./bin/shuba.js" }
  bin/shuba.js
  src/{registry,planner,router-bootstrap,supervisor,launcher,cli}.js
  test/planner.test.js  # + registry, router-bootstrap
  README.md             # metaphor, install, config, commands, valid chains, conflict rules
```
Plus a short section in the repo root `README.md` introducing shuba alongside rtk/caveman/graphify/pxpipe/headroom.

## 10. Open items to confirm during implementation

- Exact `headroom proxy` upstream flag/env (from `headroom proxy --help`).
- Router health endpoint path (assume `GET /` or a documented health route; confirm from source).
- Whether pxpipe's port is `PORT` env only or also a flag (README shows `PORT`).
