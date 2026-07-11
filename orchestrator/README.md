# shuba

**shuba** (шуба — Russian for "fur coat") is a thin Bun/TypeScript CLI that
chains Claude Code's token-saving proxies so they layer on top of each other
instead of fighting for the same slot.

## Why

Claude Code has exactly one `ANTHROPIC_BASE_URL` — one server can own it at a
time. But the token-saving proxies each transform a request in a different,
complementary way:

- **[headroom](https://headroom-docs.vercel.app/docs)** — content-aware
  compression of request content (JSON, code, prose).
- **[link-assistant/router](https://github.com/link-assistant/router)**
  — translates the Anthropic Messages API to another provider (Codex, Gemini,
  Qwen, or an OpenAI-compatible endpoint). The router stage's interface is
  source-verified but has not yet been live smoke-tested end-to-end (only the
  default anthropic+headroom chain was) — treat any `terminal != "anthropic"`
  chain as experimental for now.
- **compact-router** — a built-in stage (no external binary) that reroutes
  just Claude Code's `/compact`/autocompact summarization request to a cheap
  model, leaving every other request untouched. See
  [below](#compact-router) for details.
- **context-watchdog** — a built-in stage (no external binary) that
  proactively rewrites any over-threshold request to keep the flagship's
  context small **before** Claude Code's own autocompact kicks in. See
  [below](#context-watchdog) for details.

Run bare, only one of them can sit behind `ANTHROPIC_BASE_URL`. **shuba**
starts the proxies you've enabled, each on its own port, wires each one's
*upstream* to the next stage in the chain, points Claude Code at the head of
the chain, and launches `claude` — so the proxies **layer** instead of
collide.

### The fur-coat metaphor

Think of shuba as a fur coat: one warm garment made of several layers worn in
order over Claude Code. Each proxy is one layer of the coat — compressors
close to the body, a translating layer (the router) on the outside as the
last thing the request passes through before it leaves for another provider.

This is different from **Clother**, which is a *shirt*: it swaps which
provider Claude Code talks to by launching Claude Code against a different
base URL up front. Clother is a **launcher**, not a proxy — it doesn't sit in
the request path and it doesn't compose with other proxies. shuba's job is
specifically to chain several *proxies* (things that sit in the request path)
so they don't collide.

## Requirements

shuba runs on **[Bun](https://bun.sh) ≥1.1** — there is no Node runtime
dependency for the CLI itself.

- **Dev / from source**: `bun bin/shuba.ts <command>` runs the CLI directly
  from TypeScript, no build step needed.
- **Standalone binary**: `bun run build` compiles a single-file executable to
  `./shuba` (via `bun build --compile`); run it with `./shuba <command>`.
- **Tests**: `bun test` (see [Commands](#commands) below for the CLI's own
  commands).

## Install

```bash
npm i -g ./orchestrator
# or, for local development:
cd orchestrator && npm link
```

This installs the `shuba` command (still distributed as an npm package, but
executed by Bun). The external proxies shuba wraps are installed separately —
shuba does not vendor or auto-install them:

```bash
uv tool install "headroom-ai[proxy]"     # headroom — the [proxy] extra is REQUIRED
                                          # to get the `headroom proxy` subcommand
# router: see https://github.com/link-assistant/router
#   cargo install link-assistant-router
#   or: docker pull konard/link-assistant-router
```

`shuba doctor` (below) tells you which are missing and prints the exact
install command for each.

## Config — `~/.shuba/chain.json`

```json
{
  "terminal": "anthropic",
  "compressors": ["headroom"],
  "ports": {}
}
```

- **`terminal`** — where the chain ends up talking:
  `anthropic | codex | gemini | qwen | openai-compatible`.
- **`compressors`** — subset of `["headroom", "compact-router",
  "context-watchdog", "rate-limiter"]`, in chain order (first entry = closest to Claude Code,
  i.e. it sees the request first). `compact-router` is recommended **first**
  — see [below](#compact-router) — and `context-watchdog` should come
  **after** it — see [below](#context-watchdog).
- **`compactRouter`** — optional config block for the `compact-router` stage
  (model/baseUrl/envKey); see [below](#compact-router).
- **`contextWatchdog`** — optional config block for the `context-watchdog`
  stage (thresholdTokens/tailTurns/model/baseUrl/envKey); see
  [below](#context-watchdog).
- **`ports`** — optional per-proxy port overrides (`{ "headroom": 8787,
  "router": 8080 }`); registry defaults are used otherwise.

If the file is missing, shuba writes this default on first run
(`terminal: "anthropic"`, `compressors: ["headroom"]`) and reports that it did
so.

The **router is not listed under `compressors`** — it is auto-appended as the
terminal stage whenever `terminal != "anthropic"`, with `UPSTREAM_PROVIDER`
set to match.

## compact-router

**compact-router** is a built-in shuba stage — it spawns our own Bun module
(`orchestrator/bin/compact-interceptor.ts`) instead of an external binary, but
otherwise flows through the same supervisor/planner as any other compressor.

### What it does

Claude Code's `/compact` (and autocompact) is a normal `POST /v1/messages`
call to the **session model** that reads the entire accumulated context and
writes a summary. compact-router fingerprints that one request — the **last
user turn** contains the verbatim, distinctive text `create a detailed
summary of the conversation so far` (case-insensitive; the same fingerprint
covers both manual `/compact` and autocompact) — and serves it from a cheap
OpenAI-compatible model instead, translating Anthropic⇄OpenAI both ways.
Every other request passes through untouched to the next stage. It never
touches the main session's cache: only the one summarization request is
intercepted, everything else still flows to the flagship unchanged.

### Why it saves money

Compaction reads the *whole* context on the flagship — on a full Fable 1M
session that costs roughly **$1.5 (cache-warm) to $10–13 (cache-cold) per
compaction**, and autocompact recurs over a long session. It's a pure
"re-read and condense" task that barely benefits from the prompt cache, so
rerouting just that one request to a cheap model is near-pure savings.

### Config

Add `"compact-router"` to `compressors` — **recommended first**, closest to
Claude Code, so the compact request is caught before other stages waste work
imaging/compressing it (the match works from any position, this is just the
efficient one). An optional `compactRouter` block tunes the model:

```json
{
  "terminal": "anthropic",
  "compressors": ["compact-router", "headroom"],
  "compactRouter": {
    "model": "a8e/a8e-1.0-pro",
    "baseUrl": "http://localhost:8080/v1",
    "envKey": "A8E_API_KEY"
  },
  "ports": {}
}
```

Defaults (used when `compactRouter` is omitted, or any of its fields are):
`a8e/a8e-1.0-pro` (white-label for Kimi K2.6) via the local a8e router at
`http://localhost:8080/v1` (see `/Users/suenot/projects/server/llm/README.md`),
using the `A8E_API_KEY` environment variable if set — the local router runs
with `A8E_REQUIRE_AUTH=false`, so any non-empty key satisfies it and shuba
falls back to a placeholder key automatically when the base URL is
`localhost`/`127.0.0.1` and the env var isn't set.

### The fallback guarantee

On **any** external-model failure (network error, non-2xx, empty content,
timeout) the request falls back to transparent passthrough to the flagship —
`/compact` never breaks, you just pay the normal price that one time. The
same applies if the request doesn't match the fingerprint at all: straight
passthrough, no translation involved.

### Quality caveat

A cheap model makes a rougher summary than the flagship would — watch for
context-rot if summaries start dropping details you needed. If that happens,
raise the model in `compactRouter.model` (any OpenAI-compatible model behind
the same `baseUrl`/`envKey` works).

## context-watchdog

**context-watchdog** is a built-in shuba stage — like compact-router it
spawns our own Bun module (`orchestrator/bin/context-watchdog.ts`) instead
of an external binary, and flows through the same supervisor/planner as any
other compressor.

### What it does

context-watchdog rewrites any `POST /v1/messages` request whose estimated
token count exceeds a threshold (default **300,000**): it summarizes the
**older** turns via a cheap model and forwards the flagship a shortened
body — `[summary]` plus a verbatim recent tail — instead of the full
history. The flagship's **response is proxied back untouched**: this is a
request-mutating passthrough, not a translating one (no SSE rewriting, no
Anthropic⇄OpenAI dance on the way back).

### Why it saves money (and improves quality)

Smaller context is both cheaper **and** higher quality — a bloated context
suffers context rot even when the flagship can technically still fit it.
compact-router only steps in reactively, at the moment Claude Code itself
decides to run `/compact` (manual or autocompact, near its ~1M limit).
context-watchdog instead caps the context **proactively**, well before that
point, so the flagship is never dragging around a needlessly huge prompt in
the first place.

### The mechanism, honestly

A proxy cannot make the Claude Code client run `/compact` — there is no
client-side trigger channel and no way to set a custom autocompact
threshold from outside. The only viable lever is **rewriting the outgoing
request**: when the estimate crosses the threshold, context-watchdog
replaces the older messages with a compact summary before forwarding.
Claude Code itself keeps its full transcript and keeps resending it every
turn — only the copy that reaches the model is shortened.

### Stateful, cache-stable summarization

The summary is cached **content-addressed**: the cache key is a sha256 of
the canonical JSON of the older prefix being summarized. Since Claude Code
resends the full history each turn, that older prefix is byte-identical
across turns, so the same key keeps hitting the cache — the watchdog only
calls the cheap model again once the tail grows past the threshold and the
cut point actually advances. The same content-addressing keeps the
rewritten prefix (`[system] + [summary block]`) **byte-stable** turn over
turn, so the flagship's own prompt cache keeps hitting on it too, instead of
being invalidated by a re-summarized preamble on every request.

### Config

Add `"context-watchdog"` to `compressors`, placed **after** `compact-router`
so Claude Code's own `/compact` requests are caught and handled by
compact-router first (see [Interaction with compact-router](#interaction-with-compact-router)
below). An optional `contextWatchdog` block tunes the threshold, tail size,
and model:

```json
{
  "terminal": "anthropic",
  "compressors": ["compact-router", "context-watchdog"],
  "compactRouter": {
    "model": "a8e/a8e-1.0-pro",
    "baseUrl": "http://localhost:8080/v1",
    "envKey": "A8E_API_KEY"
  },
  "contextWatchdog": {
    "thresholdTokens": 300000,
    "tailTurns": 6,
    "model": "a8e/a8e-1.0-pro"
  },
  "ports": {}
}
```

Defaults (used when `contextWatchdog` is omitted, or any of its fields are):
`thresholdTokens: 300000`, `tailTurns: 6`, model `a8e/a8e-1.0-pro`
(Kimi K2.6) via the local a8e router at `http://localhost:8080/v1`, using
the `A8E_API_KEY` environment variable if set (`baseUrl`/`envKey` follow the
same defaults as compact-router).

### Interaction with compact-router

context-watchdog **skips** Claude Code's own `/compact`/autocompact
requests — they're fingerprinted the same way compact-router detects them
and are left for compact-router (or the flagship) to handle, untouched.
This avoids double-summarizing a request that is already a summarization
request: context-watchdog only ever acts on ordinary, over-threshold
`/v1/messages` traffic.

### The fallback guarantee

Any failure in the summarize step (cheap-model error, empty summary) falls
back to forwarding the **original** request unchanged — a turn never
breaks, it just runs once at full price. The same passthrough applies when
the request is under threshold, or when no safe cut of the history exists
(nothing to compact safely): both cases pass through untouched, no
rewriting attempted.

## Commands

```
shuba run [-- <claude args>]   # default command: bring the chain up, then launch claude
shuba up                       # bring the chain up and hold it in the foreground (Ctrl-C to tear down)
shuba status                   # alias for doctor
shuba doctor                   # detect installed proxies + print the resolved chain (starts nothing)
shuba down                     # guidance only (see below)
```

- **`shuba run`** (also the default when no subcommand is given) reads the
  config, validates and resolves the chain, starts every stage, waits for
  each one to become healthy, mints a router token if the chain ends at the
  router, then execs `claude` with `ANTHROPIC_BASE_URL` (and, if needed,
  `ANTHROPIC_API_KEY`) pointed at the head of the chain. Anything after `--`
  is passed straight through to `claude`. When `claude` exits, shuba tears
  the whole chain down.
- **`shuba up`** does the same chain-bring-up as `run` but does **not**
  launch `claude` — it prints the resolved chain and holds the process open
  until `Ctrl-C`, then tears everything down. Useful for testing a chain
  without opening a Claude Code session.
- **`shuba doctor`** (same as `shuba status`) checks whether each proxy's
  binary is on `PATH`, printing an install hint for anything missing, then
  runs the planner against your current config and prints the resolved chain
  — or the validation errors — without spawning any process.
- **`shuba down`** is guidance-only in v1: shuba ties the chain's lifetime to
  the foreground `run`/`up` process, so tearing it down means stopping that
  process (Ctrl-C, or letting `claude` exit on its own).

## Console

`shuba-control` (the sidecar `shuba run`/`up` starts alongside the chain when
`control.enabled` isn't `false`) doubles as a small HTTP server for a
browser-based management console — chain/health status, delegated-job logs,
the graph view, config (secrets redacted), and token-savings stats.

The console is a static React SPA (`orchestrator/console`) that the control
server serves from `console/dist`. It is **not** committed — build it once
before running shuba:

```bash
cd orchestrator
bun run console:build   # outputs console/dist/{index.html,main.js}
```

Then `shuba run` (or `shuba up`) prints the console URL to stderr once the
chain is up, e.g. `shuba: console → http://127.0.0.1:47830/`; `shuba doctor`
prints the same URL under the `control:` line. Open it in a browser — it
talks to the control server's `/api/*` endpoints directly (loopback-only, no
extra auth needed).

If `console/dist` doesn't exist yet, the control server still runs fine —
`/api/*` endpoints work as normal, only the SPA routes 404 until you build it.

See [`console/README.md`](console/README.md) for the SPA's own dev workflow.

## Valid chains

The chain has a fixed shape: compressors operate on the Anthropic dialect and
must come before any translation; the router translates Anthropic → another
provider and is always the terminal (last) stage.

```
(a) Claude Code → headroom → api.anthropic.com             # compress on Anthropic
(b) Claude Code → headroom → router(codex)                 # compress + route
(c) Claude Code → router(codex)                             # route only
```

### Chain rules

1. **Compressors before translation.** `headroom` speaks the Anthropic
   dialect on both sides; it must appear before the router, never after.
2. **Router is always last.** If `terminal != "anthropic"`, shuba
   auto-appends the router as the terminal stage; it can never appear
   mid-chain.

## Conflict rule — one base-URL owner

Only one running process may own `ANTHROPIC_BASE_URL` at a time. Without
shuba, `headroom` and `router` each expect to be that one process, so
running two of them independently means the second one just never gets
traffic. shuba resolves this by making each proxy's own *upstream* setting
point at the next stage instead — so several proxies run simultaneously, each
one only fronting the next, and Claude Code only ever points at the single
head of the chain.

**Clother** is not part of this conflict: it's a launcher that starts Claude
Code against a chosen provider, not a proxy competing for the base-URL slot —
so it doesn't need to be (and can't be) chained by shuba. shuba is the coat;
Clother is a different piece of clothing entirely.

## Health checks

Before handing off to `claude`, shuba waits for every stage to report
healthy: `headroom` via `GET /health`, `router` via `GET /health`. If a
stage doesn't become healthy within the timeout, shuba tears down every
stage already started and reports which one failed.
