#!/usr/bin/env bash
# graphify pre-commit guard — blocks committing a graph that indexed a file the
# repo's .gitignore excludes (i.e. content that shouldn't become public).
#
# Defense-in-depth on top of the merge patch: the merge patch stops the graph
# from indexing .gitignore'd files at BUILD time; this guard catches a STALE
# graph (built before a secret was gitignored) at COMMIT time.
#
# Installed (chained) into a repo's .git/hooks/pre-commit by build-and-watch.sh,
# only when the repo has no pre-existing pre-commit hook / custom hooksPath.
# Override a false positive with `git commit --no-verify`.
set -u

repo="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# only act if a graph artifact is staged
staged_graph="$(git diff --cached --name-only --diff-filter=AM 2>/dev/null \
    | grep -E '(^|/)graphify-out/graph\.json$' | head -1)"
[ -n "$staged_graph" ] || exit 0

GBIN="$HOME/.local/bin/graphify"
PYBIN="$(sed -n '1s/^#!//p' "$GBIN" 2>/dev/null)"
[ -x "$PYBIN" ] || PYBIN="python3"

# source_file paths referenced by the staged graph, then ask git which are ignored
offending="$("$PYBIN" - "$repo/$staged_graph" "$repo" <<'PY'
import json, subprocess, sys
gj, repo = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(gj, encoding="utf-8"))
except Exception:
    sys.exit(0)
srcs = sorted({n.get("source_file") for n in data.get("nodes", []) if n.get("source_file")})
if not srcs:
    sys.exit(0)
p = subprocess.run(["git", "-C", repo, "check-ignore", "--stdin"],
                   input="\n".join(srcs), capture_output=True, text=True)
print(p.stdout.strip())
PY
)"

if [ -n "$offending" ]; then
    echo "" >&2
    echo "✋ graphify pre-commit guard: the staged graph (graphify-out/graph.json) indexes" >&2
    echo "   files that .gitignore excludes — these could leak into a committed graph:" >&2
    echo "$offending" | sed 's/^/     - /' >&2
    echo "" >&2
    echo "   Rebuild the graph now that they're ignored (/graphify . --update), or unstage" >&2
    echo "   graphify-out/. To commit anyway: git commit --no-verify" >&2
    echo "" >&2
    exit 1
fi
exit 0
