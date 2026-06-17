#!/usr/bin/env python3
"""Patch graphify so it reads ~/.graphify/graphifyignore as a GLOBAL ignore layer.

graphify has no native global ignore: _load_graphifyignore only walks the scan
root up to the VCS root, and a per-directory .graphifyignore SHADOWS that dir's
.gitignore (verified). So we cannot auto-seed a per-repo .graphifyignore without
breaking projects' .gitignore. Instead we add the global file as the OUTERMOST
(lowest-priority) layer, anchored at the walk ceiling — it never shadows a repo's
own .gitignore/.graphifyignore (different anchor), it only ADDS patterns.

Idempotent + marker-guarded + verified + auto-rollback. Re-run after every
`uv tool upgrade`/`graphify install` (site-packages is wiped on upgrade).
Run with the graphify interpreter (setup.sh does this automatically):
    "$(sed -n '1s/^#!//p' "$(command -v graphify)")" patch-global-ignore.py
"""
import shutil
import subprocess
import sys
from pathlib import Path

MARKER = "[w_graphify-global-ignore]"
ANCHOR = "    patterns: list[tuple[Path, str]] = []"
INSERT = '''
    # {marker} outermost layer: ~/.graphify/graphifyignore applies to every
    # project without shadowing per-repo .gitignore/.graphifyignore (different
    # anchor). Managed by w_server/w_graphify; re-run patch-global-ignore.py
    # after a graphify upgrade.
    _wg_global = Path.home() / ".graphify" / "graphifyignore"
    if _wg_global.is_file():
        for _wg_raw in _wg_global.read_text(encoding="utf-8", errors="ignore").splitlines():
            _wg_line = _parse_gitignore_line(_wg_raw)
            if _wg_line:
                patterns.append((ceiling, _wg_line))
'''.format(marker=MARKER)


def main() -> int:
    import graphify.detect as d
    src_path = Path(d.__file__)
    src = src_path.read_text(encoding="utf-8")

    if MARKER in src:
        print(f"already patched: {src_path}")
        return 0
    if ANCHOR not in src:
        print(f"ERROR: anchor not found in {src_path} — graphify internals changed.", file=sys.stderr)
        print("       Patch NOT applied; global ignore inactive. Inspect _load_graphifyignore manually.", file=sys.stderr)
        return 2

    # insert the block right after the anchor line (only the first occurrence)
    patched = src.replace(ANCHOR, ANCHOR + INSERT, 1)

    backup = src_path.with_suffix(".py.w_graphify.bak")
    shutil.copy2(src_path, backup)
    src_path.write_text(patched, encoding="utf-8")

    # verify the module still imports in a clean subprocess; rollback if not
    r = subprocess.run([sys.executable, "-c", "import graphify.detect"], capture_output=True, text=True)
    if r.returncode != 0:
        shutil.copy2(backup, src_path)
        print("ERROR: patched module failed to import — rolled back.", file=sys.stderr)
        print(r.stderr.strip(), file=sys.stderr)
        return 3

    print(f"patched OK: {src_path}")
    print(f"backup:     {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
