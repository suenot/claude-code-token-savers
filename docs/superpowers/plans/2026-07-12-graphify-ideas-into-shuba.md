# Plan — port graphify ideas natively into shuba

**Date:** 2026-07-12
**Repo:** `claude-code-token-savers/orchestrator/` (Bun+TS)
**Source of ideas:** graphify pip package `graphifyy` v0.8.40 (installed at
`~/.local/share/uv/tools/graphifyy/lib/python3.12/site-packages/graphify/`).
No public repo — analyzed the installed Python source.

## Why

shuba already wraps the graphify CLI thinly (`src/control/graph.ts`). This work
brings graphify's best *ideas* natively into shuba as new token-saving stages +
a native graph query engine, chosen from a 3-cluster source analysis.

## Workstreams

### WS1 — Dedup compressor (NEW stage `dedup`)  [isolated: `src/dedup/`]
Claude Code resends byte-identical file bodies / tool_results / system-reminders
inside a single `/v1/messages` request. Detect repeated content blocks, keep the
first, replace 2nd+ copies with a short reference marker → fewer input tokens.
- `src/dedup/blocks.ts` — pure: parsed body → rewritten body + stats. Exact-hash
  tier first (min block size gate). MinHash/LSH fuzzy tier deferred (phase 2).
- `src/dedup/server.ts` — compressor HTTP server, mirrors
  `src/watchdog/server.ts`: gated by `isStageEnabled('dedup')`, dedup on
  `/v1/messages`, forward rewritten, log via `appendReqLog` with token savings.
- `bin/shuba-dedup.ts` — entry (mirror an existing built-in stage bin).
- Tests: `test/dedup-blocks.test.ts`, `test/dedup-server.test.ts`.
- Source ref: `dedup.py` (_norm + exact-hash grouping + union-find remap).

### WS2 — Compression cache  [isolated: `src/cache/`]
Memoize LLM-billed compression so unchanged inputs never re-bill.
- `src/cache/store.ts` — content-hash disk cache under `~/.shuba/cache/`:
  `get/set`, key = sha256(namespace + content), stat fastpath, atomic
  tempfile+rename write, fail-silent. Namespacing rule from `cache.py`:
  deterministic transforms keyed by `algoVersion + content`; LLM outputs keyed
  by `content` only (never invalidate on release → never re-bill).
- Tests: `test/cache-store.test.ts`.
- Integration (lead): wire into `watchdog/server.ts` `summarize()` — persist
  summaries by hash of the older-messages prefix.
- Source ref: `cache.py`.

### WS4 — Native graph query engine  [isolated: `src/graph/`]
Reimplement graphify's budgeted query so shuba serves context without the Python
CLI. Reads `graphify-out/graph.json` natively.
- `src/graph/load.ts` — parse graph.json → in-memory index (nodes, edges,
  adjacency, degree).
- `src/graph/idf.ts` — IDF term weights + seed picking (3-tier exact>prefix>substr
  ×IDF, top-3 with `top_score*0.2` gap cutoff).
- `src/graph/traverse.ts` — hub-gated BFS/DFS, `hubThreshold = max(50, p99 degree)`.
- `src/graph/render.ts` — token-budgeted render: `charBudget = tokenBudget*3`,
  seeds first then degree-desc, truncation footer telling the model how to narrow.
- `src/graph/god.ts` — god nodes: top-N degree minus file/concept/json-key/builtin.
- `src/graph/query.ts` — orchestrator: question → seeds → edge filters → BFS/DFS
  → budgeted render; plus god-node orientation payload.
- Tests: `test/graph-*.test.ts` with a small fixture graph.json.
- Integration (lead): swap `src/control/graph.ts` `query()` to native engine,
  keep CLI fallback.
- Source refs: `serve.py:112-448`, `analyze.py:100-121`.

### WS3 — Savings telemetry  [lead-owned, spine]
- Extend `ReqLogEntry` (`src/control/reqlog.ts`) with `tokensIn`, `tokensOut`,
  `tokensSaved`; add `readSavings()` aggregation.
- Each compressor computes pre/post `estimateTokens` and logs the delta.
- `src/control/http.ts` `/api/savings` endpoint + console panel.
- Source ref: `querylog.py` (fail-silent JSONL shape).

## Collision policy
Builders touch ONLY their new dir + new `test/*` files. All shared-file edits
(registry.ts, config/types.ts, planner.ts, reqlog.ts, control/http.ts, existing
compressor servers, bin registration, console) are made by the lead at
integration time. Full `bun test` + `tsc --noEmit` gate runs at integration.

## Model guarantee (unchanged)
Any LLM call graphify-side stays on the cheap OpenRouter model
(`deepseek/deepseek-v4-flash`), never Claude tokens.
