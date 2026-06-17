# graphify setup (OpenRouter / deepseek, hooks, no-media)

Reproducible config for [graphify](https://github.com/safishamsi/graphify) tuned to **not** spend Claude tokens: semantic extraction runs on a cheap OpenRouter model, the graph auto-watches, and media/secrets stay out.

Prereqs: [`uv`](https://docs.astral.sh/uv/) and `OPENROUTER_API_KEY` in your env.

## Install / restore

```bash
./setup.sh
```

Does everything below and prints the hook block to paste into `~/.claude/settings.json`. Manual equivalent:

```bash
uv tool install --with watchdog "graphifyy[openai]"   # openai extra = OpenRouter; watchdog = `graphify watch`
mkdir -p ~/.graphify
cp providers.json        ~/.graphify/providers.json
cp graphifyignore.global ~/.graphify/graphifyignore
cp build-and-watch.sh stop-watch.sh precommit-graph-guard.sh ~/.graphify/ && chmod +x ~/.graphify/*.sh
PY="$(sed -n '1s/^#!//p' "$(command -v graphify)")"
"$PY" patch-global-ignore.py
"$PY" patch-merge-ignore.py
"$PY" patch-no-media.py
touch ~/.graphify/no-media     # media OFF by default (rm to re-enable)
graphify install --platform claude
```

Then add the two hooks `setup.sh` prints to `~/.claude/settings.json` (merge, don't replace), and re-apply the backend-priority block in `~/.claude/skills/graphify/SKILL.md` (see below).

## Model / backend

- Provider `openrouter` in `~/.graphify/providers.json`, default model **`deepseek/deepseek-v4-flash`** ($0.09/$0.18 per 1M, 1M ctx). Override: `export GRAPHIFY_OPENROUTER_MODEL=qwen/qwen3.7-plus`.
- `graphify install` overwrites `~/.claude/skills/graphify/SKILL.md`, so re-apply this backend-priority block in its "Step 3 — Extract" section (else extraction falls back to Claude subagents and burns your tokens):
  > 1. **OpenRouter (preferred).** If `OPENROUTER_API_KEY` is set, use `graphify.llm.extract_corpus_parallel(files, backend="openrouter")` for text chunks; image chunks → Claude subagents.
  > 2. **Gemini.** Else if `GEMINI_API_KEY`/`GOOGLE_API_KEY` set, `backend="gemini"`.
  > 3. **Claude subagents** otherwise.

## Exclusions (3 independent mechanisms)

1. **Secrets/`.env`** — skipped by graphify's built-in `_is_sensitive` in every project, always. No config.
2. **Media** — clean toggle, no ignore files: `patch-no-media.py` makes `detect()` skip image/pdf/video/office when `~/.graphify/no-media` exists (or `GRAPHIFY_NO_MEDIA=1`). `rm` the marker to re-enable.
3. **`.gitignore` shadowing — fixed.** Upstream, a directory's `.graphifyignore` *fully shadows* that dir's `.gitignore` (a pattern present only in `.gitignore`, e.g. a secret, gets indexed). `patch-merge-ignore.py` makes both merge instead (= [PR #1364](https://github.com/safishamsi/graphify/pull/1364)). `patch-global-ignore.py` adds an optional global ignore layer (`~/.graphify/graphifyignore`, empty by default).

## Auto-watch (SessionStart hook)

`build-and-watch.sh` runs each session start and prints a status:

- **graph present** → start `graphify watch` + install the pre-commit guard → "watching".
- **not initialized** → print "run `/graphify .`" and do nothing (protects against accidentally indexing a huge/root folder).
- with `~/.graphify/autobuild` present → also auto-build small fresh projects via OpenRouter (size-capped at 500 files / 2M words).

Safety rails: skips `$HOME`, fs root, system/tmp dirs, `$HOME` ancestors, and any project with `.graphify-skip`. Kill switch: `~/.graphify/disable-autowatch`. Exactly one watcher per project (atomic `mkdir` lock + PID check). `stop-watch.sh` (SessionEnd) stops it. Watch refreshes only the code/AST layer; docs need `/graphify . --update`.

## Pre-commit guard

`precommit-graph-guard.sh` is auto-installed into graphified git repos (only when the repo has no other pre-commit hook / custom `core.hooksPath`). It **blocks committing** a `graphify-out/graph.json` that indexes a `.gitignore`'d file — defense-in-depth against leaking secrets into a committed graph. Override: `git commit --no-verify`.

## After a graphify upgrade

`uv tool upgrade graphifyy` / `graphify install` wipe site-packages (losing all 3 `detect.py` patches) and overwrite `SKILL.md`. Re-run `./setup.sh` (re-applies extras, files, all 3 patches, the no-media marker), then re-apply the SKILL.md backend block. Durable across upgrades: `~/.graphify/*`, `~/.claude/settings.json` hooks, per-repo `.git/hooks/pre-commit`.

## Files

| file | role |
|---|---|
| `setup.sh` | idempotent install/restore |
| `providers.json` | OpenRouter backend (no secrets — only the env-var name) |
| `graphifyignore.global` | optional global ignore (empty by default; media handled by the toggle) |
| `patch-merge-ignore.py` | merge `.gitignore`+`.graphifyignore` (PR #1364) |
| `patch-global-ignore.py` | global ignore layer |
| `patch-no-media.py` | `no-media` toggle |
| `build-and-watch.sh` / `stop-watch.sh` | SessionStart/SessionEnd auto-watch |
| `precommit-graph-guard.sh` | block committing a leaky graph |
| `.graphifyignore.example` | per-project ignore template (rarely needed) |
