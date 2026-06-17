#!/usr/bin/env bash
# Claude Code SessionEnd hook — stop the graphify watcher for this project.
# Canonical copy: w_server/w_graphify/  ·  installed to: ~/.graphify/stop-watch.sh
set -u

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
PIDFILE="$ROOT/graphify-out/.watch.pid"
[ -f "$PIDFILE" ] || exit 0

PID=$(cat "$PIDFILE" 2>/dev/null || true)
if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
fi
rm -f "$PIDFILE"
exit 0
