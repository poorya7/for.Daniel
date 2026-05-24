"""
Audio cache for lazy karaoke.

Manages the lifecycle of cached audio files used by the chunk endpoint:

- Downloads full-video m4a once via yt-dlp on first request, atomically
  renames `.m4a.partial` -> `.m4a` on success. Prevents readers from ever
  seeing a torn write.
- Per-video `asyncio.Lock` prevents duplicate yt-dlp processes for the same
  video. Multiple concurrent callers all wait on the same lock, then the
  second caller sees the existing target and returns immediately.
- `has_ready` / `is_downloading` let the chunk handler decide whether to
  claim a Postgres reservation now vs. return `audio_not_ready` and let
  the client retry on the server-provided cooldown (see plan §12 / D25).
- `slice_audio` uses ffmpeg with re-encode (NOT `-c copy`) for sample-
  accurate timestamps. `-c copy` seeks to the nearest keyframe which can
  drift up to 1-2s and silently break karaoke word alignment (D16, T2).
- `evict_lru` enforces a smart cap: `min(max_gb, 70% of free disk)` so
  the cache auto-shrinks if disk fills from elsewhere. The backend NEVER
  crashes from disk-full; worst case is `audio_unavailable` returned to
  the chunk handler, which falls back to plain transcript (graceful
  degrade per §12 cardinal rule).
- yt-dlp circuit-breaker: 5 failures within 5 min opens the breaker for
  10 min, during which `ensure_audio` fast-fails instead of hammering
  YouTube (which would tank our IP rep + waste compute).

Phase 0 verified the system requirements:
  /usr/bin/ffmpeg                                  (system PATH)
  /opt/recapshark/pipeline/venv/bin/yt-dlp        (venv-only, NOT on PATH)
  /var/recapshark/audio                            (created, root-owned)

Because yt-dlp is venv-only on the droplet, the binary path is configurable
via `YTDLP_BIN` env var. Production droplet sets it to the venv path; local
dev typically uses the bare name (PATH lookup) — see deploy doc.

Orchestrated by `pipeline/asr_provider_routes.py` `/api/karaoke-chunk` handler.
"""

import asyncio
import os
import shutil
import subprocess
import tempfile
import time
import urllib.parse
from collections import deque
from pathlib import Path

import httpx

from config import (
    audio_cache_dir,
    audio_cache_max_gb,
    ffmpeg_bin,
    recapshark_yt_cookies_file,
    recapshark_yt_proxy_url,
    ytdlp_bin,
    ytdlp_js_runtime,
    ytdlp_remote_components,
)

# --------------------------------------------------------------------------- #
# Configuration (env-overridable)
# --------------------------------------------------------------------------- #

# Binary paths. Default to bare name = PATH lookup, which works for ffmpeg
# (system-installed) but NOT yt-dlp on the production droplet (venv-only).
# Production .env sets YTDLP_BIN=/opt/recapshark/pipeline/venv/bin/yt-dlp.
YTDLP_BIN = ytdlp_bin()
FFMPEG_BIN = ffmpeg_bin()

# JavaScript runtime path (deno) for yt-dlp YouTube extraction. Modern
# yt-dlp deprecated extracting without a JS runtime — without it, the
# extractor falls back to a deprecated path that hits YouTube bot
# detection more aggressively. Default empty = let yt-dlp try its
# defaults (warns + falls through). Production droplet sets
# YTDLP_JS_RUNTIME=/root/.deno/bin/deno (see Phase 0 pre-flight).
YTDLP_JS_RUNTIME = ytdlp_js_runtime()

# Path to a Netscape-format cookies.txt file from a logged-in YouTube
# session. REQUIRED in production from a datacenter IP — anonymous
# yt-dlp from cloud IPs (DigitalOcean, AWS, GCP) gets bot-blocked by
# YouTube ("Sign in to confirm you're not a bot"). Use a THROWAWAY
# YouTube account, NEVER your personal one — the account is at risk
# of being flagged for automated traffic. Cookies typically expire every
# 1-3 months and have to be refreshed manually.
RECAPSHARK_YT_COOKIES_FILE = recapshark_yt_cookies_file()

# yt-dlp "remote components" spec (EJS challenge solver scripts). Modern
# YouTube extraction (yt-dlp >= 2026.03.17) requires per-player JS solver
# scripts that live OUTSIDE the yt-dlp distribution and are downloaded /
# cached on first use. Without them, even with cookies + deno, the
# extractor reports "n challenge solving failed" and returns no audio
# formats. `ejs:github` tells yt-dlp to fetch them from the official
# yt-dlp/ejs github releases (cached locally after first download, so
# the network hit only happens once per yt-dlp version). Default ON for
# production; set to empty string to disable (only useful for older
# yt-dlp versions that don't recognize the flag, or for offline tests
# with a pre-cached EJS bundle).
YTDLP_REMOTE_COMPONENTS = ytdlp_remote_components()

# Residential proxy URL(s) for routing yt-dlp through non-datacenter IPs.
# Single URL or comma-separated list. Each entry: scheme://user:pass@host:port.
# Supported schemes: http, https, socks5. When set, _get_provider() returns
# ProxiedYtDlpProvider instead of LocalYtDlpProvider. Empty = no proxy.
# Multi-URL form enables round-robin rotation across our ProxyProvider static
# residential pool (20 IPs at v1) — see ProxiedYtDlpProvider docstring.
#
# Why this exists: YouTube IP-blocks DigitalOcean / AWS / GCP datacenter
# ranges. Cookies + deno + EJS + PO Token defeat the cookie/JS/anti-bot
# challenges, but NONE of them help if the IP itself is on YT's bot list.
# Empirically validated 2026-05-05 against ProxyProvider static residential US
# IPs — five previously-failing public videos all pulled clean once
# routed through a residential IP. See feedback bundle in
# docs/_logs/yt-ipblock-help/feedbacks/ (engineers 03 + 04 both
# converged on this fix). LAZY_KARAOKE.md D38 was built for this swap.
RECAPSHARK_YT_PROXY_URL = recapshark_yt_proxy_url()

# Cache directory. Created in Phase 0; configurable in case we move mounts.
AUDIO_DIR = Path(audio_cache_dir())

# Smart cap for LRU eviction. Actual cap = min(max_gb, 70% of free disk).
# 10 GB default holds ~44 four-hour podcasts (m4a@128k ~= 230 MB each).
AUDIO_CACHE_MAX_GB = audio_cache_max_gb()

# A `.partial` file older than this is assumed to be from a crashed prior
# process and gets deleted before retry. yt-dlp downloads a 30-min video
# in <30s, so 5 min is way more than worst-case (no false-positive deletes).
STALE_PARTIAL_AGE_SEC = 300

# LRU race-safety: any file with mtime newer than this is considered "active"
# and protected from eviction. `slice_audio` calls `Path.touch()` before
# reading, so files in active use stay fresh (see T21).
LRU_FRESH_AGE_SEC = 3600  # 60 min

# yt-dlp circuit-breaker — prevents IP-rep damage from runaway YT failures.
CIRCUIT_FAIL_WINDOW_SEC = 300       # rolling window for counting failures
CIRCUIT_FAIL_THRESHOLD = 5          # failures in window before tripping
CIRCUIT_OPEN_DURATION_SEC = 600     # cool-down period once tripped

# Per-video terminal-failure memory TTL. Deleted/geoblocked/copyright-pulled
# videos return AudioDownloadError once and would otherwise report as
# `audio_not_ready` (retryable forever) on every subsequent chunk request,
# leaving the frontend spinning. The TTL lets a fresh attempt happen after
# 5 min in case the failure was transient (e.g. proxy hiccup).
RECENT_FAILURE_TTL_SEC = 300


# --------------------------------------------------------------------------- #
# Module-level state
# --------------------------------------------------------------------------- #

# Per-video lock prevents two concurrent yt-dlp processes for the same video.
# Locks accumulate (never cleaned up) but each is ~100 bytes so even thousands
# of unique videos = trivial memory. Cleanup is more code than it's worth.
_audio_locks: dict[str, asyncio.Lock] = {}

# Currently-running download tasks. Popped in the done-callback so the dict
# only ever contains in-flight downloads. `is_downloading()` reads it.
_downloading_tasks: dict[str, asyncio.Task] = {}

# Rolling failure timestamps for the breaker. Pruned on each `_record_failure`.
_failure_timestamps: deque[float] = deque()

# Monotonic time when the breaker auto-closes. Until then, `_is_circuit_open`
# returns True and ensure_audio / ensure_started fast-fail.
_circuit_open_until: float = 0.0

# Per-video recent-failure memory: video_id -> (monotonic_ts, error_msg).
# Set when a download terminates with AudioDownloadError; cleared on the
# next successful download for that video. Entries auto-expire on read
# after RECENT_FAILURE_TTL_SEC. Lets the chunk endpoint distinguish
# "still downloading" from "this video already failed and won't recover
# right now" — without it, dead videos report as audio_not_ready forever.
_recent_download_failures: dict[str, tuple[float, str]] = {}

# --- Partial-audio-download state (RECAPSHARK_USE_PARTIAL_DOWNLOAD path) --- #
#
# Cached direct googlevideo.com URL per video. (monotonic_ts, url). YouTube
# signed URLs typically last ~6h; 5h TTL gives a 1h safety margin against
# clock skew / expiry quirks. On expiry: re-extract via yt-dlp --get-url.
_URL_CACHE_TTL_SEC = 5 * 3600
_url_cache: dict[str, tuple[float, str]] = {}

# Per-video lock for the URL-extraction critical section. Prevents N
# concurrent fresh-paste chunk requests from all firing yt-dlp --get-url
# simultaneously. Separate from `_audio_locks` (which guards the audio file)
# because URL extraction and byte-range fetching are independent serialization
# concerns — the URL can be cached + reused while the file is being written.
_audio_url_locks: dict[str, asyncio.Lock] = {}

# Bytes-on-disk for the partial-download path's audio file.
# `<video_id> -> int bytes`. Updated under `_audio_locks[video_id]` after a
# successful append. Cleared on detect-missing-file (W4) so a mid-session LRU
# evict doesn't leave us with a stale "I have N bytes" record + an empty file.
_partial_audio_state: dict[str, int] = {}

# In-flight background-backfill tasks. `<video_id> -> asyncio.Task`. Used to
# dedupe so a re-paste / page-reload doesn't fire a second concurrent backfill
# for the same video while the first is still running. Popped in the done-
# callback so the dict only ever contains live tasks.
_backfill_tasks: dict[str, asyncio.Task] = {}

# Bytes per increment of the background backfill. Small enough that user-
# initiated scrub requests can interleave between increments (the lock is
# released between fetches), large enough that we don't waste round-trips.
_BACKFILL_INCREMENT_BYTES = 20 * 1024 * 1024  # 20 MB

# Encoded audio rate for YT format 140 (m4a 128 kbps). Empirically
# ≈ 16 KB/s on the production proxy (DECISIONS.md Test 3). Used to convert
# "fetch this many seconds of audio" → "fetch this many bytes".
_FORMAT_140_BYTES_PER_SEC = 16 * 1024

# Safety margin so we always grab the full moov atom + a bit of leading data
# even if the bytes-per-sec estimate is off by 10-20%. 1 MB is way more than
# the largest moov we've seen empirically (~100 KB).
_MOOV_HEADROOM_BYTES = 1 * 1024 * 1024

# How long the HTTP range request is allowed to take. The bytes are small
# (~10 MB per chunk) and on a healthy proxy the fetch is 1-2s, so 30s is
# generous worst-case before we should give up and let the frontend retry.
_RANGE_FETCH_TIMEOUT_SEC = 30.0


# --------------------------------------------------------------------------- #
# Exceptions (allows the chunk handler to classify failures cleanly)
# --------------------------------------------------------------------------- #

class AudioDownloadError(Exception):
    """yt-dlp failed (network error, blocked video, copyright, etc.).
    Caller maps to `audio_unavailable` error code in the chunk envelope."""


class AllProxiesBlockedError(AudioDownloadError):
    """Raised by `ProxiedYtDlpProvider.download_to` when every retry in
    the rotation budget (`_BOT_BLOCK_MAX_ATTEMPTS`) hit YouTube's
    "Sign in to confirm you're not a bot" challenge. Distinguished from
    plain `AudioDownloadError` because the failure mode is **transient
    and IP-specific**: the next download request, starting at the next
    round-robin index, may hit clean IPs immediately.

    Caller in `_download_with_lock` must NOT cache this as a per-video
    terminal entry in `_recent_download_failures` — doing so would block
    legitimate retries for `RECENT_FAILURE_TTL_SEC` (5 min) even though
    the next yt-dlp attempt would likely succeed. The circuit breaker
    still counts the failure (`_record_failure`) so a system-wide event
    where every IP is simultaneously flagged still trips it and falls
    back to plain transcript gracefully."""


class AudioSliceError(Exception):
    """ffmpeg failed (corrupt source, out-of-range timestamp, etc.).
    Caller maps to `audio_unavailable` error code (chunk-specific failure
    that DOES cache as `failed` row, per D31)."""


# --------------------------------------------------------------------------- #
# Audio source provider abstraction
# --------------------------------------------------------------------------- #

class AudioSourceProvider:
    """Abstract interface for downloading YouTube audio. The chunk endpoint
    is decoupled from how audio is actually fetched — cookies / proxies /
    alternative providers all swap in here without touching asr_provider_routes.py
    or the chunk handler.

    Implementations:
      - LocalYtDlpProvider — yt-dlp subprocess (current production).
      - (future) ProxiedYtDlpProvider — yt-dlp through residential proxy
        ($50-500/mo, planned for when traffic > ~1k DAU per Friend 04
        review on 2026-05-01; until then cookies are sufficient).
      - (future) MockProvider — for pytest fixtures.

    Methods raise AudioDownloadError on failure for clean classification
    by the chunk handler. Implementations are responsible for their own
    subprocess-spawning, error handling, and stderr capture; the caller
    only sees success or AudioDownloadError.
    """

    async def download_to(self, video_id: str, dest_path: Path) -> None:
        """Download the YouTube audio for `video_id` to `dest_path`. Caller
        handles the atomic rename (.partial -> final) and locking; the
        provider just ensures the file exists at dest_path on success.

        Raises AudioDownloadError on any failure (network, auth, format)."""
        raise NotImplementedError


class LocalYtDlpProvider(AudioSourceProvider):
    """yt-dlp subprocess. Honors:
      - YTDLP_BIN — path to yt-dlp binary (venv-only on droplet, see Phase 0)
      - YTDLP_JS_RUNTIME — path to deno (required for modern YouTube
        extraction; without it, yt-dlp falls back to a deprecated path
        that triggers bot detection more aggressively)
      - RECAPSHARK_YT_COOKIES_FILE — Netscape-format cookies.txt from a
        logged-in YouTube session (REQUIRED in production from datacenter
        IPs; YouTube blocks anonymous extraction with "Sign in to confirm
        you're not a bot"). Use a THROWAWAY YouTube account, NEVER personal.
      - YTDLP_REMOTE_COMPONENTS — EJS challenge solver spec (default
        `ejs:github`). Required for yt-dlp >= 2026.03.17 to solve the
        "n parameter" signature challenge; without it, formats return as
        UNPLAYABLE / "page needs to be reloaded".

    All four values are read at __init__ time. Restart the server (pm2
    restart) to pick up cookie file rotation or env changes.

    **Cookies file is COPIED to a tempfile per yt-dlp invocation** and the
    temp path is what gets passed via --cookies. yt-dlp's default behavior
    is to mutate the cookies file with Set-Cookie responses from YouTube,
    which (because YouTube aggressively invalidates sessions on automated
    traffic) silently strips the auth cookies and breaks all subsequent
    calls. Copying preserves RECAPSHARK_YT_COOKIES_FILE across runs; the
    temp gets discarded after each call. See upstream yt-dlp issues
    #5977 / #15335 / #8227.
    """

    def __init__(self):
        self.ytdlp_bin = YTDLP_BIN
        self.js_runtime = YTDLP_JS_RUNTIME
        self.cookies_file = RECAPSHARK_YT_COOKIES_FILE
        self.remote_components = YTDLP_REMOTE_COMPONENTS

    def _build_command(self, video_id: str, dest_path: Path, cookies_path: str = "") -> list[str]:
        """Compose the yt-dlp argv. Optional flags (cookies, JS runtime,
        remote components) only added when their config is set — keeps
        local dev (no cookies, no deno) behaving the same as before this
        refactor, and lets ops disable EJS for older yt-dlp versions by
        setting YTDLP_REMOTE_COMPONENTS=''.

        `cookies_path` is the per-call cookies file to pass to yt-dlp,
        typically a tempfile copy of self.cookies_file (see download_to
        for why we copy). Empty string means no --cookies flag is added
        (local dev / unauthenticated tests)."""
        cmd = [
            self.ytdlp_bin,
            "-x",                                     # extract audio only
            "--audio-format", "m4a",
            "-f", "bestaudio[ext=m4a]/bestaudio",
            "-o", str(dest_path),
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        if self.js_runtime:
            cmd.extend(["--js-runtimes", f"deno:{self.js_runtime}"])
        if cookies_path:
            cmd.extend(["--cookies", cookies_path])
        if self.remote_components:
            cmd.extend(["--remote-components", self.remote_components])
        return cmd

    async def download_to(self, video_id: str, dest_path: Path) -> None:
        # yt-dlp's --cookies flag mutates the file in place by default,
        # writing Set-Cookie response headers from YouTube back into it.
        # YouTube aggressively invalidates sessions on automated traffic,
        # so the cookies file gets stripped to an unauthenticated state
        # within a few calls and every subsequent yt-dlp run silently
        # falls through to the bot-blocked anonymous extractor path
        # (deprecated `android vr player API JSON`). To prevent this, we
        # copy self.cookies_file to a tempfile per call and pass the
        # temp path to yt-dlp. yt-dlp may corrupt the temp; we discard
        # it afterward, source file stays pristine across invocations.
        # See yt-dlp issues #5977, #15335, #8227.
        cookies_temp: Path | None = None
        cookies_path_for_cmd = ""
        if self.cookies_file:
            _fd, _tmp_path = tempfile.mkstemp(prefix="recapshark-cookies-", suffix=".txt")
            os.close(_fd)
            cookies_temp = Path(_tmp_path)
            try:
                shutil.copy2(self.cookies_file, cookies_temp)
            except Exception as e:
                cookies_temp.unlink(missing_ok=True)
                raise AudioDownloadError(
                    f"failed to stage cookies tempfile from {self.cookies_file}: {e}"
                )
            cookies_path_for_cmd = str(cookies_temp)

        cmd = self._build_command(video_id, dest_path, cookies_path_for_cmd)

        # Strip Node.js IPC env vars from the child's environment. PM2 is
        # a Node-based process manager that injects NODE_CHANNEL_FD=3 (+
        # NODE_CHANNEL_SERIALIZATION_MODE=json) into its managed processes
        # so it can talk IPC to them. That env leaks down into uvicorn ->
        # yt-dlp -> deno. Deno is Node-compatible enough that it sees
        # NODE_CHANNEL_FD and tries to open FD 3 as a BiPipe IPC channel
        # to a "Node parent" — but FD 3 was never wired up as an IPC pipe
        # for deno's grandparent (yt-dlp's grandparent is uvicorn-via-pm2),
        # so deno crashes with `Failed to open IPC channel from
        # NODE_CHANNEL_FD (3): fd is not from BiPipe.` yt-dlp then reports
        # `n challenge solving failed: Some formats may be missing` and
        # falls back to the deprecated android-vr extractor path which
        # produces only image-format thumbnails — final user-visible
        # error: `Requested format is not available`. Confirmed
        # 2026-05-02 in the droplet's pm2 logs after a full -v dump.
        # The fix is one-shot: pop NODE_CHANNEL_FD/serialization-mode
        # from the env we hand to the subprocess. PM2 still talks to
        # uvicorn; uvicorn-spawned children just don't pretend they're
        # in the same IPC.
        clean_env = os.environ.copy()
        for _var in ("NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"):
            clean_env.pop(_var, None)

        try:
            # Run yt-dlp via SYNC subprocess on a thread (not asyncio's own
            # subprocess). Sync `subprocess.run` is the verified-working
            # pattern across all contexts tested (interactive shell, plain
            # Python REPL, fresh asyncio loop). Wrapping it in
            # `asyncio.to_thread(...)` keeps FastAPI non-blocking — the
            # thread parks while subprocess runs.
            try:
                result = await asyncio.to_thread(
                    subprocess.run,
                    cmd,
                    capture_output=True,
                    check=False,
                    env=clean_env,
                )
            except FileNotFoundError as e:
                raise AudioDownloadError(f"yt-dlp binary not found at {self.ytdlp_bin}: {e}")

            if result.returncode != 0:
                err_tail = (result.stderr.decode(errors="replace") if result.stderr else "")[-500:]
                raise AudioDownloadError(f"yt-dlp returncode={result.returncode}: {err_tail}")

            # yt-dlp's `-x --audio-format m4a -o <path>` appends `.m4a` to
            # `<path>` when it doesn't already end in `.m4a` (the "extract
            # audio" pipeline always names the final file by the audio
            # format, ignoring whatever extension the -o template ends in).
            # Our caller passes dest_path as `<vid>.m4a.partial`, which yt-dlp
            # writes to as `<vid>.m4a.partial.m4a`. Rename back so the
            # caller's atomic-replace logic in _download_with_lock finds the
            # file at the expected dest_path.
            if not dest_path.exists():
                suffixed = dest_path.with_name(dest_path.name + ".m4a")
                if suffixed.exists():
                    suffixed.rename(dest_path)
        finally:
            if cookies_temp is not None:
                cookies_temp.unlink(missing_ok=True)

    def _build_url_command(self, video_id: str, cookies_path: str = "") -> list[str]:
        """Compose the `yt-dlp --get-url -f 140 --simulate` argv. Same
        anti-bot stack as `_build_command` (cookies tempfile, deno, EJS,
        proxy via subclass) — only the action flags differ. Format 140 is
        the YouTube m4a 128 kbps stream that's served by googlevideo.com
        with `Accept-Ranges: bytes` (empirically validated 2026-05-11)."""
        cmd = [
            self.ytdlp_bin,
            "-f", "140",
            "--get-url",
            "--simulate",
            "--no-warnings",
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        if self.js_runtime:
            cmd.extend(["--js-runtimes", f"deno:{self.js_runtime}"])
        if cookies_path:
            cmd.extend(["--cookies", cookies_path])
        if self.remote_components:
            cmd.extend(["--remote-components", self.remote_components])
        return cmd

    async def extract_audio_url(self, video_id: str) -> str:
        """Return the direct googlevideo.com URL for format 140 m4a audio
        without downloading the file. Reuses the same cookies-tempfile-copy
        pattern as `download_to` (T33) and the same NODE_CHANNEL_FD strip
        (T36) — must match exactly or extraction hits the same bot-block /
        IPC crashes that `download_to` was hardened against.

        Returns the URL on success; raises AudioDownloadError on yt-dlp
        failure. ProxiedYtDlpProvider overrides this to add bot-block
        retry across the IP rotation (same pattern as `download_to`)."""
        cookies_temp: Path | None = None
        cookies_path_for_cmd = ""
        if self.cookies_file:
            _fd, _tmp_path = tempfile.mkstemp(prefix="recapshark-cookies-", suffix=".txt")
            os.close(_fd)
            cookies_temp = Path(_tmp_path)
            try:
                shutil.copy2(self.cookies_file, cookies_temp)
            except Exception as e:
                cookies_temp.unlink(missing_ok=True)
                raise AudioDownloadError(
                    f"failed to stage cookies tempfile from {self.cookies_file}: {e}"
                )
            cookies_path_for_cmd = str(cookies_temp)

        cmd = self._build_url_command(video_id, cookies_path_for_cmd)

        clean_env = os.environ.copy()
        for _var in ("NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"):
            clean_env.pop(_var, None)

        try:
            try:
                # Hard timeout: a healthy `--get-url` through ProxyProvider proxies
                # takes 4-7s (p95 ~7s, measured 2026-05-11 across 10 IPs
                # against `dQw4w9WgXcQ`). A bot-blocked attempt left to run
                # eats ~30s before yt-dlp gives up — that dominates total
                # latency when the first IP in the rotation is flagged.
                # Killing at 10s lets the bot-block retry path (in
                # `ProxiedYtDlpProvider.extract_audio_url`) advance to a
                # fresh IP ~3x faster. The TimeoutExpired error message
                # contains "timed out" so `_looks_like_bot_block` matches it
                # and the retry triggers.
                result = await asyncio.to_thread(
                    subprocess.run,
                    cmd,
                    capture_output=True,
                    check=False,
                    env=clean_env,
                    timeout=10.0,
                )
            except FileNotFoundError as e:
                raise AudioDownloadError(f"yt-dlp binary not found at {self.ytdlp_bin}: {e}")
            except subprocess.TimeoutExpired:
                # Treat as bot-block so the rotation retry kicks in. Marker
                # phrase "timed out" matches `_looks_like_bot_block`.
                raise AudioDownloadError(
                    f"yt-dlp --get-url timed out after 10s (treating as bot-block / "
                    f"not a bot — flagged IP); retrying on next proxy"
                )

            if result.returncode != 0:
                err_tail = (result.stderr.decode(errors="replace") if result.stderr else "")[-500:]
                raise AudioDownloadError(f"yt-dlp --get-url returncode={result.returncode}: {err_tail}")

            # --get-url emits the URL on stdout. Modern yt-dlp can sometimes
            # print warnings on stdout even with --no-warnings (e.g. when
            # the player downgrades a format), so take the first non-empty
            # line that looks like a URL.
            stdout = (result.stdout.decode(errors="replace") if result.stdout else "").strip()
            for line in stdout.splitlines():
                candidate = line.strip()
                if candidate.startswith("http://") or candidate.startswith("https://"):
                    return candidate
            err_tail = (result.stderr.decode(errors="replace") if result.stderr else "")[-500:]
            raise AudioDownloadError(
                f"yt-dlp --get-url returned no URL on stdout; stderr tail: {err_tail}"
            )
        finally:
            if cookies_temp is not None:
                cookies_temp.unlink(missing_ok=True)


# Maximum total attempts (1 initial + up to N-1 bot-block retries) inside
# `ProxiedYtDlpProvider.download_to`. Each retry naturally rotates to the
# next proxy via `_build_command`'s round-robin counter. Cap exists because
# each yt-dlp call is ~5-10s on bot-block, so unlimited retries would blow
# past the frontend's 60s chunk-fetch budget. 4 attempts gives `p^4` final
# failure rate against a pool with `p` fraction of flagged IPs — e.g.
# p=0.25 (5/20 flagged) -> 0.4% effective failure rate, vs the 25% raw
# rate without retry.
_BOT_BLOCK_MAX_ATTEMPTS = 4


def _looks_like_bot_block(err_msg: str) -> bool:
    """True if a yt-dlp stderr tail matches YouTube's IP-flagged bot
    challenge. We only retry on this specific signal — other failures
    (network, format, real auth gate) should bubble up immediately so
    the circuit breaker / chunk endpoint can return the right error.

    Matches on stable substrings — YouTube has shipped this challenge
    with both straight (') and curly (') apostrophes; "not a bot" is the
    unique tail that survives both forms and likely future copy tweaks.
    """
    lo = err_msg.lower()
    return "not a bot" in lo or "sign in to confirm" in lo


class ProxiedYtDlpProvider(LocalYtDlpProvider):
    """LocalYtDlpProvider routed through one or more residential proxies.
    Inherits everything (cookies tempfile copy, NODE_CHANNEL_FD strip,
    atomic rename, error semantics) and adds `--proxy <url>` to the
    yt-dlp invocation, picking the next URL via round-robin per call.

    `RECAPSHARK_YT_PROXY_URL` is a single URL OR a comma-separated list
    of URLs. Each entry must be `scheme://user:pass@host:port` (http,
    https, or socks5). Restart pm2 to pick up env-var changes.

    Round-robin distributes load across all configured IPs so any single
    burned IP only affects 1/N of calls. Per-call advance (not per-
    instance) so long-running uvicorn processes spread traffic evenly.
    ProxyProvider's static residential SHARED tier is the v1 production
    config — 20 IPs all running through this rotation.

    On-block retry (shipped 2026-05-11): `download_to` retries up to
    `_BOT_BLOCK_MAX_ATTEMPTS` times when yt-dlp returns the
    "Sign in to confirm you're not a bot" challenge — each retry naturally
    lands on the next proxy in the rotation because `_build_command`
    advances `_round_robin_idx` on every call. Non-bot-block errors
    (real network / format / auth issues) bubble up immediately. See
    `_looks_like_bot_block`.

    Construction raises RuntimeError if no URLs parse out — this
    provider only makes sense when a proxy is actually configured.
    `_get_provider()` is the discovery point that picks Local vs Proxied
    based on env-var presence.
    """

    def __init__(self):
        super().__init__()
        urls = [u.strip() for u in RECAPSHARK_YT_PROXY_URL.split(",") if u.strip()]
        if not urls:
            raise RuntimeError(
                "ProxiedYtDlpProvider requires RECAPSHARK_YT_PROXY_URL "
                "(single URL or comma-separated list)"
            )
        self.proxy_urls = urls
        self._round_robin_idx = 0

    def _build_command(
        self, video_id: str, dest_path: Path, cookies_path: str = ""
    ) -> list[str]:
        cmd = super()._build_command(video_id, dest_path, cookies_path)
        proxy = self.proxy_urls[self._round_robin_idx % len(self.proxy_urls)]
        self._round_robin_idx += 1
        cmd.extend(["--proxy", proxy])
        return cmd

    def _build_url_command(self, video_id: str, cookies_path: str = "") -> list[str]:
        cmd = super()._build_url_command(video_id, cookies_path)
        proxy = self.proxy_urls[self._round_robin_idx % len(self.proxy_urls)]
        self._round_robin_idx += 1
        cmd.extend(["--proxy", proxy])
        return cmd

    def current_proxy(self) -> str:
        """Return the proxy URL that the NEXT call to `_build_command` /
        `_build_url_command` will use. Read by the range-fetcher so it
        can route its HTTP request through the same proxy pool. Does NOT
        advance the round-robin counter — only `_build_*_command` does."""
        return self.proxy_urls[self._round_robin_idx % len(self.proxy_urls)]

    def next_proxy(self) -> str:
        """Pick the next proxy URL AND advance the round-robin counter.
        Used by the range-fetcher which doesn't go through `_build_*_command`
        (no yt-dlp subprocess) but still wants to spread load across the
        rotation."""
        proxy = self.proxy_urls[self._round_robin_idx % len(self.proxy_urls)]
        self._round_robin_idx += 1
        return proxy

    async def download_to(self, video_id: str, dest_path: Path) -> None:
        """Wrap LocalYtDlpProvider.download_to with retry-on-bot-block
        across the IP rotation. _build_command advances the round-robin
        counter every call, so each super().download_to() retry naturally
        lands on the next proxy URL.

        Bounded to `_BOT_BLOCK_MAX_ATTEMPTS` (and to the actual pool size
        if smaller) so worst-case latency stays within the frontend's
        60s chunk-fetch budget when a few IPs are transiently flagged.

        Only `_looks_like_bot_block` failures retry — every other
        AudioDownloadError bubbles up immediately so the chunk endpoint
        and circuit breaker can react to genuine problems."""
        n_attempts = min(_BOT_BLOCK_MAX_ATTEMPTS, len(self.proxy_urls))
        last_err: AudioDownloadError | None = None
        for attempt_idx in range(n_attempts):
            try:
                await super().download_to(video_id, dest_path)
                if attempt_idx > 0:
                    print(
                        f"[AUDIO-CACHE] proxy retry succeeded vid={video_id} "
                        f"attempt={attempt_idx + 1}/{n_attempts}",
                        flush=True,
                    )
                return
            except AudioDownloadError as e:
                if not _looks_like_bot_block(str(e)):
                    raise
                last_err = e
                # Bot-block fails at metadata stage so no partial file
                # should exist, but clean up defensively in case yt-dlp
                # ever changes that. Both the bare dest_path and the
                # `.m4a`-suffixed variant are possible per the -o template
                # quirk documented in T34.
                for partial in (dest_path, dest_path.with_name(dest_path.name + ".m4a")):
                    partial.unlink(missing_ok=True)
                if attempt_idx < n_attempts - 1:
                    print(
                        f"[AUDIO-CACHE] proxy bot-block vid={video_id} "
                        f"attempt={attempt_idx + 1}/{n_attempts} — retrying on next IP",
                        flush=True,
                    )
                continue
        # All retries exhausted — raise the specific exception type so the
        # caller in `_download_with_lock` can avoid caching this as a
        # per-video terminal failure (`_recent_download_failures`). The
        # round-robin pointer has advanced past the flagged streak; the
        # NEXT request will start at a different position and may succeed
        # immediately. Treating it as terminal would block legitimate
        # retries for 5 min for no good reason.
        # Last_err is guaranteed set here because the only way to reach this
        # line is via the bot-block branch above (non-bot-block reraises in
        # place; success returns).
        assert last_err is not None
        raise AllProxiesBlockedError(
            f"all {n_attempts} proxy attempts bot-blocked; last yt-dlp stderr: {last_err}"
        )

    async def extract_audio_url(self, video_id: str) -> str:
        """Wrap `LocalYtDlpProvider.extract_audio_url` with retry-on-bot-block
        across the IP rotation. `_build_url_command` advances the round-robin
        counter every call, so each retry naturally lands on the next proxy.

        Same retry budget as `download_to` (`_BOT_BLOCK_MAX_ATTEMPTS`). Raises
        `AllProxiesBlockedError` once exhausted so callers can opt out of
        per-video terminal caching (the next request's rotation pointer is
        already advanced and may succeed immediately)."""
        n_attempts = min(_BOT_BLOCK_MAX_ATTEMPTS, len(self.proxy_urls))
        last_err: AudioDownloadError | None = None
        for attempt_idx in range(n_attempts):
            try:
                url = await super().extract_audio_url(video_id)
                if attempt_idx > 0:
                    print(
                        f"[AUDIO-CACHE] proxy --get-url retry succeeded vid={video_id} "
                        f"attempt={attempt_idx + 1}/{n_attempts}",
                        flush=True,
                    )
                return url
            except AudioDownloadError as e:
                if not _looks_like_bot_block(str(e)):
                    raise
                last_err = e
                if attempt_idx < n_attempts - 1:
                    print(
                        f"[AUDIO-CACHE] proxy --get-url bot-block vid={video_id} "
                        f"attempt={attempt_idx + 1}/{n_attempts} — retrying on next IP",
                        flush=True,
                    )
                continue
        assert last_err is not None
        raise AllProxiesBlockedError(
            f"all {n_attempts} proxy --get-url attempts bot-blocked; last yt-dlp stderr: {last_err}"
        )


# Module-level provider, lazy-initialized so tests can swap it cleanly via
# `audio_cache._provider = MockProvider()` without re-importing.
_provider: AudioSourceProvider | None = None


def _get_provider() -> AudioSourceProvider:
    """Pick provider based on env-var presence. RECAPSHARK_YT_PROXY_URL
    set => ProxiedYtDlpProvider (production: residential proxy). Empty
    => LocalYtDlpProvider (local dev: direct egress, no proxy cost).
    Logged at first call so deploy-time misconfigurations are visible
    in pm2 logs without grepping the .env."""
    global _provider
    if _provider is None:
        if RECAPSHARK_YT_PROXY_URL:
            _provider = ProxiedYtDlpProvider()
            print(
                "[AUDIO-CACHE] using ProxiedYtDlpProvider (residential proxy)",
                flush=True,
            )
        else:
            _provider = LocalYtDlpProvider()
            print(
                "[AUDIO-CACHE] using LocalYtDlpProvider (direct droplet IP)",
                flush=True,
            )
    return _provider


def set_provider(provider: AudioSourceProvider) -> None:
    """Swap the audio source provider. Used by tests (MockProvider) and
    by ops if we ever need to hot-swap providers without a restart."""
    global _provider
    _provider = provider


# --------------------------------------------------------------------------- #
# Circuit breaker
# --------------------------------------------------------------------------- #

def _is_circuit_open() -> bool:
    return time.monotonic() < _circuit_open_until


def is_circuit_open() -> bool:
    """Public read-only circuit state for API handlers. Lets routes return
    the correct user-facing error (`circuit_open`, session-fatal) instead
    of pretending audio is still downloading. Without this, the chunk
    endpoint falls into `audio_not_ready` (retryable forever) while the
    breaker is open and `ensure_started()` silently no-ops — frontend
    spins indefinitely against a download that will never start."""
    return _is_circuit_open()


def get_recent_failure(video_id: str) -> str | None:
    """Public read-only check for a recent terminal download failure for
    `video_id`. Returns the error message string if a failure was recorded
    within RECENT_FAILURE_TTL_SEC, else None. Auto-cleans expired entries
    on access.

    Used by the chunk endpoint to return `audio_unavailable` (chunk-fatal)
    instead of `audio_not_ready` (retryable forever) when a specific video
    has already terminally failed. Distinguishes "download in progress"
    from "download tried, failed, won't auto-retry"."""
    item = _recent_download_failures.get(video_id)
    if not item:
        return None
    ts, msg = item
    if time.monotonic() - ts > RECENT_FAILURE_TTL_SEC:
        _recent_download_failures.pop(video_id, None)
        return None
    return msg


def _record_failure(error_msg: str = "") -> None:
    """Add a failure timestamp; trip the breaker if threshold hit. Pushes
    a Sentry breadcrumb on every failure + a Sentry error on breaker-open
    so cookie expiration / persistent yt-dlp issues surface in the inbox
    without manual log inspection. Sentry calls are no-ops when SENTRY_DSN
    isn't configured."""
    global _circuit_open_until
    now = time.monotonic()
    while _failure_timestamps and _failure_timestamps[0] < now - CIRCUIT_FAIL_WINDOW_SEC:
        _failure_timestamps.popleft()
    _failure_timestamps.append(now)

    # Per-failure Sentry capture (warning level) — gives the inbox a trend
    # signal of degradation BEFORE the breaker opens, so cookie expiration
    # is visible at attempt #1 not attempt #5.
    try:
        import sentry_sdk
        # Detect the bot-block pattern explicitly so the inbox grouping is
        # useful — generic "yt-dlp failed" gets grouped with everything else.
        is_auth_block = "Sign in to confirm" in error_msg or "cookies" in error_msg.lower()
        sentry_sdk.capture_message(
            "audio_cache: yt-dlp download failed"
            + (" (likely auth/cookie expired)" if is_auth_block else ""),
            level="warning",
        )
    except Exception:
        pass  # Sentry not configured or import failed — degrade silently

    if len(_failure_timestamps) >= CIRCUIT_FAIL_THRESHOLD:
        _circuit_open_until = now + CIRCUIT_OPEN_DURATION_SEC
        print(
            f"[AUDIO-CACHE] circuit-open (5 yt-dlp failures in 5 min) — "
            f"skipping audio downloads for {CIRCUIT_OPEN_DURATION_SEC // 60} min",
            flush=True,
        )
        # Breaker-open is actionable: page Sentry at error level so it stands
        # out from per-failure warnings. If you see this in your inbox,
        # rotate cookies (or check residential proxy health if that's wired up).
        try:
            import sentry_sdk
            sentry_sdk.capture_message(
                "audio_cache: yt-dlp circuit breaker OPEN — likely cookies expired or "
                "YouTube bot detection rotated. Karaoke is degraded for the next "
                f"{CIRCUIT_OPEN_DURATION_SEC // 60} min. Refresh cookies / check "
                "audio source provider health.",
                level="error",
            )
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# Public API — called by the chunk handler in asr_provider_routes.py
# --------------------------------------------------------------------------- #

def ensure_started(video_id: str) -> None:
    """Idempotent: kicks off the download task if not already running.
    Returns immediately. The chunk handler calls this on every request —
    cheap when audio is already cached or download is in-flight.

    Skipped (no-op) if the breaker is open — `ensure_audio` would fast-fail
    anyway, no point spawning a task that immediately raises."""
    if _is_circuit_open():
        return
    if video_id in _downloading_tasks and not _downloading_tasks[video_id].done():
        return
    target = AUDIO_DIR / f"{video_id}.m4a"
    if target.exists():
        return
    task = asyncio.create_task(_download_with_lock(video_id))
    _downloading_tasks[video_id] = task
    task.add_done_callback(lambda t: _on_download_done(video_id, t))


def has_ready(video_id: str) -> bool:
    """True if the audio file is fully downloaded and ready to slice.
    The `.partial` check guards against a torn-write race where the rename
    is mid-flight (atomic on POSIX, but defensive belt-and-suspenders)."""
    target = AUDIO_DIR / f"{video_id}.m4a"
    partial = AUDIO_DIR / f"{video_id}.m4a.partial"
    return target.exists() and not partial.exists()


def is_downloading(video_id: str) -> bool:
    task = _downloading_tasks.get(video_id)
    return task is not None and not task.done()


async def ensure_audio(video_id: str) -> Path:
    """Block until audio is downloaded; return the file path. The chunk
    endpoint usually calls `ensure_started` + `has_ready` instead (non-
    blocking). This is here for tests, admin tools, and the rare case where
    blocking-wait is the right semantics."""
    if _is_circuit_open():
        raise AudioDownloadError("yt-dlp circuit-breaker is open")
    return await _download_with_lock(video_id)


async def slice_audio(audio_path: Path, slice_start: float, slice_dur: float) -> Path:
    """Re-encode AAC slice (NOT `-c copy`) for sample-accurate timestamps.
    `-c copy` seeks to the nearest keyframe and can drift up to 1-2s,
    silently breaking karaoke word alignment (D16, T2).

    Caller MUST `unlink()` the returned tempfile when done. We don't clean
    up here because the chunk handler needs to read/upload the file before
    it can be deleted.

    `Path.touch()` on the source first (T21): the LRU evictor uses mtime
    as the freshness signal. Without the touch, a slow eviction sweep can
    delete the source mid-read. The touch + LRU_FRESH_AGE_SEC floor in
    `evict_lru` together protect active files from the race."""
    audio_path.touch()

    # tempfile.mkstemp opens the file; we want ffmpeg to write it, so close
    # the fd immediately and only keep the path.
    out_fd, out_path_str = tempfile.mkstemp(suffix=".m4a")
    os.close(out_fd)
    out_path = Path(out_path_str)

    try:
        proc = await asyncio.create_subprocess_exec(
            FFMPEG_BIN,
            "-hide_banner",
            "-nostdin",
            "-y",
            "-i", str(audio_path),
            "-ss", str(slice_start),
            "-t", str(slice_dur),
            "-vn",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            str(out_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as e:
        out_path.unlink(missing_ok=True)
        raise AudioSliceError(f"ffmpeg binary not found at {FFMPEG_BIN}: {e}")

    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        out_path.unlink(missing_ok=True)
        err_tail = stderr.decode(errors="replace")[-500:] if stderr else ""
        raise AudioSliceError(f"ffmpeg returncode={proc.returncode}: {err_tail}")

    return out_path


async def slice_audio_pcm(audio_path: Path, slice_start: float, slice_dur: float) -> Path:
    """Decode-only slice -> 22kHz mono PCM WAV. ~40x faster than the
    AAC re-encode path because there's no encoder pass — ffmpeg just
    decodes the AAC frames to raw samples and writes them out.

    Sample-accurate by construction (PCM has no keyframes — every sample
    is a cut point), so timestamps match the AAC re-encode path exactly.

    22kHz mono is the safety-margin choice over 16kHz mono (the strict
    speech-recognition standard): retains audio bandwidth up to 11kHz
    which preserves higher-pitched voices and any non-speech vocal
    content, at only ~30% size cost. STT models internally downsample
    to 16kHz anyway, so accuracy parity is expected.

    Caller MUST `unlink()` the returned tempfile."""
    audio_path.touch()

    out_fd, out_path_str = tempfile.mkstemp(suffix=".wav")
    os.close(out_fd)
    out_path = Path(out_path_str)

    _slice_t0 = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            FFMPEG_BIN,
            "-hide_banner",
            "-nostdin",
            "-y",
            "-ss", str(slice_start),
            "-t", str(slice_dur),
            "-i", str(audio_path),
            "-vn",
            "-ac", "1",            # mono
            "-ar", "22050",        # 22kHz
            "-c:a", "pcm_s16le",   # raw 16-bit PCM
            "-f", "wav",
            str(out_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as e:
        out_path.unlink(missing_ok=True)
        raise AudioSliceError(f"ffmpeg binary not found at {FFMPEG_BIN}: {e}")

    _, stderr = await proc.communicate()
    _slice_elapsed = time.monotonic() - _slice_t0
    # Slice-latency probe — partial-download visibility in pm2/uvicorn logs.
    try:
        _src_mb = audio_path.stat().st_size / (1024 * 1024)
    except OSError:
        _src_mb = 0.0
    print(
        f"[FFMPEG-SLICE] src_mb={_src_mb:.1f} slice_start={slice_start:.1f} "
        f"slice_dur={slice_dur:.1f} elapsed_s={_slice_elapsed:.2f} rc={proc.returncode}",
        flush=True,
    )
    if proc.returncode != 0:
        out_path.unlink(missing_ok=True)
        err_tail = stderr.decode(errors="replace")[-500:] if stderr else ""
        raise AudioSliceError(f"ffmpeg(pcm) returncode={proc.returncode}: {err_tail}")

    return out_path


def evict_lru(max_gb: int = AUDIO_CACHE_MAX_GB) -> None:
    """Smart-cap LRU eviction. Cap = `min(max_gb, 70% of free disk)`.
    Files newer than `LRU_FRESH_AGE_SEC` are protected (active files are
    `touch()`ed in `slice_audio`).

    Backend NEVER crashes from disk-full because the smart cap auto-shrinks
    when disk runs low — worst case is `audio_unavailable` returned to the
    chunk handler, which falls back to plain transcript (graceful per §12
    cardinal rule)."""
    if not AUDIO_DIR.exists():
        return
    try:
        free_bytes = shutil.disk_usage(AUDIO_DIR).free
    except OSError:
        return  # disk_usage failed somehow; skip eviction this round

    smart_cap_bytes = min(max_gb * 1024**3, int(free_bytes * 0.70))

    files = sorted(AUDIO_DIR.glob("*.m4a"), key=lambda p: p.stat().st_mtime)
    cutoff_mtime = time.time() - LRU_FRESH_AGE_SEC
    total_bytes = sum(f.stat().st_size for f in files)

    for f in files:
        if total_bytes <= smart_cap_bytes:
            break
        if f.stat().st_mtime > cutoff_mtime:
            continue  # too fresh — never evict active files (LRU race-safety)
        size = f.stat().st_size
        f.unlink(missing_ok=True)
        total_bytes -= size


# --------------------------------------------------------------------------- #
# Internals
# --------------------------------------------------------------------------- #

def _on_download_done(video_id: str, task: asyncio.Task) -> None:
    """Done-callback: pop from registry + log structured failure if any.
    Without explicit `task.result()`, async exceptions become silent
    "Task exception was never retrieved" noise in stderr — hard to debug
    later (T20)."""
    _downloading_tasks.pop(video_id, None)
    if task.cancelled():
        return
    try:
        task.result()
    except AudioDownloadError as e:
        # Already counted in the breaker; just structured log.
        print(f"[AUDIO-CACHE] download failed vid={video_id} err={e}", flush=True)
    except Exception as e:
        print(
            f"[AUDIO-CACHE] download failed vid={video_id} unexpected={type(e).__name__}: {e}",
            flush=True,
        )


async def _download_with_lock(video_id: str) -> Path:
    """Per-video lock + atomic `.partial` -> `.m4a` rename. Multiple
    concurrent callers for the same `video_id` all wait on the same Lock,
    then the second caller sees the existing target inside the lock and
    returns immediately (with `touch()` for LRU freshness)."""
    lock = _audio_locks.setdefault(video_id, asyncio.Lock())
    async with lock:
        target = AUDIO_DIR / f"{video_id}.m4a"
        if target.exists():
            target.touch()  # bump mtime for LRU
            return target

        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        partial = AUDIO_DIR / f"{video_id}.m4a.partial"

        # Stale partial: prior process crashed mid-download, clean up before
        # retry so yt-dlp doesn't hit a name collision.
        if partial.exists() and (time.time() - partial.stat().st_mtime) > STALE_PARTIAL_AGE_SEC:
            partial.unlink(missing_ok=True)

        t0 = time.monotonic()
        try:
            await _get_provider().download_to(video_id, partial)
        except AudioDownloadError as e:
            partial.unlink(missing_ok=True)
            # Pass the error message so _record_failure can detect the
            # auth/bot-block pattern and tag the Sentry capture accordingly
            # — distinguishes "cookies expired" from "network glitch" in
            # the inbox.
            _record_failure(str(e))
            # Per-video failure memory — lets the chunk endpoint return
            # audio_unavailable (chunk-fatal) instead of audio_not_ready
            # (retryable forever) for permanently-broken videos.
            #
            # EXCEPTION: AllProxiesBlockedError is transient + IP-state-
            # dependent, not video-state-dependent. The next request's
            # rotation will start at a different round-robin index and
            # may succeed immediately. Caching as terminal here would
            # block legitimate retries for 5 min for no good reason. The
            # circuit breaker counter above still fires, so a true
            # all-IPs-down event still trips it (5 fails in 5 min) and
            # falls back to plain transcript gracefully.
            if not isinstance(e, AllProxiesBlockedError):
                _recent_download_failures[video_id] = (time.monotonic(), str(e))
            raise

        # Atomic rename — readers see either the old file (or none) or the
        # new file; never a torn write.
        os.replace(partial, target)

        # Clear stale failure memory so a recovered video isn't treated
        # as audio_unavailable on the next chunk request.
        _recent_download_failures.pop(video_id, None)

        elapsed = time.monotonic() - t0
        size_mb = target.stat().st_size / (1024 * 1024)
        # Per Phase 5 telemetry — matches the [YTDLP] log format.
        print(f"[YTDLP] vid={video_id} size_mb={size_mb:.1f} elapsed_s={elapsed:.1f}", flush=True)

        # Eviction is cheap (just stat+sort); run on every successful download.
        evict_lru()
        return target


# --------------------------------------------------------------------------- #
# Partial audio download path (RECAPSHARK_USE_PARTIAL_DOWNLOAD)
#
# Range-fetches just the bytes needed for the requested chunk from YouTube's
# CDN instead of downloading the full audio file upfront. Targets 3x faster
# first-karaoke on long videos (e.g., ~22s end-to-end on a 3h podcast instead
# of ~65s today).
#
# Plan + reasoning + empirical validation:
#   docs/_logs/02_PARTIAL_AUDIO_DOWNLOAD_PLAN.md
#   docs/_logs/03_PARTIAL_AUDIO_DOWNLOAD_DECISIONS.md
# --------------------------------------------------------------------------- #


async def _extract_audio_url_cached(video_id: str) -> str:
    """Extract the direct googlevideo.com audio URL via yt-dlp --get-url.

    **Despite the name, no longer caches** — we used to cache the URL for
    5h to skip the ~5s yt-dlp overhead on chunks 2+, but empirically
    YouTube's CDN throttles subsequent reads on a signed URL to roughly
    playback rate (~30 KB/s) under the assumption that the client is now
    streaming for playback. A backfill or a scrub on the cached URL would
    crawl at 30 KB/s and time out. Re-extracting per fetch costs 5s but
    each fetch then runs at full bandwidth (~5 MB/s), which is the right
    trade. See 2026-05-11 fix in CHANGELOG. Name retained for now to
    avoid churning every call site — will rename in a follow-up.

    Caller is `_ensure_audio_bytes`, which holds `_audio_locks[video_id]`
    while we're in here, so concurrent same-video calls naturally
    serialize. Different videos extract in parallel."""
    t0 = time.monotonic()
    try:
        url = await _get_provider().extract_audio_url(video_id)
    except AudioDownloadError as e:
        # Match the circuit-breaker + per-video-failure semantics of
        # `_download_with_lock`. AllProxiesBlockedError is transient +
        # IP-state-dependent, so it counts toward the breaker but does
        # NOT cache as a per-video terminal failure (the next request's
        # rotation pointer is already advanced and may succeed
        # immediately) — same exception-type test `_download_with_lock`
        # uses.
        _record_failure(str(e))
        # Print the actual yt-dlp stderr tail so the failure is visible
        # in uvicorn logs (otherwise it's swallowed by `_record_failure`
        # which only fires Sentry — disabled in local dev).
        print(
            f"[YTDLP-RANGE] vid={video_id} action=get_url FAILED "
            f"err_type={type(e).__name__} err={str(e)[-400:]}",
            flush=True,
        )
        if not isinstance(e, AllProxiesBlockedError):
            _recent_download_failures[video_id] = (time.monotonic(), str(e))
        raise
    elapsed = time.monotonic() - t0
    # Clear per-video terminal-failure memory on a successful extraction
    # — a recovered video shouldn't keep being reported as audio_unavailable.
    _recent_download_failures.pop(video_id, None)
    print(
        f"[YTDLP-RANGE] vid={video_id} action=get_url elapsed_s={elapsed:.1f}",
        flush=True,
    )
    return url


def _get_proxy_for_range_fetch() -> str | None:
    """Pick a proxy URL for the HTTP range fetch. Returns None when
    `_get_provider()` is LocalYtDlpProvider (local dev / no proxy). Uses
    the same round-robin rotation as yt-dlp subprocess calls so bot-block
    accounting and IP distribution stay coherent across both code paths."""
    provider = _get_provider()
    if isinstance(provider, ProxiedYtDlpProvider):
        return provider.next_proxy()
    return None


async def _ensure_audio_bytes(video_id: str, end_byte: int) -> Path:
    """Ensure the audio file for `video_id` is on disk with AT LEAST
    `end_byte` bytes downloaded. Range-fetches the missing tail and
    appends to the existing file if needed. Returns the path.

    Serialized per video via `_audio_locks[video_id]` so two concurrent
    chunk requests can't double-fetch overlapping ranges. Reuses the same
    lock as the full-download path — the file at `<vid>.m4a` is a shared
    resource regardless of which path wrote it.

    Detects missing-file (W4) and resets `_partial_audio_state` so a
    mid-session LRU evict doesn't leave us with a stale state record
    pointing at a deleted file. The next range fetch re-starts from 0
    in that case."""
    target = AUDIO_DIR / f"{video_id}.m4a"

    lock = _audio_locks.setdefault(video_id, asyncio.Lock())
    async with lock:
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)

        # W4 — file evicted mid-session. Reset state and re-fetch from 0.
        existing_bytes = _partial_audio_state.get(video_id, 0)
        if not target.exists():
            existing_bytes = 0
            _partial_audio_state.pop(video_id, None)

        if existing_bytes >= end_byte:
            # Already have enough bytes for this chunk's range.
            target.touch()  # bump mtime for LRU (T21)
            return target

        # Stream the body in chunks so a slow trickle from googlevideo's CDN
        # surfaces as visible progress in the log AND can be hard-aborted by
        # a TOTAL deadline (httpx's plain `timeout=N` is per-TCP-read, not
        # per-request — empirically observed 2026-05-11 that a 40 MB range
        # fetch can stall mid-body for 90+ seconds without any single read
        # idling long enough to trip the timeout, hanging chunks forever).
        #
        # Per-read timeout 20s + total deadline 60s — a healthy fetch is
        # 1-4s; anything past 60s means the URL is throttled/dead and we
        # should bail so the frontend retry can spin up a fresh signed URL.
        _PER_READ_TIMEOUT_SEC = 20.0
        _TOTAL_DEADLINE_SEC = 60.0
        _STREAM_CHUNK_BYTES = 256 * 1024  # 256 KB

        # On-CDN-reject retry (shipped 2026-05-12). YouTube's CDN occasionally
        # 403s a perfectly valid signed audio URL — the load balancer routes
        # to a node that rejects despite `ipbypass=yes` in the params. We
        # measured ~5% terminal failure rate across recent traffic before
        # this retry; verified by direct fetch test against the exact URL
        # that prod 403'd (different proxy IPs each succeed when retried).
        # One retry with a fresh URL extraction (different signed URL,
        # different proxy IP, different CDN routing) is enough to close
        # the gap — expected residual failure ~0.25% (5% squared, attempts
        # are independent).
        #
        # Loop covers BOTH retry-on-status and retry-on-httpx-error.
        # Successful attempt breaks out with `content` populated. After all
        # attempts exhausted, the appropriate exception bubbles up (terminal
        # `AudioDownloadError` for status-fail, transient
        # `AllProxiesBlockedError` for httpx network errors).
        _BYTE_FETCH_MAX_ATTEMPTS = 2
        content: bytes | None = None
        status_code = 0
        for attempt_idx in range(_BYTE_FETCH_MAX_ATTEMPTS):
            # Fresh URL extraction per attempt — round-robins to the next
            # proxy via the standard rotation, so the retry naturally lands
            # on a different yt-dlp egress IP AND yields a freshly-signed
            # URL with potentially different CDN routing.
            url = await _extract_audio_url_cached(video_id)

            # HTTP byte ranges are inclusive on both ends, so `bytes=A-B` fetches
            # B-A+1 bytes. We want bytes [existing_bytes, end_byte) (Python-style
            # half-open).
            #
            # YouTube CDN throttles standard `Range:` header requests to roughly
            # the audio's playback rate (~16 KB/s for format 140) after the first
            # ~10 MB burst per signed URL — empirically confirmed 2026-05-11
            # against a 3h video where a 20 MB chunk-2 fetch took 60+ s before
            # timing out at ~30 KB/s. The fix yt-dlp uses (and which we mirror
            # here): append `&range=START-END` to the URL itself and DON'T send
            # a `Range:` HTTP header. The CDN reads the range from the URL
            # parameter and serves it as a normal 200 response at full bandwidth.
            # The `range` parameter is not in the signed `sparams` list, so adding
            # it doesn't break the URL signature.
            _url_parts = urllib.parse.urlsplit(url)
            _qs = urllib.parse.parse_qsl(_url_parts.query, keep_blank_values=True)
            _qs = [(k, v) for (k, v) in _qs if k != "range"]
            _qs.append(("range", f"{existing_bytes}-{end_byte - 1}"))
            fetch_url = _url_parts._replace(query=urllib.parse.urlencode(_qs)).geturl()
            proxy = _get_proxy_for_range_fetch()
            t0 = time.monotonic()

            content_chunks: list[bytes] = []
            received_bytes = 0
            try:
                client_kwargs: dict[str, object] = {
                    "timeout": httpx.Timeout(
                        connect=10.0, read=_PER_READ_TIMEOUT_SEC,
                        write=10.0, pool=10.0,
                    ),
                    # YT's CDN load-balancers return 302 Found redirecting from one
                    # `rrN---snX.googlevideo.com` host to another at any time —
                    # empirically observed 2026-05-11 on the partial-download path.
                    # httpx defaults to `follow_redirects=False` (security default),
                    # so without this every redirected fetch raised AudioDownloadError
                    # → audio_unavailable → cached as permanently-failed in
                    # karaoke_chunks → chunk-loader gave up for the session and
                    # karaoke never appeared. Match yt-dlp's own behavior here:
                    # follow the redirect, the new URL is the same signed-URL
                    # contract just on a different node.
                    "follow_redirects": True,
                }
                if proxy:
                    # httpx 0.27+ uses `proxy=`; older versions used `proxies=`.
                    # We pin httpx>=0.27 in requirements, but use the modern form.
                    client_kwargs["proxy"] = proxy

                async with httpx.AsyncClient(**client_kwargs) as client:
                    # NO `Range:` header — the `&range=` URL parameter we appended
                    # above does the same job AND bypasses YouTube CDN's
                    # playback-rate throttling. With both set, the CDN still
                    # honors the URL parameter, so this is OK belt-and-suspenders,
                    # but the cleaner signal to the CDN is URL-param-only.
                    async with client.stream("GET", fetch_url) as resp:
                        status_code = resp.status_code
                        # Validate status BEFORE pulling the body — a 4xx/5xx
                        # might still send a small error body but we don't want
                        # to wait on bytes from a doomed response. Both 200 and
                        # 206 are success here (URL-param-range responds 200,
                        # standard Range-header responds 206).
                        if status_code not in (200, 206):
                            # Best-effort to read the error body for diagnostics.
                            try:
                                err_body = (await resp.aread()).decode(errors="replace")[-300:]
                            except Exception:
                                err_body = "(body read failed)"
                            if attempt_idx < _BYTE_FETCH_MAX_ATTEMPTS - 1:
                                # Retryable: log and fall through to the
                                # post-stream `continue` below. NOT `break`
                                # here — that would exit the for-attempt
                                # retry loop entirely (the nearest enclosing
                                # loop, since async-with isn't a loop).
                                print(
                                    f"[YTDLP-RANGE] vid={video_id} action=fetch "
                                    f"HTTP_{status_code} attempt={attempt_idx + 1}/"
                                    f"{_BYTE_FETCH_MAX_ATTEMPTS} — re-extracting URL "
                                    f"and retrying. body tail: {err_body}",
                                    flush=True,
                                )
                            else:
                                raise AudioDownloadError(
                                    f"range fetch returned HTTP {status_code} "
                                    f"(expected 200/206); body tail: {err_body}"
                                )
                        else:
                            deadline = t0 + _TOTAL_DEADLINE_SEC
                            last_progress_log = t0
                            async for chunk in resp.aiter_bytes(chunk_size=_STREAM_CHUNK_BYTES):
                                if not chunk:
                                    continue
                                content_chunks.append(chunk)
                                received_bytes += len(chunk)
                                now = time.monotonic()
                                # Heartbeat progress log every ~2s so we can SEE a
                                # stall as it happens in the uvicorn log.
                                if now - last_progress_log >= 2.0:
                                    last_progress_log = now
                                    print(
                                        f"[YTDLP-RANGE] vid={video_id} action=streaming "
                                        f"received_mb={received_bytes / (1024 * 1024):.1f} "
                                        f"elapsed_s={now - t0:.1f}",
                                        flush=True,
                                    )
                                if now > deadline:
                                    raise AudioDownloadError(
                                        f"range fetch exceeded total deadline "
                                        f"({_TOTAL_DEADLINE_SEC:.0f}s); received "
                                        f"{received_bytes / (1024 * 1024):.1f} MB of "
                                        f"{(end_byte - existing_bytes) / (1024 * 1024):.1f} MB"
                                    )
            except httpx.HTTPError as e:
                # Range-fetch HTTP failures are transient infrastructure issues
                # (proxy hiccup, googlevideo TCP reset, transient signed-URL
                # rejection). Retry once with a fresh URL — same justification
                # as the status-code retry above. After retries exhausted,
                # raise AllProxiesBlockedError so the classifier maps to
                # `audio_not_ready` (retryable + NOT cached). Without that
                # final-attempt branch the failure would fall through as a
                # plain AudioDownloadError → `audio_unavailable` → cached as
                # permanently-failed in karaoke_chunks, blocking future
                # retries for the same chunk even after the issue clears.
                if attempt_idx < _BYTE_FETCH_MAX_ATTEMPTS - 1:
                    print(
                        f"[YTDLP-RANGE] vid={video_id} action=fetch "
                        f"httpx_error attempt={attempt_idx + 1}/"
                        f"{_BYTE_FETCH_MAX_ATTEMPTS} — re-extracting URL "
                        f"and retrying. err: {type(e).__name__}: {e}",
                        flush=True,
                    )
                    continue
                _record_failure(str(e))
                raise AllProxiesBlockedError(f"range fetch HTTP error: {e}") from e

            # Status was non-2xx but we still have a retry left: loop again.
            if status_code not in (200, 206):
                continue

            # Success: collect content and exit the retry loop.
            content = b"".join(content_chunks)
            break

        assert content is not None, "retry loop must either populate content or raise"
        actual_bytes = len(content)

        if actual_bytes == 0:
            raise AudioDownloadError(
                f"range fetch returned HTTP {status_code} but empty body"
            )

        # Both 200 and 206 are valid success here. With the `&range=` URL
        # parameter approach, the CDN responds 200 with exactly the requested
        # byte range as the body (treating it as a complete "resource" for
        # that range). Either way the body IS the requested range, not the
        # full file — sanity check by size: if `actual_bytes` is suspiciously
        # close to the original file's full content-length (e.g. via the
        # `clen=` parameter), we'd have a bug, but in practice the CDN does
        # honor the range param.
        with open(target, "ab") as f:
            f.write(content)
        new_size = existing_bytes + actual_bytes

        target.touch()  # bump mtime for LRU (T21)
        _partial_audio_state[video_id] = new_size

        elapsed = time.monotonic() - t0
        fetched_mb = actual_bytes / (1024 * 1024)
        cumulative_mb = new_size / (1024 * 1024)
        print(
            f"[YTDLP-RANGE] vid={video_id} action=fetch "
            f"start_byte={existing_bytes} end_byte={new_size} "
            f"fetched_mb={fetched_mb:.1f} elapsed_s={elapsed:.1f} "
            f"cumulative_mb={cumulative_mb:.1f}",
            flush=True,
        )

        # Eviction is cheap; run after a successful append so the partial
        # file participates in LRU like a full-download file would.
        evict_lru()
        return target


async def prepare_chunk_audio_via_range(
    video_id: str, chunk_start: int, chunk_dur: int
) -> Path:
    """Partial-download counterpart to `ensure_audio + slice_audio_pcm`.
    Returns a tempfile path containing the PCM WAV for the chunk's window
    (including OVERLAP_SEC margin on each side, matching `_do_asr_provider_chunk`'s
    slicing math). Caller MUST `unlink()` the returned tempfile.

    Pipeline:
      1. Compute end_byte from chunk timing + format-140 bytes-per-sec rate
         + moov headroom.
      2. `_ensure_audio_bytes` extends the on-disk file if needed.
      3. `slice_audio_pcm` extracts the [chunk_start - OVERLAP, chunk_end +
         OVERLAP] window. Same overlap semantics as the full-download path —
         the caller in `_do_asr_provider_chunk` does the same slice math, so the
         word-timestamps come out identical.

    Raises `AudioDownloadError` on URL-extraction or range-fetch failure.
    `AllProxiesBlockedError` (subclass) on rotation-exhausted bot-blocks —
    caller can pass that through unmodified; the chunk endpoint already
    treats it as transient (no per-video terminal caching)."""
    from karaoke.chunk_store import OVERLAP_SEC  # avoid module-level circular

    slice_start = max(0, chunk_start - OVERLAP_SEC)
    slice_end = chunk_start + chunk_dur + OVERLAP_SEC
    slice_dur = slice_end - slice_start

    # End-byte budget: cover the slice's end + a small safety margin for the
    # moov atom and overlap into the next chunk's range. The bytes-per-sec
    # rate is conservative; the headroom absorbs any drift between videos.
    end_byte = (
        _FORMAT_140_BYTES_PER_SEC * slice_end + _MOOV_HEADROOM_BYTES
    )

    audio_path = await _ensure_audio_bytes(video_id, end_byte)

    # Slice from the on-disk file. Same `slice_audio_pcm` as the full path —
    # the bytes look identical to ffmpeg (moov at start + leading mdat data),
    # so the resulting PCM WAV is the same. Slicing is sample-accurate per T2.
    return await slice_audio_pcm(audio_path, slice_start, slice_dur)


async def _backfill_audio_worker(video_id: str, target_end_byte: int) -> None:
    """Background fetcher that keeps appending to `<vid>.m4a` in 20-MB
    increments until the file covers up to `target_end_byte`. Designed to
    run as a fire-and-forget asyncio.Task so a user scrubbing to a far
    timestamp later finds the bytes already on disk.

    Each increment is a separate `_ensure_audio_bytes` call, so the
    `_audio_locks[video_id]` lock is released between fetches and a user-
    initiated chunk request can interleave (their call acquires the lock
    during the gap, fetches whatever they need, and the backfill picks up
    from the new `existing_max` on its next iteration).

    Best-effort: any exception silently terminates the backfill — the
    user-perceived experience is "scrub to far position is slightly
    slower" not "everything broke". `_record_failure` is NOT called from
    here because backfill failures aren't user-visible and shouldn't
    contribute to the circuit-breaker counter."""
    try:
        while True:
            current = _partial_audio_state.get(video_id, 0)
            if current >= target_end_byte:
                print(
                    f"[YTDLP-RANGE] vid={video_id} action=backfill_done "
                    f"cumulative_mb={current / (1024 * 1024):.1f}",
                    flush=True,
                )
                return
            next_end = min(current + _BACKFILL_INCREMENT_BYTES, target_end_byte)
            try:
                await _ensure_audio_bytes(video_id, next_end)
            except AudioDownloadError as e:
                # URL expired, network error, etc. Don't retry — best-effort.
                print(
                    f"[YTDLP-RANGE] vid={video_id} action=backfill_abort "
                    f"err={str(e)[:200]}",
                    flush=True,
                )
                return
            # Yield to the event loop so user-initiated chunk requests can
            # acquire the lock before the backfill loop grabs it again.
            await asyncio.sleep(0)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        # Catch-all so a bug in the backfill path can't bring down anything.
        print(
            f"[YTDLP-RANGE] vid={video_id} action=backfill_unexpected_error "
            f"err={type(e).__name__}: {str(e)[:200]}",
            flush=True,
        )


def _on_backfill_done(video_id: str, task: asyncio.Task) -> None:
    """Pop the task from the registry + log any unexpected exception. Without
    explicit `task.result()`, async exceptions become silent 'Task exception
    was never retrieved' warnings on stderr — same pattern as T20 /
    `_on_download_done`."""
    _backfill_tasks.pop(video_id, None)
    if task.cancelled():
        return
    try:
        task.result()
    except Exception as e:
        print(
            f"[AUDIO-CACHE] backfill task failed vid={video_id} "
            f"unexpected={type(e).__name__}: {e}",
            flush=True,
        )


def start_background_backfill(video_id: str, video_duration_sec: int) -> None:
    """Fire-and-forget kickoff for the background audio backfill. Idempotent:
    if a backfill task is already in flight for `video_id`, returns without
    spawning a duplicate. If the partial file already covers the full
    estimated byte range, returns without doing anything.

    Caller (chunk_orchestrator) invokes this right after a successful first-
    chunk delivery. By then the heavy paste-time API fan-out (summary,
    chapters, chat) has settled, so the backfill doesn't compete with it.
    `video_duration_sec` is the player-reported duration — used to estimate
    the target byte range (we don't HEAD the URL to get exact `clen`; the
    estimate `bytes_per_sec * duration + 5 MB safety` over-shoots by a
    little, which is the right side to err on).

    **Local dev gate (2026-05-11):** YouTube CDN throttles subsequent
    range fetches to playback rate (~30 KB/s) per (IP, video). In production
    each backfill increment goes out through a different ProxyProvider proxy IP
    via `ProxiedYtDlpProvider`'s round-robin, so every fetch is a "first on
    that IP" and runs at full bandwidth. In local dev there's only the home
    IP, so the backfill crawls AND its throttled-request burst risks
    flagging the IP for bot-block on the next yt-dlp `--get-url`. Skip the
    backfill entirely when no proxy is configured — chunk 0 still works
    great via the single fast first-fetch, and scrubs pay a one-time per-
    scrub fetch cost (still slow on local, will be fast in prod)."""
    if not video_duration_sec or video_duration_sec <= 0:
        return
    from config import backfill_enabled
    if not backfill_enabled():
        print(
            f"[YTDLP-RANGE] vid={video_id} action=backfill_skipped reason=disabled "
            f"(RECAPSHARK_BACKFILL_ENABLED=0)",
            flush=True,
        )
        return
    if not RECAPSHARK_YT_PROXY_URL:
        print(
            f"[YTDLP-RANGE] vid={video_id} action=backfill_skipped reason=no_proxy "
            f"(local dev — YT CDN throttles same-IP repeated reads; backfill needs "
            f"proxy rotation to run at full bandwidth)",
            flush=True,
        )
        return
    if video_id in _backfill_tasks and not _backfill_tasks[video_id].done():
        return
    # Estimated full-file size: bytes_per_sec * duration + 5 MB safety margin.
    # If we under-estimate, the backfill stops short and a scrub past that
    # point pays the remaining-tail fetch latency once. If we over-shoot
    # slightly, the range request just clamps to the file's actual end
    # (googlevideo returns 206 with whatever bytes are available).
    target_end_byte = _FORMAT_140_BYTES_PER_SEC * video_duration_sec + 5 * 1024 * 1024
    current = _partial_audio_state.get(video_id, 0)
    if current >= target_end_byte:
        return
    print(
        f"[YTDLP-RANGE] vid={video_id} action=backfill_start "
        f"current_mb={current / (1024 * 1024):.1f} "
        f"target_mb={target_end_byte / (1024 * 1024):.1f}",
        flush=True,
    )
    task = asyncio.create_task(_backfill_audio_worker(video_id, target_end_byte))
    _backfill_tasks[video_id] = task
    task.add_done_callback(lambda t: _on_backfill_done(video_id, t))
