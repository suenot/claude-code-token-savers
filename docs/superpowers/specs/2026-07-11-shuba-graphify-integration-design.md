# Spec 2 — graphify integration into shuba

**Date:** 2026-07-11
**Status:** approved design, pre-implementation
**Repo:** develop in `claude-code-token-savers/orchestrator/` (Bun+TS), re-export to `suenot/shuba`.
**Depends on:** Spec 0 (Bun+TS migration) and Spec 1 (shuba-control host). Mounts its tools on the same `shuba-control` MCP server.

## 1. Purpose

Today graphify is wired into Claude Code as a client-side SessionStart hook + skill (`graphify/setup.sh`). This spec moves the *orchestration* of graphify into shuba: shuba builds and maintains a per-project knowledge graph and exposes it to Claude Code as MCP tools, so Claude Code queries the graph instead of reading whole files. The graph's semantic extraction stays on the **cheap OpenRouter model (`deepseek/deepseek-v4-flash`), never Claude tokens** — this is a hard guarantee, not a default.

## 2. Approach — thin wrapper over the existing graphify CLI

shuba does **not** reimplement graph logic. `shuba-control` shells out to the already-configured graphify CLI (from `graphify/setup.sh`: OpenRouter backend, no-media toggle, ignore patches) and reads its `graph.json` output. This reuses the entire existing setup and adds minimal code.

```
shuba-control ──spawn──> graphify build/query/watch ──> graphify-out/graph.json
     │                        (OpenRouter deepseek, per graphify/providers.json)
     └── MCP tools: shuba_graph_query, shuba_graph_status
```

## 3. MCP tools (added to shuba-control)

| tool | input | output |
|---|---|---|
| `shuba_graph_query` | `{query, cwd?}` | graphify query result (nodes/paths/explanation) for the project graph |
| `shuba_graph_status` | `{cwd?}` | `{built: bool, path, node_count, last_built, watching: bool}` |

`cwd` defaults to the project shuba was launched in.

## 4. Lifecycle — auto build/watch on shuba up/run

On `shuba up`/`run`, shuba-control checks the launch cwd:
- **Graph exists** (`graphify-out/graph.json` present) → start graphify `watch` for incremental updates.
- **No graph, project small OR `~/.shuba/autobuild` set** → headless `graphify build` on deepseek, then watch.
- **No graph, project large, no autobuild** → do nothing but report via `shuba_graph_status` that it is not initialized (mirrors the current guard against indexing huge/root folders — never silently burn the budget).

This reuses the exact policy from `graphify/README.md` (the `~/.graphify/autobuild` and no-media flags), just triggered by shuba instead of the client SessionStart hook.

## 5. Model guarantee

shuba sets `GRAPHIFY_OPENROUTER_MODEL` (default `deepseek/deepseek-v4-flash`) and the OpenRouter provider env when spawning graphify, so both build and semantic extraction run off-Claude. Configurable via a `graph` block in `~/.shuba/chain.json`:

```json
"graph": {
  "model": "deepseek/deepseek-v4-flash",
  "autobuild": false,
  "noMedia": true
}
```

## 6. Relationship to the existing client-side graphify

- The shuba-managed path and the client SessionStart hook do the same job; running both would double-build. **shuba auto-disables the client-side graphify SessionStart hook** while it manages the graph: on `shuba up`/`run` it detects the hook in `~/.claude/settings.json` and neutralizes it (idempotent, restored on exit), so the two never double-build. No manual step.
- rtk and caveman stay client-side — they are PreToolUse hook / output-style features with no proxy or MCP surface, so they are explicitly **out of scope** for shuba integration (established during brainstorming).

## 7. Testing / acceptance

- Unit: status detection (graph present/absent/large), env wiring (model + provider always set to the cheap backend), config parsing.
- Integration: against a small fixture repo — `shuba_graph_status` reports not-built, trigger build (fake/stubbed graphify bin), then `shuba_graph_query` returns a stubbed result; watch mode picks up a file change.
- Guarantee test: assert the spawned graphify env carries the OpenRouter model and never an Anthropic key.
- Manual: real graphify build on a small project via shuba, query it from a live Claude Code session, confirm OpenRouter (not Claude) usage.

## 8. Open items deferred to implementation

- Exact graphify CLI subcommands/flags for headless `build`/`query`/`watch` — verify against the installed graphify version.
