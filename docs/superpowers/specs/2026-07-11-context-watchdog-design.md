# context-watchdog (Phase 2) — design spec

**Date:** 2026-07-11
**Status:** approved design, pre-implementation. Builds on Phase 1 (compact-interceptor) — reuses `src/compact/translate.js` and the server passthrough pattern.
**Repo:** develop in `claude-code-token-savers/orchestrator/`, then re-export to `suenot/shuba`.

## 1. Purpose

Keep the session context small **proactively** (§3: smaller context is cheaper AND higher quality) by compacting at a configurable **token threshold** (default **300,000**) instead of waiting for Claude Code's built-in autocompact near the ~1M limit.

A proxy cannot make the Claude Code client run `/compact` (no client-side trigger channel, no custom autocompact threshold). The **only** viable mechanism is **request rewriting**: on each outgoing `/v1/messages`, if the estimated token count exceeds the threshold, replace the older turns with a cheap-model summary and forward the flagship a shortened request. Claude Code keeps its full transcript; only what reaches the model is compacted.

**Crucial simplification vs Phase 1:** the watchdog only rewrites the **request**. The flagship's **response is proxied back untouched** (no SSE translation). It's a request-mutating passthrough proxy.

## 2. Resolved design decisions

- **Trigger:** estimated tokens of the incoming request > `thresholdTokens` (default 300k). Estimation is dependency-free char-based: `ceil(totalContentChars / 4)`. Good enough for a threshold gate; no tokenizer dependency.
- **What gets summarized:** everything except a verbatim **live tail** of the last `tailTurns` messages (default 6). The older prefix (`messages[0..cut)`) is summarized.
- **Safe cut:** the tail must be a valid Anthropic message sequence — it must **start with a `role:'user'` message** and must **not begin with an orphaned `tool_result`** (a `tool_result` whose `tool_use` was cut away). The cut is extended backward from `len - tailTurns` until it lands on a clean user boundary. If no safe cut leaves a non-empty older prefix, the watchdog passes through unchanged (nothing to compact safely).
- **Injection shape (valid alternation):** rewritten `messages` = `[{role:'user', content:'Summary of the earlier conversation so far:\n\n<summary>'}, {role:'assistant', content:'Understood. Continuing from that summary.'}, ...tail]`. `system` is preserved unchanged. Since the tail starts with `user`, the sequence user→assistant→user(tail)… alternates validly.
- **Conversation keying (state):** **content-addressed.** The summary is cached under `key = sha256(canonicalJSON(messages[0..cut)))`. Because Claude Code resends the full history each turn, the older prefix content is byte-identical across turns → same key → cache hit → **no re-summarization** until the cut advances (tail regrows past the threshold, moving the cut, producing a new key). This also keeps the rewritten prefix **byte-stable per conversation → the flagship's KV cache hits** on `[system]+[summary block]` while the tail grows.
- **Cache store:** in-memory `Map` for v1 (per-process; the shuba chain is one process). Bounded (LRU, cap ~64 entries) to avoid unbounded growth. Disk persistence is a follow-up.
- **Interaction with Phase 1 / `/compact`:** if the incoming request `isCompactRequest(body)` (the Phase-1 matcher), the watchdog **passes it through unchanged** — that's Claude Code's own compaction, handled by `compact-router` (or the flagship). The watchdog never double-summarizes a summary request. Recommended chain order: `["compact-router", "context-watchdog", ...]`.
- **Fallback:** on ANY summarization failure (cheap-model error, empty summary), forward the **original** request unchanged. Proactive compaction must never break a turn.

## 3. Summarization call

Reuse Phase 1's `translate.anthropicToOpenAI` machinery: build an Anthropic-shaped body `{ system: body.system, messages: [...older, { role:'user', content: SUMMARIZE_PROMPT }] }`, translate to OpenAI, POST to the cheap model (non-stream), take `choices[0].message.content` as the summary text. `SUMMARIZE_PROMPT` is a fixed instruction: "Summarize the conversation above in detail — decisions, code, file paths, current state, next steps — so work can continue without the original transcript. Respond with the summary only."

## 4. Modules (new, under `orchestrator/src/watchdog/` + one bin)

- `estimate.js` (pure): `estimateTokens(body): number` — sum chars of `system` (string or blocks) + all message content (flattened via the same block-text rules as Phase 1), divide by 4, ceil.
- `cut.js` (pure): `planCut(messages, tailTurns): { older, tail } | null` — returns the safe split (tail starts at a user message, no orphan tool_result, older non-empty) or `null` if no safe compaction is possible.
- `rewrite.js` (pure): `buildRewrittenBody(body, older, tail, summaryText): body` — returns a new request body with `system` preserved and `messages` = `[summaryUser, ackAssistant, ...tail]`; and `summaryKey(older): string` (sha256 of canonical JSON).
- `server.js`: `createWatchdog({ port, upstream, model, baseUrl, apiKey, thresholdTokens, tailTurns, fetchImpl = fetch, cache = new Map() }) -> http.Server`.
  - `GET /health` → 200.
  - `POST …/v1/messages` (not count_tokens): parse; if `isCompactRequest` → passthrough; `estimateTokens <= threshold` → passthrough; else `planCut`; if `null` → passthrough; compute `summaryKey`; on cache miss, summarize via cheap model and store (LRU-bounded); build rewritten body; **forward the rewritten body** to `upstream` and pipe the response back (header hygiene as Phase 1). On any error in the summarize/rewrite path → passthrough the ORIGINAL body.
  - everything else → passthrough.
- `bin/context-watchdog.js`: reads env (`PORT`, `WATCHDOG_UPSTREAM`, `WATCHDOG_MODEL`, `WATCHDOG_BASE_URL`, `WATCHDOG_ENV_KEY`, `WATCHDOG_THRESHOLD`, `WATCHDOG_TAIL_TURNS`), resolves apiKey, starts the server. Fail-fast on missing key.

## 5. shuba integration

`registry.js` gains a `context-watchdog` builtin descriptor (same pattern as `compact-router`): `builtin:true`, `bin:process.execPath`, `defaultPort:47851`, dialect anthropic, `terminal:false`, health `/health`; `build({port,upstreamBase,config})` wires the env from `config.contextWatchdog` (defaults: model `deepseek/deepseek-v4-flash`, baseUrl OpenRouter, envKey `OPENROUTER_API_KEY`, threshold `300000`, tailTurns `6`). Config block:
```json
"contextWatchdog": { "thresholdTokens": 300000, "tailTurns": 6, "model": "deepseek/deepseek-v4-flash" }
```
No planner change needed (Phase 1 already passes `config` into `build()`). Valid as an ordinary non-terminal compressor with any terminal.

## 6. Error handling

- Summarize failure / empty summary → forward original request (turn proceeds at full price that once).
- Missing API key → bin exits 1 with a clear message.
- Malformed/non-JSON body → passthrough.
- Response header hygiene identical to Phase 1 (strip content-encoding/content-length/transfer-encoding; pipe stream).

## 7. Testing

- **estimate** (`test/watchdog-estimate.test.js`): char/4 over system string, system blocks, and mixed message blocks; empty body → 0.
- **cut** (`test/watchdog-cut.test.js`): picks a tail of `tailTurns` when the boundary is clean; extends backward when the tail would start with an assistant or an orphan `tool_result`; returns `null` when the whole history is within one tail (nothing older) or no safe cut exists.
- **rewrite** (`test/watchdog-rewrite.test.js`): `buildRewrittenBody` preserves `system`, injects the summary user + ack assistant, appends the tail, and produces a valid alternating sequence; `summaryKey` is stable for identical `older` and differs for different `older`.
- **server** (`test/watchdog-server.test.js`, injected fetchImpl + a stub cache): under-threshold request → passthrough (no summarize call, no rewrite); over-threshold → summarizes once, forwards a rewritten body whose first user message contains the summary, and a SECOND identical over-threshold request hits the cache (no second summarize call); a compact-fingerprinted request → passthrough untouched; summarize failure → original body forwarded. Assert which outbound URL/body was used.
- **registry** (extend): `context-watchdog` builtin descriptor wires threshold/tailTurns/model from config with defaults.
- Live smoke (post-merge, controller): drive a >300k request through `shuba up` with `context-watchdog` and confirm the flagship receives a compacted body (via the watchdog log) and the response streams back.

## 8. Deliverable layout

```
orchestrator/
  bin/context-watchdog.js
  src/watchdog/estimate.js
  src/watchdog/cut.js
  src/watchdog/rewrite.js
  src/watchdog/server.js
  src/registry.js            # + context-watchdog descriptor (MODIFY)
  test/watchdog-estimate.test.js
  test/watchdog-cut.test.js
  test/watchdog-rewrite.test.js
  test/watchdog-server.test.js
  test/registry.test.js      # + context-watchdog assertions (MODIFY)
  README.md                  # + context-watchdog section (MODIFY)
```

## 9. Open items for implementation

- Confirm the flagship accepts the rewritten history with an injected synthetic assistant turn (it should — normal messages). Verify in the live smoke.
- LRU eviction is a simple insertion-order Map trim at cap; exact cap (64) is not load-bearing.
