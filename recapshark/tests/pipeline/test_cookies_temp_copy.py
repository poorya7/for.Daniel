"""
Local end-to-end verification for the lazy-karaoke audio download path.

Exercises `LocalYtDlpProvider.download_to()` directly with the real yt-dlp
+ deno + cookies stack on the local box (no FastAPI / no pm2 / no droplet).

Verifies BOTH:
  1. The cookies in `secrets/youtube_cookies.txt` actually authenticate against
     YouTube (`download_to` succeeds + a non-empty m4a file lands at the
     destination path).
  2. The temp-copy fix in `download_to()` keeps the SOURCE cookies file
     unchanged across yt-dlp invocations (md5 before == md5 after). This is
     the regression we're guarding against.

Usage (from repo root, on Windows):
    .\pipeline\venv\Scripts\python.exe pipeline\test_cookies_temp_copy.py

Exit code: 0 = both checks passed; 1 = either check failed.

This is intentionally a one-shot harness, not a pytest case — it talks to
real YouTube + real deno + writes a real m4a, so it's not appropriate for
CI. Use this when:
  - You just rotated cookies and want to confirm they work before deploying.
  - You changed `audio_cache.py` and want to confirm the temp-copy logic
    hasn't regressed.
  - You suspect cookies got invalidated and want to reproduce locally.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Set env vars BEFORE importing audio_cache. Module-level constants in
# audio_cache.py read os.environ at import time (this is the same gotcha
# we hit in production with server.py — see plan T32). For a local test,
# we hard-wire the paths to the repo's local tooling.
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent

os.environ["YTDLP_BIN"] = str(REPO_ROOT / "pipeline" / "venv" / "Scripts" / "yt-dlp.exe")
os.environ["YTDLP_JS_RUNTIME"] = str(Path.home() / ".deno" / "bin" / "deno.exe")
os.environ["RECAPSHARK_YT_COOKIES_FILE"] = str(REPO_ROOT / "secrets" / "youtube_cookies.txt")
# YTDLP_REMOTE_COMPONENTS defaults to "ejs:github" inside audio_cache, no need to set.

sys.path.insert(0, str(REPO_ROOT / "pipeline"))
import audio_cache  # noqa: E402
from audio_cache import LocalYtDlpProvider  # noqa: E402


def _md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


async def _run() -> bool:
    cookies_file = Path(os.environ["RECAPSHARK_YT_COOKIES_FILE"])
    if not cookies_file.exists():
        print(f"[TEST] [FAIL] cookies file not found at {cookies_file}")
        return False

    print(f"[TEST] cookies file: {cookies_file}")
    print(f"[TEST] cookies size before: {cookies_file.stat().st_size} bytes")
    hash_before = _md5(cookies_file)
    print(f"[TEST] cookies md5  before: {hash_before}")

    provider = LocalYtDlpProvider()
    print(
        f"[TEST] provider: ytdlp_bin={provider.ytdlp_bin!r} "
        f"js_runtime={provider.js_runtime!r} "
        f"cookies_file={provider.cookies_file!r} "
        f"remote_components={provider.remote_components!r}"
    )

    test_video = "qADTr7d6gMU"
    tmp_dir = REPO_ROOT / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    test_dest = tmp_dir / "test_audio.m4a.partial"
    test_dest.unlink(missing_ok=True)

    print(f"\n[TEST] downloading {test_video} -> {test_dest}")
    download_ok = False
    try:
        await provider.download_to(test_video, test_dest)
        # yt-dlp may write the audio under a slightly-different filename
        # depending on format/template handling — list everything in tmp/
        # so the failure mode "the file went somewhere else" is visible
        # rather than silent.
        produced = sorted(p for p in tmp_dir.iterdir() if p.is_file())
        print(f"[TEST] tmp_dir contents after download_to: {[p.name for p in produced]}")
        if test_dest.exists() and test_dest.stat().st_size > 0:
            print(f"[TEST] [PASS] download SUCCEEDED, size: {test_dest.stat().st_size} bytes")
            download_ok = True
        elif produced:
            biggest = max(produced, key=lambda p: p.stat().st_size)
            print(
                f"[TEST] [FAIL] download_to returned but expected dest {test_dest.name} "
                f"missing/empty. Largest produced: {biggest.name} = {biggest.stat().st_size} bytes"
            )
        else:
            print(f"[TEST] [FAIL] download_to returned but no files in {tmp_dir}")
    except Exception as e:
        print(f"[TEST] [FAIL] download FAILED: {e}")
    finally:
        # Clean up anything in tmp_dir that this test produced
        for p in list(tmp_dir.iterdir()):
            if p.is_file() and (p.name.startswith("test_audio") or p.suffix == ".m4a"):
                p.unlink(missing_ok=True)

    print(f"\n[TEST] cookies size after: {cookies_file.stat().st_size} bytes")
    hash_after = _md5(cookies_file)
    print(f"[TEST] cookies md5  after: {hash_after}")

    preserved = hash_before == hash_after
    if preserved:
        print(f"[TEST] [PASS] source cookies file PRESERVED across yt-dlp call")
    else:
        print(f"[TEST] [FAIL] source cookies file MUTATED — temp-copy fix is broken")

    print()
    print(f"[TEST] result: download={'OK' if download_ok else 'FAIL'} preserve={'OK' if preserved else 'FAIL'}")
    return download_ok and preserved


if __name__ == "__main__":
    ok = asyncio.run(_run())
    sys.exit(0 if ok else 1)
