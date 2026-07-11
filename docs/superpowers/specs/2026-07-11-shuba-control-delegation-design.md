# Spec 1 — shuba-control + multi-harness delegation

**Date:** 2026-07-11
**Status:** approved design, pre-implementation
**Repo:** develop in `claude-code-token-savers/orchestrator/` (Bun+TS after Spec 0), re-export to `suenot/shuba`.
**Depends on:** Spec 0 (Bun+TS migration). Written natively in TS.

## 1. Purpose

Today shuba is a pure HTTP proxy on `ANTHROPIC_BASE_URL`: it only sees `/v1/messages` and cannot receive a "delegate this task" instruction from Claude Code. This spec adds a **new companion component, `shuba-control`** — a stdio MCP server that Claude Code connects to — exposing a tool that lets Claude Code hand a task off to another harness CLI (opencode, gemini, qwen, cursor-agent, claude) running on **its own provider/subscription**, so heavy sub-work does not burn Claude tokens.

`shuba-control` is a reusable host: Spec 2 (graphify) mounts its tools on the same server. This spec builds the server + the delegation capability.

## 2. Architecture

```
Claude Code ──stdio MCP──> shuba-control ──spawn──> opencode / gemini / qwen / cursor-agent / claude CLI
                                │
                                ├── job store (in-memory + ~/.shuba/jobs/<id>.json + <id>.log)
                                └── classifier (cheap OpenRouter deepseek) for hybrid harness/model choice
```

- `shuba-control` is a **new builtin**, registered in `registry.ts` as `control`. Unlike proxy stages it is **not in the ANTHROPIC_BASE_URL chain** — it is a sidecar. The supervisor starts it alongside the chain on `shuba up`/`run`.
- **Transport: stdio MCP.** Claude Code spawns `shuba-control` as an MCP server (entry written to the project/user MCP config). Rationale: simplest local integration, no port/auth surface. `shuba run` can also auto-register it.
- The control server is an MCP server implemented with the MCP TypeScript SDK over stdio.
- **Auto-registration ("just works"):** `shuba run` writes the MCP-server entry into the project/user MCP config automatically (idempotent, removed/left intact on exit) so the user never configures anything by hand. If an entry already exists it is reconciled, not duplicated.
- **Dual frontend on one engine:** the job/classifier/store engine is a runtime-agnostic core module. Two adapters sit on top of it — the **stdio MCP server** (for Claude Code, this spec) and an **HTTP + WebSocket API** (for the management frontend, Spec 3). The HTTP API is defined here as a thin wrapper over the same engine so Spec 3 only builds UI, not backend.

## 3. MCP tools

| tool | input | output |
|---|---|---|
| `shuba_delegate` | `{task, harness?, model?, cwd?, files?, isolation?}` | `{job_id, harness_chosen, model_chosen}` (returns immediately) |
| `shuba_job_status` | `{job_id}` | `{status, harness, model, elapsed_ms, tail}` — status ∈ `queued\|running\|done\|failed` |
| `shuba_job_result` | `{job_id}` | `{status, result, exit_code, log_path}` — full captured output |
| `shuba_harness_list` | `{}` | installed harnesses + their available models/flags |

**Execution model: async + polling.** `shuba_delegate` enqueues and returns a `job_id` at once; the harness CLI may run for minutes. Claude Code polls `shuba_job_status` and reads `shuba_job_result` when `done`. This keeps Claude Code's turn free and allows many delegations in parallel.

## 4. Job store

- In-memory map `job_id → JobRecord` plus durable mirror at `~/.shuba/jobs/<id>.json` (status, harness, model, cwd, timestamps, exit code) and `~/.shuba/jobs/<id>.log` (streamed stdout+stderr).
- Durable so `shuba_job_result` survives a control restart and so a dashboard can read history.
- `JobRecord`: `{id, task, harness, model, cwd, isolation, status, startedAt, endedAt, exitCode, resultPath, logPath}`. Timestamps passed in / stamped by the server (Bun runtime has `Date.now`).
- Concurrency capped by config (`delegate.concurrency`, default 3); excess jobs stay `queued` until a slot frees.

## 5. Hybrid selection — harness and model are independent fields

`harness` and `model` are **separate, both optional**:

1. If `harness` given → use it. Else the **classifier** picks a harness.
2. If `model` given → use it. Else use the chosen harness's default model from config (or the classifier's paired suggestion).

Classifier = the same cheap OpenRouter model used by compact-router/context-watchdog (`deepseek/deepseek-v4-flash`). It reads the task text + the config `policy` hints and returns `{harness, model}`. Policy hints are **English** (portable, stable for the model), plus a `default`:

```json
"delegate": {
  "concurrency": 3,
  "isolation": "none",
  "default": { "harness": "opencode", "model": "deepseek/deepseek-v4-flash" },
  "policy": [
    { "when": "verbatim output, exact hex/ids/secrets", "harness": "claude",   "model": "haiku" },
    { "when": "code edits, refactor in repo",           "harness": "opencode", "model": "deepseek/deepseek-v4-flash" },
    { "when": "quick question, search, summarize",       "harness": "gemini",   "model": "gemini-flash" }
  ]
}
```

No hard-coded routing logic — the code only supplies the task + policy to the classifier and applies overrides/fallback.

## 6. Harness adapters

Each harness is a small adapter object; adding one is a single entry:

```ts
type HarnessAdapter = {
  id: string;
  bin: string;
  buildArgs(task: string, opts: { model?: string; cwd?: string }): string[];
  extractResult(stdout: string): string;
};
```

Initial set (headless/non-interactive invocation; exact flags verified during implementation against each CLI's `--help`):

```
opencode     → opencode run -m <model> "<task>"                     (cwd)
gemini       → gemini -m <model> -p "<task>"
qwen         → qwen -m <model> -p "<task>"
cursor-agent → cursor-agent -m <model> -p "<task>"
claude       → claude --model <model> -p "<task>" --dangerously-skip-permissions
```

`model` is optional per adapter — an adapter that has no model flag ignores it. `shuba_harness_list` reports which harnesses are actually on PATH (detected like `cli.ts doctor` does with `command -v`).

## 7. Isolation (both modes, per-call)

`isolation` field on `shuba_delegate`, default from `delegate.isolation` config:
- `"none"` (default): job runs in the project `cwd`. Parallel jobs may edit the same files — the result payload carries a warning when >1 job shares a cwd.
- `"worktree"`: shuba creates a fresh `git worktree` for the job, runs the harness there, and reports the worktree path + diff in the result. Caller decides whether to merge. Auto-removed if unchanged. Mirrors the Agent tool's worktree isolation.

## 8. Config additions

Extend `Config` (`~/.shuba/chain.json`) with the `delegate` block (§5) and register `control` in the registry as a builtin sidecar. `shuba up`/`run` start it; `shuba doctor` reports its status and lists detected harnesses.

## 9. Security

- Delegated CLIs run locally in the user's project; `claude` harness uses `--dangerously-skip-permissions` (consistent with `shuba run`'s existing behavior) — document that delegated claude jobs run tools without prompts.
- Non-claude harnesses use their own provider credentials from the environment; shuba passes through env, never injects Anthropic keys into them.
- stdio transport = no inbound network surface.

## 10. Testing / acceptance

- Unit: classifier selection (explicit harness/model wins; fallback to default; policy hint → harness), adapter `buildArgs`/`extractResult`, job store lifecycle (queued→running→done/failed, concurrency cap, durable mirror), isolation path selection.
- Integration: a fake harness bin (echo script) exercised end-to-end through `shuba_delegate` → poll `shuba_job_status` → `shuba_job_result`; worktree isolation creates/removes a worktree.
- MCP: server lists the four tools over stdio; a scripted MCP client round-trips a delegation.
- Manual: real `opencode`/`gemini` delegation of a trivial task from a live Claude Code session.

## 11. Open items deferred to implementation

- Exact headless flags per CLI (`opencode run` vs `-p`, cursor-agent model flag) — verify against installed versions.
