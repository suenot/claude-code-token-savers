# claude-code-token-savers

A ready-made, **global** Claude Code setup to cut token spend — no API key required for any of it (graphify's semantic step runs on a cheap OpenRouter model, not your Claude budget).

Five tools, every layer of the token bill:

| tool | compresses | mechanism | needs |
|---|---|---|---|
| **[rtk](https://github.com/rtk-ai/rtk)** | command output (git/docker/pytest… −60–90%) | `PreToolUse` hook rewrites `git status` → `rtk git status` | brew |
| **[caveman](https://github.com/JuliusBrussee/caveman)** | Claude's own output (~−65%, terse style) | plugin with its own `SessionStart` hook | Node ≥18 |
| **graphify** (this repo bundles the setup) | replaces "read the whole repo" with a queryable knowledge graph; semantic extraction runs on **OpenRouter / deepseek**, not Claude tokens | skill + `SessionStart` auto-watch + headless build | [uv](https://docs.astral.sh/uv/) |
| **[pxpipe](https://github.com/teamchong/pxpipe)** | the whole request — system prompt, tool docs, old history rendered to dense PNGs (~−59–70% input) | local proxy behind `ANTHROPIC_BASE_URL` | Node ≥18 |
| **[headroom](https://github.com/headroomlabs-ai/headroom)** | request content — tool outputs, logs, RAG chunks, history via content-aware compressors (60–95% on JSON, 15–20% on coding) | local proxy / MCP / library | [uv](https://docs.astral.sh/uv/) or pip |

Companion to the write-up: **[Saving tokens in LLMs — a practical Claude Code guide](https://www.suenot.com/blog/saving-tokens-llm/)**.

**shuba** (this repo, [`orchestrator/`](orchestrator/)) is the piece that ties pxpipe, headroom, and
link-assistant/router together: only one process can own `ANTHROPIC_BASE_URL`
at a time, so shuba starts the proxies you enable each on its own port, wires
each one's upstream to the next, and launches `claude` against the head of
the chain — so the proxies layer instead of fighting over the slot. See
[`orchestrator/README.md`](orchestrator/README.md).

---

## 1. rtk — compress command output

```bash
brew install rtk          # or: curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | sh
rtk init -g --auto-patch  # installs a global PreToolUse hook for Claude Code
# restart Claude Code; test with: git status
```

It transparently rewrites recognized shell commands to their `rtk …` proxy, which filters/dedups/truncates the output before it hits the context. Built-in tools (Read/Grep/Glob) bypass it — use shell or explicit `rtk` there.

## 2. caveman — compress Claude's replies

```bash
curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash
# or enable as a Claude Code plugin from the JuliusBrussee/caveman marketplace
```

Caveman makes Claude answer in terse "caveman" style (drops filler, keeps technical substance). Activation is a marker file `~/.claude/.caveman-active` holding the level (`lite`/`full`/`ultra`/`wenyan`); the plugin ships its own `SessionStart` hook that reads it, so it stays on across sessions. Toggle with `/caveman <level>` or "normal mode".

> Tip: turn caveman **off** while writing prose/docs — terse mode hurts editing. It's great for coding, not for copywriting.

## 3. graphify — knowledge graph instead of full-repo reads

The non-trivial part, fully bundled in [`graphify/`](graphify/). It maps a repo (code + docs) into a graph you query instead of dumping files into context, and — critically — runs the **semantic extraction on a cheap OpenRouter model (`deepseek/deepseek-v4-flash`), so it costs ~$0.10 per build instead of your Claude tokens.**

```bash
cd graphify
./setup.sh          # installs graphify+extras, OpenRouter backend, patches, hooks
```

Requires `OPENROUTER_API_KEY` in your environment. What `setup.sh` sets up:

- **OpenRouter backend** (`~/.graphify/providers.json`) → `deepseek/deepseek-v4-flash` (override via `GRAPHIFY_OPENROUTER_MODEL`).
- **3 patches to graphify's `detect.py`** (idempotent, with rollback):
  - merge `.gitignore` + `.graphifyignore` instead of one shadowing the other (security fix, = upstream [PR #1364](https://github.com/safishamsi/graphify/pull/1364));
  - a global ignore layer (`~/.graphify/graphifyignore`);
  - a clean **no-media** toggle (`touch ~/.graphify/no-media` or `GRAPHIFY_NO_MEDIA=1`) — skip images/pdf/video/office with no ignore-file juggling.
- **Auto-watch hooks** (see hook map below): on session start, watch a project that already has a graph; for a fresh project, print "not initialized — run `/graphify .`" (so opening a huge/root folder never silently burns tokens). `touch ~/.graphify/autobuild` to also auto-build small fresh projects.
- **Pre-commit guard** that blocks committing a graph which indexed a `.gitignore`'d file (prevents leaking secrets into a committed graph).

Full details: [`graphify/README.md`](graphify/README.md).

## 4. pxpipe — render the request as images

pxpipe is a local proxy that rewrites the bulky, static parts of each request (system prompt, tool docs, older history) into dense PNGs before they leave your machine. An image's token cost is fixed by its pixel size, not its char count — dense text packs ~3× more chars per token as an image than as text, so the request shrinks ~59–70% while the model reads it through the same vision channel it already uses for screenshots. Output streams untouched; only the request is compressed.

It's a proxy, not a plugin — the integration is Claude Code's native `ANTHROPIC_BASE_URL`:

```bash
npm install -g pxpipe-proxy   # or run on demand: npx pxpipe-proxy
pxpipe                                            # proxy on 127.0.0.1:47821
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude  # point Claude Code at it
```

Dashboard at <http://127.0.0.1:47821/>: tokens saved, every text→image conversion, live kill switch. Measures real `saved_pct` against a `count_tokens` counterfactual in `~/.pxpipe/events.jsonl`.

> **Lossy — keep byte-exact values as text.** Exact hex/IDs/hashes/secrets can misread (and misses are silent confabulations, not errors). Recent turns stay text automatically; route verbatim work to a subagent on a non-allowlisted model (`CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-6`). Best on the Fable 5 reader; Opus misreads imaged content, so it's opt-in.

## 5. headroom — content-aware request compression

headroom compresses everything the agent *reads* — tool outputs, logs, RAG chunks, files, conversation history — with a content router that picks the right compressor per type (JSON, AST/code, prose) and caches originals for reversible retrieval. 60–95% on JSON payloads, ~15–20% on coding-agent traffic. Local-first; your data never leaves the machine.

```bash
uv tool install headroom-ai    # or: pip install headroom-ai
headroom wrap claude           # one-command Claude Code integration
# undo with: headroom unwrap claude
```

Also runs as a standalone proxy (`headroom proxy --port 8787`), an MCP server (`headroom_compress`/`headroom_retrieve`/`headroom_stats`), or an inline library (`compress(messages)` in Python/TS). `headroom stats` shows the running total. Full docs: <https://headroom-docs.vercel.app/docs>.

---

## Claude Code hook map (`~/.claude/settings.json`)

After the three installs, the global hooks look like this (merge — don't clobber existing hooks):

```
PreToolUse  [Bash]  -> rtk hook claude                      # rtk: rewrite commands
SessionStart        -> ~/.graphify/build-and-watch.sh       # graphify: status + watch
SessionStart        -> caveman-activate.js (from plugin)    # caveman: enable terse mode
SessionEnd          -> ~/.graphify/stop-watch.sh            # graphify: stop watcher
```

All take effect on the next Claude Code restart.

**pxpipe and headroom are proxies, not hooks** — they sit between Claude Code and the API via `ANTHROPIC_BASE_URL` (pxpipe) or `headroom wrap claude` (headroom), so they don't appear in the hook map. Run whichever proxy you want in front; the hook-based tools above stack on top independently.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Anthropic, rtk, caveman, graphify, pxpipe, or headroom; this just wires existing OSS tools together.
