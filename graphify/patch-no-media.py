#!/usr/bin/env python3
"""Patch graphify with a clean "no media" toggle (no ignore files needed).

graphify has no native switch to skip media — only ignore files or the per-run
--exclude glob flag. This adds a config toggle: when GRAPHIFY_NO_MEDIA=1 (env) OR
~/.graphify/no-media exists (marker file), detect() drops every image / pdf /
video / audio / office file outright. Pure boolean — no gitignore syntax, no
shadowing semantics.

Idempotent + marker-guarded + verified + auto-rollback. Re-run after every
`uv tool upgrade`/`graphify install` (site-packages is wiped). Run with the
graphify interpreter (setup.sh does this).
"""
import shutil
import subprocess
import sys
from pathlib import Path

MARKER = "[w_graphify-no-media]"

ANCHOR_FLAG = '''def detect(root: Path, *, follow_symlinks: bool | None = None, google_workspace: bool | None = None, extra_excludes: list[str] | None = None) -> dict:
    root = root.resolve()'''
INSERT_FLAG = ANCHOR_FLAG + '''
    # {marker} skip all media (image/pdf/video/audio/office) when toggled, with
    # no ignore-file involvement. Env GRAPHIFY_NO_MEDIA=1 or ~/.graphify/no-media.
    _wg_no_media = (os.environ.get("GRAPHIFY_NO_MEDIA", "").strip().lower() in ("1", "true", "yes")) \\
        or (Path.home() / ".graphify" / "no-media").is_file()'''.format(marker=MARKER)

ANCHOR_SKIP = '''        ftype = classify_file(p)
        if ftype:'''
INSERT_SKIP = '''        ftype = classify_file(p)
        if ftype and _wg_no_media and (ftype in (FileType.IMAGE, FileType.PAPER, FileType.VIDEO) or p.suffix.lower() in OFFICE_EXTENSIONS):
            continue  # {marker}
        if ftype:'''.format(marker=MARKER)


def main() -> int:
    import graphify.detect as d
    src_path = Path(d.__file__)
    src = src_path.read_text(encoding="utf-8")

    if MARKER in src:
        print(f"already patched (no-media): {src_path}")
        return 0
    if ANCHOR_FLAG not in src or ANCHOR_SKIP not in src:
        print(f"NOTE: anchor not found in {src_path} — graphify internals changed. "
              "no-media patch skipped (no-op).", file=sys.stderr)
        return 0

    patched = src.replace(ANCHOR_FLAG, INSERT_FLAG, 1).replace(ANCHOR_SKIP, INSERT_SKIP, 1)
    backup = src_path.with_suffix(".py.w_graphify-nomedia.bak")
    shutil.copy2(src_path, backup)
    src_path.write_text(patched, encoding="utf-8")

    r = subprocess.run([sys.executable, "-c", "import graphify.detect"], capture_output=True, text=True)
    if r.returncode != 0:
        shutil.copy2(backup, src_path)
        print("ERROR: patched module failed to import — rolled back.", file=sys.stderr)
        print(r.stderr.strip(), file=sys.stderr)
        return 3

    print(f"no-media patch applied: {src_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
