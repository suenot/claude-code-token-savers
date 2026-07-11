# Spec 0 — Bun + TypeScript migration of the shuba orchestrator

**Date:** 2026-07-11
**Status:** approved design, pre-implementation
**Repo:** develop in `claude-code-token-savers/orchestrator/`, then re-export to `suenot/shuba`.
**Depends on:** nothing. This is the foundation for Spec 1 (shuba-control + delegation) and Spec 2 (graphify integration).

## 1. Purpose

The orchestrator is currently plain JavaScript ESM run under Node (`node --test`, `#!/usr/bin/env node` bins). The new work (shuba-control, delegation, graphify wrapper) is non-trivial and benefits from static types. Rather than split the toolchain — TS for new code, JS for old — migrate the whole orchestrator to **TypeScript running on Bun** in one pass, so every subsequent spec is written natively on the new foundation.

Goals:
- Static typing across all orchestrator modules (catch wiring bugs at compile time — the planner/registry wiring is exactly the kind of stringly-typed code that types help).
- Bun runtime: faster startup, native TS execution (no separate build step for dev), `bun test`.
- Optional single-binary distribution via `bun build --compile`.

Non-goals:
- No behavior changes. This is a pure port — the proxy chain, compact-router, context-watchdog, rate-limiter must behave identically. Every existing test must pass after translation.
- No new features. shuba-control and graphify are separate specs.

## 2. Scope of the port

Translate every file under `orchestrator/src/` and `orchestrator/bin/` from `.js` to `.ts`:

```
src/cli.js            → cli.ts
src/planner.js        → planner.ts
src/registry.js       → registry.ts
src/supervisor.js     → supervisor.ts
src/config.js         → config.ts
src/launcher.js       → launcher.ts
src/router-bootstrap.js → router-bootstrap.ts
src/compact/*.js      → compact/*.ts
src/watchdog/*.js     → watchdog/*.ts
src/ratelimit/*.js    → ratelimit/*.ts
bin/*.js              → bin/*.ts  (shebang → #!/usr/bin/env bun)
test/*.test.js        → test/*.test.ts (bun test)
```

## 3. Runtime & tooling decisions

- **Runtime:** Bun (`>=1.1`). All `node:` built-ins currently used (`node:http`, `node:stream`, `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:url`, `node:events`) are Bun-supported — no rewrites of I/O logic.
- **Bins:** `#!/usr/bin/env bun`. `process.execPath` (used by builtin stages to re-spawn themselves) now resolves to the Bun binary — verify builtin stages (`compact-router`, `context-watchdog`, `rate-limiter`) still spawn correctly under Bun. This is the one real risk area; a smoke test per builtin stage covers it.
- **Tests:** `bun test`. Bun's test runner is Jest-style (`describe`/`test`/`expect`), but the existing suite uses `node:test` + `node:assert`. Two options — pick **(A)**:
  - (A) Keep `node:test`/`node:assert` imports; Bun runs them. Minimal churn, tests translate near-verbatim. **Recommended.**
  - (B) Rewrite to `bun:test` `expect`. Cleaner idiomatic Bun, but every assertion rewritten. Deferred.
- **Type-check:** `tsc --noEmit` in CI as the gate (Bun runs TS but does not type-check). `tsconfig.json`: `strict: true`, `moduleResolution: bundler`, `target: es2022`, `types: ["bun"]`.
- **Distribution:** add `bun build ./bin/shuba.ts --compile --outfile shuba` as an optional release artifact. Dev path stays `bun bin/shuba.ts`.

## 4. Typing approach

Introduce a small `types.ts` capturing the domain shapes that are currently implicit:
- `StageDescriptor` — the registry entry shape (`id`, `bin`, `defaultPort`, `dialect`, `terminal`, `healthPath`, `build(ctx) => {args, env}`, optional `builtin`/`requiresToken`/`clientPathSuffix`/`readerConstraint`).
- `Config` — `terminal`, `compressors: string[]`, `ports`, and the per-stage config blocks (`compactRouter`, `contextWatchdog`, `rateLimiter`).
- `PlannedStage` / `PlanResult` — planner output (`chain`, `head`, `errors`).
- `ChainHandle` — supervisor return (`down()`, `status()`).

These types make the planner↔registry↔supervisor contract explicit. No runtime validation library (YAGNI) — types are compile-time only; config is still parsed with `JSON.parse` and trusted (loopback-local tool).

## 5. Migration procedure (order, so the chain is never broken)

1. Add `tsconfig.json`, update `package.json` (`"type": "module"`, scripts: `dev`, `test`, `typecheck`, `build`), add Bun to `engines`.
2. Port leaf modules with no internal deps first: `config`, `estimate`, `translate`, `matcher`, `cut`, `rewrite`.
3. Port mid-layer: `registry`, `planner`, `supervisor`, `launcher`, `router-bootstrap`.
4. Port `cli` last (top of the graph).
5. Port each server (`compact/server`, `watchdog/server`, `ratelimit/server`) + its bin together, then smoke-test that builtin stage spawns under Bun.
6. Port tests file-by-file; run `bun test` green after each.
7. Delete the `.js` originals only once the `.ts` twin passes its tests.

## 6. Testing / acceptance

- `bun test` passes with the same test count as today (70 + rate-limiter's 6 = 76), all green.
- `tsc --noEmit` clean under `strict`.
- Manual smoke: `bun bin/shuba.ts doctor` prints the planned chain; `bun bin/shuba.ts up` brings the full chain up (compact-router → context-watchdog → headroom → pxpipe → rate-limiter) and each `/health` returns ok.
- Each builtin stage (`compact-router`, `context-watchdog`, `rate-limiter`) confirmed to spawn under Bun via `process.execPath`.

## 7. Risks

- **`process.execPath` re-spawn:** builtin stages re-exec the runtime with a bin path. Under Bun this must still launch a Bun process that can import the `.ts` bin. Mitigation: the bin path passed in the registry points at the `.ts` file; `process.execPath` is the Bun binary; smoke test each stage.
- **Users without Bun:** shuba now requires Bun on PATH (or a compiled binary). Document in README; offer the `--compile` artifact so users need no Bun install.
- **node:test under Bun:** if any assertion behaves differently, fall back to that file's rewrite to `bun:test`. Low likelihood.
