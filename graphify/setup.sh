#!/usr/bin/env bash
# Idempotent install/restore of the graphify setup documented in README.md.
# Re-run after any `graphify install` / `uv tool upgrade` (they overwrite SKILL.md
# AND wipe site-packages, so the detect.py patches must be re-applied too).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:$PATH"

echo "==> 1/6  graphify + extras (openai for OpenRouter, watchdog for --watch)"
command -v uv >/dev/null 2>&1 || { echo "ERROR: install uv first: https://docs.astral.sh/uv/" >&2; exit 1; }
uv tool install --with watchdog "graphifyy[openai]" --force

PYBIN="$(sed -n '1s/^#!//p' "$(command -v graphify)")"
[ -x "$PYBIN" ] || { echo "ERROR: could not resolve graphify interpreter" >&2; exit 1; }

echo "==> 2/6  ~/.graphify/ (backend, global ignore, hook scripts, pre-commit guard)"
mkdir -p "$HOME/.graphify"
cp "$HERE/providers.json"          "$HOME/.graphify/providers.json"
cp "$HERE/graphifyignore.global"   "$HOME/.graphify/graphifyignore"
cp "$HERE/build-and-watch.sh"      "$HOME/.graphify/build-and-watch.sh"
cp "$HERE/stop-watch.sh"           "$HOME/.graphify/stop-watch.sh"
cp "$HERE/precommit-graph-guard.sh" "$HOME/.graphify/precommit-graph-guard.sh"
chmod +x "$HOME"/.graphify/{build-and-watch,stop-watch,precommit-graph-guard}.sh
echo "    installed providers.json, graphifyignore, build-and-watch.sh, stop-watch.sh, precommit-graph-guard.sh"

echo "==> 3/6  patch detect.py: (a) global ignore layer, (b) merge .gitignore+.graphifyignore, (c) no-media toggle"
"$PYBIN" "$HERE/patch-global-ignore.py"
"$PYBIN" "$HERE/patch-merge-ignore.py"
"$PYBIN" "$HERE/patch-no-media.py"
# media OFF by default via the clean toggle (rm this file to re-enable media):
touch "$HOME/.graphify/no-media"

echo "==> 4/6  register skill in Claude Code"
graphify install --platform claude

echo "==> 5/6  checks"
[ -n "${OPENROUTER_API_KEY:-}" ] && echo "    OPENROUTER_API_KEY: set" \
  || echo "    WARNING: OPENROUTER_API_KEY not set — add to ~/.zshrc: export OPENROUTER_API_KEY=\"sk-or-...\""

echo "==> 6/6  SessionStart/SessionEnd hooks — add to ~/.claude/settings.json under \"hooks\":"
cat <<'JSON'
    "SessionStart": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "~/.graphify/build-and-watch.sh # graphify-autowatch", "timeout": 15 } ] } ],
    "SessionEnd": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "~/.graphify/stop-watch.sh # graphify-autowatch", "timeout": 10 } ] } ]
JSON

cat <<'NOTE'

DONE. Then, manually: re-apply the "backend priority" block in
~/.claude/skills/graphify/SKILL.md (graphify install overwrote it) — see README.

How auto-watch behaves on session start (visible status message each time):
  - graph present      -> starts `watch`, says "watching <project>"
  - NOT initialized     -> says "not initialized — run /graphify ." and does NOTHING
                           (protects against accidentally indexing a huge/root folder)
Toggles:
  touch ~/.graphify/no-media          # skip media (img/pdf/video/office) everywhere — set by setup
  rm    ~/.graphify/no-media          # re-enable media
  touch ~/.graphify/autobuild         # also auto-BUILD uninitialized projects (<=500 files)
  touch ~/.graphify/disable-autowatch # kill switch: disable all of it
  touch <project>/.graphify-skip      # opt a single project out
Media OFF is a clean toggle (~/.graphify/no-media or GRAPHIFY_NO_MEDIA=1), no ignore files.
Secrets/.env are skipped built-in everywhere.
A pre-commit guard is auto-installed in graphified git repos (blocks committing a graph
that indexes a .gitignore'd file; skipped if the repo already has a pre-commit hook).
NOTE
