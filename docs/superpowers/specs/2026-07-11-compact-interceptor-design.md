# compact-interceptor — design spec

**Date:** 2026-07-11
**Status:** approved design, pre-implementation
**Repo:** develop in `claude-code-token-savers/orchestrator/` (the shuba dev copy), then re-export to `suenot/shuba` via subtree.

## 1. Purpose

Claude Code's `/compact` (and autocompact) is a normal `/v1/messages` call to the **session model** that reads the entire accumulated context and writes a summary. On a full Fable 5 1M session that costs ~$1.5 (cache-warm) to ~$10–13 (cache-cold) **per compaction**, and autocompact recurs. It's a pure "re-read and condense" task — it barely benefits from the prompt cache, so routing it to a cheap external model is near-pure savings (article §4, method 2).

**compact-interceptor** is a new **built-in shuba stage** that:
- fingerprints the compaction request and serves it from a cheap OpenAI-compatible model (OpenRouter / `deepseek/deepseek-v4-flash` by default), translating Anthropic⇄OpenAI both ways;
- passes every other request through untouched to the next chain stage;
- on any external-model failure, **falls back to transparent passthrough** so `/compact` never breaks.

It never touches the main session's cache (it only intercepts the one summarization request; everything else flows to the flagship unchanged).

Non-goals (v1): improving summary quality beyond the chosen model; caching; multi-provider fan-out.

## 2. The fingerprint (captured from live Claude Code 2.1.206.262 traffic, 2026-07-10)

The compaction request is a `POST /v1/messages` where the **last user turn** contains this verbatim, distinctive text:

```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
...
Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
...
<analysis> ... <summary>
```

- Match key: last user-turn text contains **`create a detailed summary of the conversation so far`** (unique to compaction; both manual `/compact` and autocompact use it).
- Other observed traits (not required for the match, but useful): `max_tokens: 64000`, model = the session model.

## 3. Integration into shuba

A built-in stage is one whose descriptor spawns **our own Node module** instead of an external binary, but otherwise flows through the existing supervisor/planner unchanged.

### 3.1 registry entry `compact-router`
```
{
  id: 'compact-router',
  builtin: true,
  bin: process.execPath,                 // node
  defaultPort: 47850,
  dialect: 'anthropic',
  terminal: false,                        // forwards non-matches upstream
  healthPath: '/health',
  build({ port, upstreamBase, config }) {
    return {
      args: [<abs path to bin/compact-interceptor.js>],
      env: {
        PORT: String(port),
        COMPACT_UPSTREAM: upstreamBase,                       // where non-matches go
        COMPACT_MODEL: config?.compactRouter?.model ?? 'deepseek/deepseek-v4-flash',
        COMPACT_BASE_URL: config?.compactRouter?.baseUrl ?? 'https://openrouter.ai/api/v1',
        COMPACT_ENV_KEY: config?.compactRouter?.envKey ?? 'OPENROUTER_API_KEY',
      },
    };
  },
}
```
The interceptor path is resolved from the package root (`new URL('../bin/compact-interceptor.js', import.meta.url)`), not hard-coded.

### 3.2 planner change (minimal)
`plan()` currently calls `descriptor.build({ port, upstreamBase, provider })`. Extend the call to also pass `config` (the whole shuba config object) so builtin stages can read their settings block. No other planner logic changes — `compact-router` is just another non-terminal compressor. It is valid with **any** terminal (anthropic or a router), and does not interact with the pxpipe-Fable rule.

### 3.3 config
`~/.shuba/chain.json` gains an optional block:
```json
{
  "terminal": "anthropic",
  "compressors": ["compact-router", "headroom"],
  "compactRouter": { "model": "deepseek/deepseek-v4-flash", "baseUrl": "https://openrouter.ai/api/v1", "envKey": "OPENROUTER_API_KEY" },
  "ports": {}
}
```
Recommended position: **first** in `compressors` (closest to Claude Code), so the compact request is caught before other stages waste work imaging/compressing it. Documented as a recommendation; the match works from any position.

## 4. Modules (new, under `orchestrator/src/compact/` + `orchestrator/bin/`)

### 4.1 `matcher.js` — pure
`isCompactRequest(body): boolean` — true iff the last `role:'user'` message's text (string content, or concatenated text blocks) contains `create a detailed summary of the conversation so far` (case-insensitive). Interface: `isCompactRequest(body)`.

### 4.2 `translate.js` — pure
- `anthropicToOpenAI(body, model): OpenAIChatRequest`
  - `system` (string OR array of `{type:'text',text}` blocks) → a leading `{role:'system', content}` message.
  - each `messages[i]` → `{role, content}` where content is the message's text blocks concatenated; non-text blocks flattened to text placeholders: `tool_use` → `\n[tool_call ${name} ${JSON.stringify(input)}]`, `tool_result` → `\n[tool_result ${text-or-json}]`, `image` → `\n[image omitted]`.
  - carry `model`, `max_tokens` (cap to a sane ceiling, e.g. `min(body.max_tokens ?? 8192, 16000)`), `temperature: 0`, `stream: !!body.stream`.
- `openAIMessageToAnthropic(text, { model, inputTokens?, outputTokens? }): AnthropicMessage`
  - returns `{ id, type:'message', role:'assistant', model, content:[{type:'text', text}], stop_reason:'end_turn', stop_sequence:null, usage:{ input_tokens, output_tokens } }`.
- `anthropicSSEChunks(text, { model }): string[]` — the ordered SSE frames for a streamed Anthropic response: `message_start`, `content_block_start` (index 0, text), one or more `content_block_delta` (`text_delta`), `content_block_stop`, `message_delta` (`stop_reason:'end_turn'`, usage), `message_stop`. Each frame formatted as `event: <type>\ndata: <json>\n\n`.

### 4.3 `server.js`
`createInterceptor({ port, upstream, model, baseUrl, apiKey, fetchImpl=fetch }) -> httpServer`.
- `GET /health` → 200 `{status:'ok'}`.
- `POST *…/v1/messages` (not `count_tokens`): buffer body, JSON-parse.
  - If `isCompactRequest(body)`:
    1. `req = anthropicToOpenAI(body, model)`.
    2. `POST ${baseUrl}/chat/completions` with `Authorization: Bearer ${apiKey}` (non-streaming for simplicity; we assemble the client stream ourselves).
    3. On success: extract `choices[0].message.content`. If `body.stream` → write `text/event-stream` using `anthropicSSEChunks`; else write the `openAIMessageToAnthropic` JSON.
    4. On any failure (network, non-2xx, empty content, timeout): **fall back** — forward the original request bytes to `upstream` transparently (same passthrough path as a non-match) and log `compact_fallback`.
  - Else (non-match) OR any non-messages route: transparent passthrough to `upstream` (strip `content-encoding`/`content-length`/`transfer-encoding` from the upstream response; pipe the stream — the same correct passthrough shuba's capture proxy used).
- Emits a one-line log per intercepted compact (`intercepted`/`fallback`, model, bytes) to stderr.

### 4.4 `bin/compact-interceptor.js`
Reads env (`PORT`, `COMPACT_UPSTREAM`, `COMPACT_MODEL`, `COMPACT_BASE_URL`, `COMPACT_ENV_KEY`), resolves `apiKey = process.env[COMPACT_ENV_KEY]` (fail fast with a clear message if unset), calls `createInterceptor(...).listen(port)`.

## 5. Error handling

- **External model failure → transparent passthrough to the flagship.** A cheap-compact that errors must never brick `/compact`; the user just pays the normal price that once. Logged.
- **Missing API key** (`COMPACT_ENV_KEY` unset): the interceptor exits at startup with a clear message; `shuba doctor` should surface it (follow-up, not v1-blocking).
- **Malformed body / non-JSON:** passthrough untouched.
- Passthrough response handling mirrors the verified capture-proxy fix: never re-advertise upstream `content-encoding`/`content-length`; pipe the body stream (supports SSE).

## 6. Testing

- **matcher** (`test/compact-matcher.test.js`): a fixture built from the real captured last-user text matches; a normal user turn and an assistant turn do not; string-content and block-content forms both handled.
- **translate** (`test/compact-translate.test.js`): `anthropicToOpenAI` maps system-string and system-blocks; flattens a `tool_use`/`tool_result`/`image` block to text; sets `stream` from the source. `openAIMessageToAnthropic` yields the exact Anthropic message shape. `anthropicSSEChunks` emits the frames in order (`message_start` first, `message_stop` last, at least one `content_block_delta` carrying the text).
- **server** (`test/compact-server.test.js`, injected `fetchImpl`): a matched non-stream request → calls the external endpoint and returns an Anthropic message; a matched request whose external call throws → falls back to the injected upstream; a non-match → forwards to upstream untouched. (Use a fake `fetchImpl` for both the external model and the upstream; assert which was called.)
- **registry** (extend `test/registry.test.js`): `compact-router` is `builtin`, `terminal:false`, health `/health`, and `build()` wires `PORT`/`COMPACT_UPSTREAM`/`COMPACT_MODEL` from config with the deepseek default.
- No live-network test in the suite; a manual end-to-end smoke (real Claude Code through shuba, `/compact`, observe the interceptor log + a returned summary) is a post-merge controller step (like shuba Task 8).

## 7. Deliverable layout

```
orchestrator/
  bin/compact-interceptor.js
  src/compact/matcher.js
  src/compact/translate.js
  src/compact/server.js
  src/registry.js         # + compact-router descriptor (builtin)
  src/planner.js          # pass `config` into build()
  test/compact-matcher.test.js
  test/compact-translate.test.js
  test/compact-server.test.js
  test/registry.test.js   # + compact-router assertions
  README.md               # + compact-router section (what it is, config, savings, fallback, quality caveat)
```

## 8. Open items to confirm during implementation

- Whether the live compact request sets `stream:true` (assume yes; support both via `body.stream`). Confirm during the post-merge smoke.
- Exact upstream path pxpipe/headroom expect when compact-router forwards a non-match (it forwards the original URL/bytes verbatim, so this is transparent — no change needed).

---

## Phase 2 — context-watchdog (proactive compaction at a token threshold)

**Status:** requirements captured; needs its own design pass + plan before implementation. Build after Phase 1 ships.

### Goal
An **optional** stage that keeps the session context small (§3: smaller context is both cheaper and higher-quality) by compacting **proactively at a configurable threshold**, default **300,000 tokens**, instead of waiting for Claude Code's built-in autocompact near the ~1M limit.

### The hard constraint (why this is not just "trigger /compact")
A proxy cannot make the Claude Code client type `/compact`: there is no channel from the model/proxy to the client to trigger a client-side compaction, and Claude Code exposes no custom autocompact token threshold. Therefore the **only** viable mechanism is **proxy-side context rewriting**:

- On each outgoing `/v1/messages`, estimate the request's token count.
- If it exceeds `threshold` (default 300k), summarize the **older** turns (everything behind a recent live tail) via the cheap model (reusing Phase 1's `translate` + summarization), and send the flagship a **shortened** request: `[summary of old turns] + [recent tail verbatim]`. Claude Code keeps its own full transcript; only what reaches the model is compacted.

### Why it must be stateful (the real complexity)
Claude Code resends the full history every turn. To avoid re-summarizing (and re-paying) on every turn and to keep the flagship's KV cache alive, the stage must keep **per-conversation state**: once it summarizes a prefix, it must reuse that exact summary as a stable replacement on subsequent turns, appending only new tail turns, and only re-summarize when the tail itself grows past the threshold again. Keying conversations (there is no explicit conversation id in the API) and keeping the rewritten prefix **byte-stable for cache hits** are the two central design problems Phase 2 must solve.

### Config (planned)
```json
"contextWatchdog": { "enabled": true, "thresholdTokens": 300000, "tailTurns": 6, "model": "deepseek/deepseek-v4-flash" }
```
A new `context-watchdog` builtin stage (compressor, dialect anthropic), same spawn/registry pattern as `compact-router`.

### Tradeoffs to resolve in the Phase 2 design (not decided here)
- **Cache vs freshness:** rewriting the prefix changes what the flagship caches; must the stage guarantee a stable prefix per conversation (it should), and how to detect "new conversation" vs "continued".
- **Quality/rot:** aggressive 300k compaction on a cheap model risks losing detail; the tail size and model are the levers.
- **Interaction with Phase 1:** if both stages run, the watchdog handles the *threshold* rewrite and the interceptor handles Claude Code's *own* `/compact` request — they should not double-summarize; ordering and mutual awareness need specifying.

Phase 2 gets its own spec section expansion + plan once Phase 1 is merged and smoke-verified.
