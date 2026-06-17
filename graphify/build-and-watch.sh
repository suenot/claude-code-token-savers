#!/usr/bin/env bash
# Claude Code SessionStart hook — graphify status + auto-watch for any project.
# Canonical copy: w_server/w_graphify/  ·  installed to: ~/.graphify/build-and-watch.sh
#
# Behavior (prints a visible status at session start; never blocks it):
#   - graph present (initialized)  → start `watch` (cheap, AST-only) + "watching"
#   - no graph (not initialized)   → print "not initialized — run /graphify ." and
#                                    do NOTHING (protects against accidentally
#                                    opening a huge/root folder and burning tokens)
#   - opt-in aggressive: if ~/.graphify/autobuild exists, an uninitialized project
#     is auto-built in the background via OpenRouter (still size-capped at
#     500 files / 2,000,000 words; bigger → skipped + reported)
#
# Safety rails: skips $HOME, fs root, system/tmp dirs, ancestors of $HOME, and a
# per-project .graphify-skip; global kill switch ~/.graphify/disable-autowatch.
# Exactly one watcher per project (atomic mkdir mutex + double-checked PID).
# SessionStart only — Task subagents (SubagentStart) never trigger this.
set -u

emit() {  # $1 = systemMessage, $2 = additionalContext  -> SessionStart JSON
    local m="${1//\\/}"; m="${m//\"/}"
    local c="${2//\\/}"; c="${c//\"/}"
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"},"systemMessage":"%s"}\n' "$c" "$m"
}

# 0. global kill switch
[ -f "$HOME/.graphify/disable-autowatch" ] && exit 0

# 1. project root (normalized)
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -d "$ROOT" ] || exit 0
ROOT="$(cd "$ROOT" 2>/dev/null && pwd -P)" || exit 0

GBIN="$HOME/.local/bin/graphify"
[ -x "$GBIN" ] || exit 0

# 2. per-project opt-out
[ -f "$ROOT/.graphify-skip" ] && exit 0

# 3. never touch $HOME, fs root, system/tmp dirs, or an ancestor of $HOME
case "$ROOT" in
    "$HOME"|/|/tmp|/var|/usr|/etc|/opt|/bin|/sbin|/Applications|/System|/Library|/private|/private/tmp|/private/var|/private/var/*|/tmp/*|/var/*|/usr/*|/etc/*) exit 0 ;;
esac
case "$HOME/" in "$ROOT"/*) exit 0 ;; esac

NAME="$(basename "$ROOT")"
OUT="$ROOT/graphify-out"
PIDFILE="$OUT/.watch.pid"
LOCKDIR="$OUT/.watch.spawn.lock"
LOG="$OUT/autowatch.log"

start_watch_detached() {  # assumes spawn lock held; records PID
    if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$HOME/.zshrc" ]; then
        local _line _k
        _line=$(grep -E '^[[:space:]]*export[[:space:]]+OPENROUTER_API_KEY=' "$HOME/.zshrc" | tail -1)
        _k=${_line#*=}; _k=${_k%\"}; _k=${_k#\"}; _k=${_k%\'}; _k=${_k#\'}
        [ -n "$_k" ] && export OPENROUTER_API_KEY="$_k"
    fi
    local PYBIN; PYBIN="$(sed -n '1s/^#!//p' "$GBIN" 2>/dev/null)"; [ -x "$PYBIN" ] || PYBIN="python3"
    local autobuild=0; [ -f "$HOME/.graphify/autobuild" ] && autobuild=1
    nohup bash -c '
        set -u
        ROOT="$1"; GBIN="$2"; PYBIN="$3"; autobuild="$4"; OUT="$ROOT/graphify-out"
        cd "$ROOT" 2>/dev/null || exit 0
        if [ ! -f "$OUT/graph.json" ]; then
            [ "$autobuild" = 1 ] || exit 0   # default: do not build uninitialized projects
            sz=$("$PYBIN" -c "from graphify.detect import detect; from pathlib import Path; r=detect(Path(\".\")); print(r.get(\"total_files\",0), r.get(\"total_words\",0))" 2>/dev/null)
            files=${sz%% *}; words=${sz##* }
            if [ "${files:-0}" -gt 500 ] || [ "${words:-0}" -gt 2000000 ]; then
                echo "[autowatch] $(date) corpus too big (${files:-?} files / ${words:-?} words) — skipping auto-build. Run /graphify . manually."
                exit 0
            fi
            echo "[autowatch] $(date) auto-building (${files} files) via openrouter…"
            "$GBIN" extract "$ROOT" --backend openrouter || { echo "[autowatch] build failed"; exit 1; }
            "$GBIN" cluster-only "$ROOT" --backend openrouter || true
        fi
        echo "[autowatch] $(date) starting watch"
        exec "$GBIN" watch "$ROOT" --debounce 3
    ' bootstrap "$ROOT" "$GBIN" "$PYBIN" "$autobuild" >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    disown 2>/dev/null || true
}

install_precommit_guard() {  # non-invasive: only when no other pre-commit hook exists
    git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
    [ -z "$(git -C "$ROOT" config core.hooksPath 2>/dev/null)" ] || return 0   # respect husky/lefthook
    local gitdir hookdir hook
    gitdir="$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null)" || return 0
    hookdir="$gitdir/hooks"
    hook="$hookdir/pre-commit"
    if [ -f "$hook" ]; then
        grep -q 'graphify-precommit-guard' "$hook" 2>/dev/null || return 0   # someone else's hook — leave it
    fi
    mkdir -p "$hookdir"
    printf '#!/usr/bin/env bash\n# graphify-precommit-guard (managed by w_graphify)\nexec "$HOME/.graphify/precommit-graph-guard.sh"\n' > "$hook"
    chmod +x "$hook"
}

# 4. already watching? (live PID)
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    emit "graphify: watching $NAME" "graphify is already watching this project (graph present)."
    exit 0
fi

if [ -f "$OUT/graph.json" ]; then
    # initialized → ensure watcher (race-safe) + pre-commit guard, announce
    mkdir -p "$OUT"
    [ -d "$LOCKDIR" ] && find "$LOCKDIR" -maxdepth 0 -mmin +1 -exec rmdir {} \; 2>/dev/null
    if mkdir "$LOCKDIR" 2>/dev/null; then
        trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT
        if ! { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }; then
            start_watch_detached
        fi
    fi
    install_precommit_guard
    emit "graphify: watching $NAME" "graphify graph present for this project; watcher started (code changes auto-refresh; docs need /graphify . --update). Querying: /graphify query \"...\"."
    exit 0
fi

# not initialized
if [ -f "$HOME/.graphify/autobuild" ]; then
    mkdir -p "$OUT"
    [ -d "$LOCKDIR" ] && find "$LOCKDIR" -maxdepth 0 -mmin +1 -exec rmdir {} \; 2>/dev/null
    if mkdir "$LOCKDIR" 2>/dev/null; then
        trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT
        start_watch_detached
    fi
    emit "graphify: $NAME not initialized — auto-building in background" "graphify autobuild is ON: building this project's graph in the background via OpenRouter (skipped if >500 files). It will then auto-watch."
    exit 0
fi

emit "graphify: $NAME not initialized — run /graphify . to build" "graphify is NOT initialized for this project (no graphify-out/graph.json). It will not build or watch automatically. Run /graphify . to build the knowledge graph (then it auto-watches every session). This is intentional: protects against accidentally indexing a huge/root folder."
exit 0
