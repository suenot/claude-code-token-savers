# claude-code-token-savers

A ready-made, **global** Claude Code setup to cut token spend — no API key required for any of it (graphify's semantic step runs on a cheap OpenRouter model, not your Claude budget).

Four tools, every layer of the token bill:

| tool | compresses | mechanism | needs |
|---|---|---|---|
| **[rtk](https://github.com/rtk-ai/rtk)** | command output (git/docker/pytest… −60–90%) | `PreToolUse` hook rewrites `git status` → `rtk git status` | brew |
| **[caveman](https://github.com/JuliusBrussee/caveman)** | Claude's own output (~−65%, terse style) | plugin with its own `SessionStart` hook | Node ≥18 |
| **graphify** (this repo bundles the setup) | replaces "read the whole repo" with a queryable knowledge graph; semantic extraction runs on **OpenRouter / deepseek**, not Claude tokens | skill + `SessionStart` auto-watch + headless build | [uv](https://docs.astral.sh/uv/) |
| **[headroom](https://github.com/headroomlabs-ai/headroom)** | request content — tool outputs, logs, RAG chunks, history via content-aware compressors (60–95% on JSON, 15–20% on coding) | local proxy / MCP / library | [uv](https://docs.astral.sh/uv/) or pip |

Companion to the write-up: **[Saving tokens in LLMs — a practical Claude Code guide](https://www.suenot.com/blog/saving-tokens-llm/)**.

**shuba** (this repo, [`orchestrator/`](orchestrator/)) is the piece that ties headroom and
link-assistant/router together: only one process can own `ANTHROPIC_BASE_URL`
at a time, so shuba starts the proxies you enable each on its own port, wires
each one's upstream to the next, and launches `claude` against the head of
the chain — so the proxies layer instead of fighting over the slot. Bundled
here in [`orchestrator/`](orchestrator/); also a standalone repo at
[suenot/shuba](https://github.com/suenot/shuba). See
[`orchestrator/README.md`](orchestrator/README.md).

### shuba vs cmdop-claude, graphify & other tools

Most tools here do **one** thing. shuba is the **orchestrator**: it layers the
single-purpose compressors behind one `ANTHROPIC_BASE_URL`, and folds in a
control MCP that ports the best ideas from cmdop-claude (task queue) and
graphify (a native in-process graph) — so one process gives you chaining +
tasks + graph instead of three disconnected runtimes. The same matrix is
browsable live in the console's **Compare** tab.

Columns are the tools, rows are features. `✓` built-in · `~` partial / via a stage · `◐` planned in shuba · `·` not offered. The same matrix is browsable live in the console's **Compare** tab.

Tools: **shuba** (Bun/TS) · [cmdop-claude](https://github.com/markolofsen/cmdop-claude) (Python) · [graphify](https://github.com/safishamsi/graphify) (Python) · [claude-code-router](https://github.com/musistudio/claude-code-router) (Node) · [LiteLLM](https://github.com/BerriAI/litellm) (Python) · [headroom](https://headroom-docs.vercel.app/docs) (Python).

**Request / proxy layer** — shrink input tokens before they hit the API:

| feature | shuba | cmdop | graphify | ccr | litellm | headroom |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Content-aware compression (JSON/code/prose) | ~ | · | · | · | · | ✓ |
| Downscale request images (native, scale presets, default 1/2) | ✓ | · | · | · | · | · |
| In-request dedup (identical blocks) | ✓ | · | · | · | · | · |
| `/compact` routed to a cheap model | ✓ | · | · | · | · | · |
| Auto-compact at a token threshold (default 300k) | ✓ | · | · | · | · | · |
| Response / compression cache | ✓ | · | · | · | ✓ | · |
| Rate limiting | ✓ | · | · | · | ✓ | · |
| Chain proxies behind one `BASE_URL` | ✓ | · | · | · | · | · |
| Provider / model routing | ✓ | · | · | ✓ | ✓ | · |
| Cheap model for the tool's own work (off Claude's budget) | ✓ | ✓ | ✓ | ~ | ~ | · |

**Project intelligence / sidecar** — cmdop-claude's core idea: spend cents on a cheap model to keep docs/maps accurate so Claude Code's scarce context isn't spent on it:

| feature | shuba | cmdop | graphify | ccr | litellm | headroom |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Task queue injected into prompts | ✓ | ✓ | · | · | · | · |
| Docs review (stale / contradiction / gaps) | ◐ | ✓ | · | · | · | · |
| Docs auto-fix (LLM edits) | ◐ | ✓ | · | · | · | · |
| Project map (dir annotations, SHA-cached) | ◐ | ✓ | · | · | · | · |
| Rules system (lazy `paths:` frontmatter) | · | ✓ | · | · | · | · |
| Docs search (FTS5 / semantic) | · | ✓ | · | · | · | · |
| Knowledge graph (query instead of read) | ✓ | · | ✓ | · | · | · |
| God nodes / community detection | ~ | · | ✓ | · | · | · |

**Task-type model routing** — the claude-code-router / hermes pattern, native in shuba's `model-router` stage: classify each request and pick a model per category (all configurable under `modelRouter.routes`):

| route | detected when | shuba | cmdop | graphify | ccr | litellm | headroom |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `default` | anything else | ✓ | · | · | ✓ | ~ | · |
| `background` | haiku-tier bg calls | ✓ | · | · | ✓ | · | · |
| `think` | thinking/plan mode | ✓ | · | · | ✓ | · | · |
| `longContext` | tokens > threshold (60k) | ✓ | · | · | ✓ | · | · |
| `webSearch` | web_search tool present | ✓ | · | · | ✓ | · | · |
| `image`/vision | request has images | ✓ | · | · | ✓ | · | · |
| `compact` | Claude Code `/compact` summarization | ✓ | · | · | · | · | · |
| **Local OCR** for image reqs (no vision LLM) | request has images | ✓ | · | · | · | · | · |

`compact` and `longContext` predate `model-router`: `/compact` summarization is routed to a cheap model by the dedicated **compact-router** stage (its own model, default `a8e/a8e-1.0-pro`), and over-threshold requests are compacted in place by **context-watchdog** — so those two live in their own stages, while `model-router` adds `default`/`background`/`think`/`webSearch`/`image`. The **Local OCR** row is unique: tesseract extracts text from screenshots (code/errors/logs) locally, injected as a text block — optionally dropping the pixels — so most "image analysis" never needs a vision model at all.

**Task delegation / routing** — offload whole tasks off Claude Code onto cheaper harnesses/models:

| feature | shuba | cmdop | graphify | ccr | litellm | headroom |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Trigger a cheap-model job from Claude via MCP | ✓ | ~ | · | · | · | · |
| Delegate an **arbitrary** task to a sub-harness (`shuba_delegate`) | ✓ | · | · | · | · | · |
| LLM-based model/harness routing (cheap classifier picks target) | ✓ | · | · | · | · | · |
| Per-job git-worktree isolation | ✓ | · | · | · | · | · |

cmdop's `~` is the key nuance: it *does* expose a cheap-model job to Claude over MCP — but only the fixed docs-review scan (`sidecar_scan`), not arbitrary task delegation. shuba's `shuba_delegate` hands off any task. Every other tool's cheap-model use is internal (invisible to Claude), which is why the old single "cheap-model offload" row was misleading and is now split three ways: internal use, MCP-triggered fixed job, and MCP arbitrary delegation.

**Ops / visibility:**

| feature | shuba | cmdop | graphify | ccr | litellm | headroom |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Console / dashboard UI | ✓ | ~ | · | ~ | ✓ | ~ |
| Live savings telemetry | ✓ | · | · | · | · | ~ |

Cells reflect each tool's primary design intent, not a benchmark. Not affiliated with any listed project.

**Pick by need:** whole request smaller → **headroom** (content-aware compression), which shuba runs for you. Keep docs accurate + auto-fix, project map, rules → **cmdop-claude** (shuba has the task queue today; docs review is `◐` planned). Query a repo instead of reading it → **graphify** (shuba embeds a native reader). Swap providers → **claude-code-router** / **LiteLLM**. Stack all of it behind one endpoint with a task queue and graph in one process → **shuba**.

> **Docs review / auto-fix is the next thing to port into shuba.** It's *not* the knowledge graph: the graph answers a repo query on demand, whereas cmdop's docs-review is a background sidecar that watches documentation on a cheap model (~$0.003/cycle) and only surfaces findings/edits — so Claude Code's limited context never pays to notice stale docs. Tracked as `◐` above.

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

## 4. headroom — content-aware request compression

headroom compresses everything the agent *reads* — tool outputs, logs, RAG chunks, files, conversation history — with a content router that picks the right compressor per type (JSON, AST/code, prose) and caches originals for reversible retrieval. 60–95% on JSON payloads, ~15–20% on coding-agent traffic. Local-first; your data never leaves the machine.

```bash
uv tool install "headroom-ai[proxy]"    # [proxy] extra required for `headroom proxy`; or: pip install headroom-ai
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

**headroom is a proxy, not a hook** — it sits between Claude Code and the API via `headroom wrap claude`, so it doesn't appear in the hook map. Run it in front; the hook-based tools above stack on top independently.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Anthropic, rtk, caveman, graphify, or headroom; this just wires existing OSS tools together.
