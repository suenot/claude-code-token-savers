# shuba

**shuba** (шуба — Russian for "fur coat") is a thin Node CLI that chains Claude
Code's token-saving proxies so they layer on top of each other instead of
fighting for the same slot.

## Why

Claude Code has exactly one `ANTHROPIC_BASE_URL` — one server can own it at a
time. But the token-saving proxies each transform a request in a different,
complementary way:

- **[pxpipe](https://github.com/teamchong/pxpipe)** — renders the bulky, static
  parts of a request (system prompt, tool docs, old history) to dense PNGs.
- **[headroom](https://headroom-docs.vercel.app/docs)** — content-aware
  compression of request content (JSON, code, prose).
- **[link-assistant/router](https://github.com/link-assistant/router)**
  — translates the Anthropic Messages API to another provider (Codex, Gemini,
  Qwen, or an OpenAI-compatible endpoint). The router stage's interface is
  source-verified but has not yet been live smoke-tested end-to-end (only the
  default anthropic+headroom chain was) — treat any `terminal != "anthropic"`
  chain as experimental for now.

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

## Install

Requires **Node ≥18**.

```bash
npm i -g ./orchestrator
# or, for local development:
cd orchestrator && npm link
```

This installs the `shuba` command. The three proxies shuba wraps are
installed separately — shuba does not vendor or auto-install them:

```bash
npm i -g pxpipe-proxy                    # pxpipe
uv tool install "headroom-ai[proxy]"     # headroom — the [proxy] extra is REQUIRED
                                          # to get the `headroom proxy` subcommand
# router: see https://github.com/link-assistant/router
#   cargo install link-assistant-router
#   or: docker pull konard/link-assistant-router
```

`shuba doctor` (below) tells you which of the three are missing and prints
the exact install command for each.

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
- **`compressors`** — subset of `["headroom", "pxpipe"]`, in chain order
  (first entry = closest to Claude Code, i.e. it sees the request first).
- **`ports`** — optional per-proxy port overrides (`{ "pxpipe": 47821,
  "headroom": 8787, "router": 8080 }`); registry defaults are used otherwise.

If the file is missing, shuba writes this default on first run
(`terminal: "anthropic"`, `compressors: ["headroom"]`) and reports that it did
so.

The **router is not listed under `compressors`** — it is auto-appended as the
terminal stage whenever `terminal != "anthropic"`, with `UPSTREAM_PROVIDER`
set to match.

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

## Valid chains

The chain has a fixed shape: compressors operate on the Anthropic dialect and
must come before any translation; the router translates Anthropic → another
provider and is always the terminal (last) stage.

```
(a) Claude Code → pxpipe → headroom → api.anthropic.com   # compress on Anthropic-Fable
(b) Claude Code → headroom → router(codex)                # compress + route (pxpipe excluded)
(c) Claude Code → router(codex)                            # route only
```

### Chain rules

1. **Compressors before translation.** `pxpipe` and `headroom` both speak the
   Anthropic dialect on both sides; they must appear before the router, never
   after.
2. **Router is always last.** If `terminal != "anthropic"`, shuba
   auto-appends the router as the terminal stage; it can never appear
   mid-chain.
3. **pxpipe requires `terminal: "anthropic"`.** pxpipe's reader is
   Fable-only — the imaged request content it produces can only be read by
   Anthropic's Fable model; a non-Anthropic terminal provider cannot read
   it. `pxpipe` combined with any other terminal is a **hard validation
   error**, reported and the whole run aborted **before any process is
   started**.

## Conflict rule — one base-URL owner

Only one running process may own `ANTHROPIC_BASE_URL` at a time. Without
shuba, `pxpipe`, `headroom`, and `router` each expect to be that one process,
so running two of them independently means the second one just never gets
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
healthy: `headroom` via `GET /health`, `router` via `GET /health`, `pxpipe`
via `GET /` (it has no dedicated health route). If a stage doesn't become
healthy within the timeout, shuba tears down every stage already started and
reports which one failed.
