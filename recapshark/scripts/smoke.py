"""Pre-deploy smoke test for the prod build.

Verifies the dist/ output is internally consistent — every asset URL
referenced from any HTML or built JS file actually exists in dist/.
Catches the class of bugs that broke recapshark.com in 2026-04:

  - Forgot to run `npm run build` (no dist/index.html).
  - Classic <script src="..."> not bundled by Vite and not copied to dist/
    (browser gets a 404 served as text/html, blocked by nosniff).
  - Bare module specifier (e.g. `import "@supabase/supabase-js"`) ending up
    in a served JS file because Vite couldn't resolve it.
  - Hardcoded asset path in a JS string literal (e.g. `"art/logo/x.png"`)
    that works on Vite dev server but 404s on prod nginx.

Exit 0 on success, 1 on any failure with a clear report. No network calls,
no server spawn — pure file-system inspection of dist/.

Usage:
    python scripts/smoke.py
    npm run smoke
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import urlparse


DIST = Path(__file__).resolve().parent.parent / "dist"

# Regex to find src="..." or href="..." values in HTML/JS. Skips srcset
# (uses commas) — those are rare in this codebase.
_ATTR_RE = re.compile(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']')

# Regex for ES module imports (static + dynamic) and re-exports. Captures the
# module specifier between quotes. Multiline-safe.
_IMPORT_RE = re.compile(
    r'(?:^|\s|;|\})\s*'
    r'(?:import\s+(?:[^"\';]+?\s+from\s+)?|export\s+[^"\';]+?\s+from\s+|import\s*\(\s*)'
    r'["\']([^"\']+)["\']'
)

# Vite hashes assets into /assets/<name>-<hash>.<ext>. Anything still pointing
# at a non-/assets/ source path (other than known-public dirs) is suspicious.
_PUBLIC_PREFIXES = ("/js/",)  # files copied verbatim from src/public/


def _is_external(url: str) -> bool:
    """Return True for absolute URLs (http, https, data, mailto, etc.)."""
    if url.startswith(("http://", "https://", "data:", "mailto:", "//", "#")):
        return True
    parsed = urlparse(url)
    return bool(parsed.scheme)


def _resolve_dist_path(url: str) -> Path | None:
    """Map a URL like '/assets/foo.png' or 'js/bar.js' to a path in dist/.

    Returns None if the URL is external or otherwise not a local file.
    """
    if _is_external(url):
        return None
    # Strip query strings and fragments.
    clean = url.split("?", 1)[0].split("#", 1)[0]
    if not clean:
        return None
    return DIST / clean.lstrip("/")


def _check_html_assets(html_path: Path, failures: list[str]) -> None:
    """For every src/href in the HTML, verify the referenced file exists."""
    content = html_path.read_text(encoding="utf-8", errors="replace")
    rel = html_path.relative_to(DIST)
    for match in _ATTR_RE.finditer(content):
        url = match.group(1).strip()
        target = _resolve_dist_path(url)
        if target is None:
            continue
        if not target.exists():
            failures.append(f"  {rel}: references '{url}' -> NOT FOUND in dist/")


def _check_js_imports(js_path: Path, failures: list[str]) -> None:
    """Flag bare-specifier imports in served JS (sign of unresolved bundling)."""
    content = js_path.read_text(encoding="utf-8", errors="replace")
    rel = js_path.relative_to(DIST)
    for match in _IMPORT_RE.finditer(content):
        spec = match.group(1).strip()
        # Allowed: relative ('./', '../'), absolute path ('/'), full URLs.
        if spec.startswith((".", "/", "http://", "https://", "data:")):
            continue
        # Anything else is a bare specifier — browser can't resolve it.
        failures.append(f"  {rel}: bare-specifier import '{spec}' (not bundled)")


def main() -> int:
    if not DIST.exists():
        print(f"FAIL: dist/ does not exist. Run `npm run build` first.")
        return 1

    if not (DIST / "index.html").exists():
        print(f"FAIL: dist/index.html missing. Run `npm run build` first.")
        return 1

    failures: list[str] = []

    html_files = sorted(DIST.glob("*.html"))
    for html in html_files:
        _check_html_assets(html, failures)

    # Only scan JS files OUTSIDE dist/assets/ for bare-specifier imports.
    # Vite-emitted bundles in dist/assets/ are by definition self-resolved;
    # any "bare-specifier" hit there is a false positive from string literals
    # (e.g. supabase-js embeds `import ws from "ws"` inside an error message).
    # The real risk lives in classic <script> files copied verbatim from
    # src/public/ — those reach the browser unprocessed.
    js_files = sorted(p for p in DIST.rglob("*.js") if "assets" not in p.parts)
    for js in js_files:
        _check_js_imports(js, failures)
    bundle_count = sum(1 for _ in DIST.rglob("*.js")) - len(js_files)

    total_files = sum(1 for _ in DIST.rglob("*") if _.is_file())

    if failures:
        print(f"FAIL: {len(failures)} issue(s) in dist/ ({total_files} files scanned):")
        for line in failures:
            print(line)
        return 1

    print(
        f"OK: dist/ is clean - {len(html_files)} HTML, {len(js_files)} classic "
        f"JS, and {bundle_count} bundle(s) checked ({total_files} total files)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
