#!/usr/bin/env python3
"""Patch graphify to MERGE .gitignore + .graphifyignore instead of shadowing.

This is the same fix as upstream PR safishamsi/graphify#1364 (issue #1363),
applied locally until it's released. Without it, a directory's .graphifyignore
fully shadows that directory's .gitignore — a pattern present only in .gitignore
(e.g. a secret) is silently dropped and the file gets indexed into the graph.

After the patch both files are read per directory: .gitignore first, then
.graphifyignore appended last so it still wins on conflicts via last-match-wins.

Idempotent + marker-guarded + verified + auto-rollback. Re-run after every
`uv tool upgrade`/`graphify install` (site-packages is wiped on upgrade). Once
the upstream PR ships, the anchor disappears and this becomes a no-op.
Run with the graphify interpreter (setup.sh does this automatically).
"""
import shutil
import subprocess
import sys
from pathlib import Path

MARKER = 'for fname in (".gitignore", ".graphifyignore")'

ANCHOR = '''        # Prefer .graphifyignore; fall back to .gitignore so projects that already
        # maintain a .gitignore get sensible defaults without duplicating it (#945).
        ignore_file = d / ".graphifyignore"
        if not ignore_file.exists():
            ignore_file = d / ".gitignore"
        if ignore_file.exists():
            for raw in ignore_file.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = _parse_gitignore_line(raw)
                if line:
                    patterns.append((d, line))'''

REPLACEMENT = '''        # [w_graphify-merge-ignore] MERGE .gitignore + .graphifyignore — do NOT let
        # one shadow the other. Read .gitignore first, then .graphifyignore, so the
        # latter wins on conflicts via last-match-wins. Adding a .graphifyignore can
        # then only ever exclude MORE, never silently re-include a path .gitignore
        # excluded (which previously leaked .gitignore-only secrets into the graph).
        # Same as upstream PR #1364 / issue #1363; remove once released.
        for fname in (".gitignore", ".graphifyignore"):
            ignore_file = d / fname
            if ignore_file.exists():
                for raw in ignore_file.read_text(encoding="utf-8", errors="ignore").splitlines():
                    line = _parse_gitignore_line(raw)
                    if line:
                        patterns.append((d, line))'''


def main() -> int:
    import graphify.detect as d
    src_path = Path(d.__file__)
    src = src_path.read_text(encoding="utf-8")

    if MARKER in src:
        print(f"already merged (local patch or upstream): {src_path}")
        return 0
    if ANCHOR not in src:
        print(f"NOTE: shadow-block anchor not found in {src_path} — likely already fixed upstream "
              "or internals changed. Merge patch skipped (no-op).", file=sys.stderr)
        return 0

    patched = src.replace(ANCHOR, REPLACEMENT, 1)
    backup = src_path.with_suffix(".py.w_graphify-merge.bak")
    shutil.copy2(src_path, backup)
    src_path.write_text(patched, encoding="utf-8")

    r = subprocess.run([sys.executable, "-c", "import graphify.detect"], capture_output=True, text=True)
    if r.returncode != 0:
        shutil.copy2(backup, src_path)
        print("ERROR: patched module failed to import — rolled back.", file=sys.stderr)
        print(r.stderr.strip(), file=sys.stderr)
        return 3

    print(f"merge patch applied: {src_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
