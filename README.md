# claude-code-token-savers

A ready-made, **global** Claude Code setup to cut token spend — no API key required for any of it (graphify's semantic step runs on a cheap OpenRouter model, not your Claude budget).

Three tools, three layers of the token bill:

| tool | compresses | mechanism | needs |
|---|---|---|---|
| **[rtk](https://github.com/rtk-ai/rtk)** | command output (git/docker/pytest… −60–90%) | `PreToolUse` hook rewrites `git status` → `rtk git status` | brew |
| **[caveman](https://github.com/JuliusBrussee/caveman)** | Claude's own output (~−65%, terse style) | plugin with its own `SessionStart` hook | Node ≥18 |
| **graphify** (this repo bundles the setup) | replaces "read the whole repo" with a queryable knowledge graph; semantic extraction runs on **OpenRouter / deepseek**, not Claude tokens | skill + `SessionStart` auto-watch + headless build | [uv](https://docs.astral.sh/uv/) |

Companion to the write-up: **[Saving tokens in LLMs — a practical Claude Code guide](https://www.suenot.com/blog/saving-tokens-llm/)**.

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

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Anthropic, rtk, caveman, or graphify; this just wires existing OSS tools together.
