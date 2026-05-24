"""
pipeline/config.py — single source of truth for env-var reads.

All env-var reads go through this module. Before this refactor, env vars
were read directly via `os.environ.get(...)` scattered across ~17
modules; the pipeline got bitten twice by env-load-order bugs because
module-level constants get cached BEFORE `.env` is loaded when the
import order is wrong, and PM2's `/proc/PID/environ` is frozen at spawn
time so the breakage is invisible to a casual local test.

Design choice: **lazy getters, not eager constants.** Every function
here re-reads `os.environ` on call. Cost: callers do
`config.openai_api_key()` instead of `config.OPENAI_API_KEY` (one extra
pair of parens). Benefit: this module can be imported from any entry
point (server, cron jobs, ad-hoc scripts) without risking a stale
empty-string snapshot.

Adding a new env var:
  1. Add a getter here in the appropriate section.
  2. Update `.env.example` with the var name + a one-liner.
  3. Import the getter where needed — never raw `os.environ.get`.
"""

import os


# ─── OpenAI ─────────────────────────────────────────────────────────────────

def openai_api_key() -> str:
    """Required for summary, chapters, chat, formal-rewrite, and the GPT
    translation fallback for advanced-model languages. Empty = pipeline
    crashes on first OpenAI call (RuntimeError raised in
    `openai_client.get_client()`)."""
    return os.environ.get("OPENAI_API_KEY", "")


# ─── Supabase (owner identity store + auth) ─────────────────────────────────

def supabase_url() -> str:
    """Project base URL. Trailing slash stripped so callers can build
    `f"{supabase_url()}/auth/v1/..."` without worrying about double-slashes.
    Empty = owner-identity routes return 401 / dashboard never authenticates."""
    return os.environ.get("SUPABASE_URL", "").rstrip("/")


def supabase_anon_key() -> str:
    """Public anon key — used to validate owner JWTs against Supabase auth.
    Bundle-extractable; JWT validation is the actual security boundary."""
    return os.environ.get("SUPABASE_ANON_KEY", "")


def supabase_service_role_key() -> str:
    """Server-only service-role key. Bypasses RLS — used by the owner-store
    REST calls (identity + revoked-ID upserts). Never expose to the frontend
    bundle."""
    return os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


# ─── Google Translate (fast path for non-advanced-model languages) ──────────

def google_translate_api_key() -> str:
    """Google Cloud Translation API v2 key. Used for the fast-path
    translation of all languages except the advanced-model set (see
    `GOOGLE_SKIP_LANGS` in `google_translate.py`). Empty = those languages
    fall through to the GPT-4o-mini path, which is slower + more expensive."""
    return os.environ.get("GOOGLE_TRANSLATE_API_KEY", "")


def translate_daily_cap_usd() -> float:
    """Global USD/day cap for Google Translate spend (panic-brake guardrail).
    Read by `translate_protected.py` on every request — lazy on purpose so
    the cap can be raised mid-day without restarting uvicorn. 0 = unlimited
    (only sane for local dev)."""
    return float(os.environ.get("TRANSLATE_DAILY_CAP_USD", "15"))


def translate_per_ip_daily_chars() -> int:
    """Per-IP char/day cap for Google Translate. 0 = no per-IP cap (global
    cap still applies). One bad actor can't burn the whole global budget
    alone with this on."""
    return int(os.environ.get("TRANSLATE_PER_IP_DAILY_CHARS", "333000"))


# ─── YouTube Data API (video metadata + caption track listing) ──────────────

def youtube_api_key() -> str:
    """YouTube Data API v3 key. Used by `/api/video/meta` (title / duration /
    channel) and the caption-track listing path that picks the right
    `defaultAudioLanguage` for transcript fetches. Empty = meta endpoint
    returns 500."""
    return os.environ.get("YOUTUBE_API_KEY", "")


# ─── Subs (subtitle / transcript provider) ──────────────────────────────────

def subs_provider_api_key() -> str:
    """Transcript-provider API key. Powers the fast-first
    `/api/transcript/subs` endpoint (subs in <2s) — the data source that
    lets summary + chapters paint before the audio-transcription fallback
    finishes."""
    return os.environ.get("SUBS_PROVIDER_API_KEY", "")


def subs_provider_url() -> str:
    """YouTube watch URL passed to the subs subprocess via env var
    (subprocess can't take CLI args because of url-encoding edge cases).
    Set per-request by `transcript_routes.py`, not via .env."""
    return os.environ.get("SUBS_PROVIDER_URL", "")


def subs_provider_lang() -> str:
    """Optional caption-track language hint forwarded to the subs provider,
    derived from YouTube's `defaultAudioLanguage` field. Empty = let provider
    pick — which sometimes mis-picks Arabic / French tracks for English
    videos that have multiple tracks."""
    return os.environ.get("SUBS_PROVIDER_LANG", "").strip()


# ─── ASR (audio-transcription fallback when subs are missing) ───────────────

def asr_provider_api_key() -> str:
    """Transcription-provider API key for the karaoke fallback path. Used
    only when subs come back empty."""
    return os.environ.get("ASR_PROVIDER_API_KEY", "")


def asr_provider_daily_cap() -> float:
    """USD cap for the daily transcription spend. Read on every karaoke
    request — lazy on purpose so the cap can be raised mid-day without
    restarting uvicorn. 0 = unlimited (only sane for local dev)."""
    return float(os.environ.get("ASR_PROVIDER_DAILY_CAP", "0"))


# ─── Admin (privileged owner endpoints, e.g. cap-bypass) ────────────────────

def admin_key() -> str:
    """Single shared secret for `/api/admin/*` endpoints. Compared via
    `secrets.compare_digest` to defeat timing attacks. Empty = admin
    endpoints fail-closed with HTTP 503 ('Admin endpoints disabled')."""
    return os.environ.get("ADMIN_KEY", "")


# ─── Sentry (backend error capture) ─────────────────────────────────────────

def sentry_dsn_backend() -> str:
    """DSN for the backend Sentry project. Read once at server.py startup
    to gate `sentry_sdk.init`. Empty = SDK never initializes (no network
    calls, no overhead). Frontend has its own DSN."""
    return os.environ.get("SENTRY_DSN_BACKEND", "")


# ─── API auth (simple shared-secret middleware) ─────────────────────────────

def recapshark_api_token() -> str:
    """Shared-secret token required in the `X-API-Token` header for all
    `/api/*` requests except `/api/health`. Used to block casual abuse
    (curl/scripts without the token). Empty = middleware lets everything
    through (only fine for local dev)."""
    return os.environ.get("RECAPSHARK_API_TOKEN", "")


# ─── BigQuery (analytics ETL key file path) ─────────────────────────────────

def recapshark_bq_key_path(default: str = "") -> str:
    """Filesystem path to the BigQuery service-account JSON key. Used by
    `analytics/bq_client.py` and the `etl_sessions.py` cron. Caller passes
    the project-relative default (different per module) — this getter only
    handles the env-override layer."""
    return os.environ.get("RECAPSHARK_BQ_KEY_PATH", default)


# ─── NER feature flags (Named-Entity Recognition for chapter titles) ────────

def enable_ner() -> bool:
    """Truthy = enable the lightweight regex+spaCy NER pass for chapter
    titles. Off in prod (off-budget)."""
    return os.environ.get("ENABLE_NER", "").lower() in ("1", "true", "yes", "on")


def enable_llm_ner() -> bool:
    """Truthy = enable the heavier LLM NER fallback. Off in prod (off-budget;
    used only for ad-hoc quality experiments)."""
    return os.environ.get("ENABLE_LLM_NER", "").lower() in ("1", "true", "yes", "on")


# ─── Karaoke / yt-dlp toolchain ─────────────────────────────────────────────

def ytdlp_bin() -> str:
    """yt-dlp binary path. Defaults to bare `yt-dlp` (PATH lookup); production
    overrides via env when yt-dlp lives in a venv only."""
    return os.environ.get("YTDLP_BIN", "yt-dlp")


def ffmpeg_bin() -> str:
    """ffmpeg binary path. Defaults to bare `ffmpeg` (PATH lookup); usually
    fine because ffmpeg is system-installed in production."""
    return os.environ.get("FFMPEG_BIN", "ffmpeg")


def ytdlp_js_runtime() -> str:
    """JavaScript runtime path (deno) for yt-dlp YouTube extraction. Modern
    yt-dlp deprecated extracting without a JS runtime — without it, the
    extractor falls back to a deprecated path that hits YouTube bot
    detection more aggressively."""
    return os.environ.get("YTDLP_JS_RUNTIME", "")


def recapshark_yt_cookies_file() -> str:
    """Path to a Netscape-format cookies.txt from a logged-in YouTube
    session. Required in production from datacenter IPs — anonymous yt-dlp
    from cloud IPs gets bot-blocked. Use a THROWAWAY YouTube account; the
    account is at risk of being flagged. Cookies typically expire every
    1-3 months."""
    return os.environ.get("RECAPSHARK_YT_COOKIES_FILE", "")


def ytdlp_remote_components() -> str:
    """yt-dlp 'remote components' spec (EJS challenge solver scripts).
    Modern YouTube extraction requires per-player JS solver scripts that
    live outside the yt-dlp distribution. `ejs:github` tells yt-dlp to
    fetch them from the official yt-dlp/ejs github releases (cached
    locally after first download). Empty string disables."""
    return os.environ.get("YTDLP_REMOTE_COMPONENTS", "ejs:github")


def recapshark_yt_proxy_url() -> str:
    """Residential proxy URL(s) for routing yt-dlp through non-datacenter
    IPs. Single URL or comma-separated list. Each entry:
    `scheme://user:pass@host:port`. Supported schemes: http, https, socks5.
    Empty = no proxy."""
    return os.environ.get("RECAPSHARK_YT_PROXY_URL", "").strip()


def audio_cache_dir() -> str:
    """Directory where yt-dlp caches downloaded audio. Caller wraps in
    `pathlib.Path`."""
    return os.environ.get("RECAPSHARK_AUDIO_CACHE_DIR", "/var/recapshark/audio")


def audio_cache_max_gb() -> int:
    """Smart cap for LRU eviction. Actual cap is min(value, 70% of free
    disk). 10 GB default holds ~44 four-hour podcasts (m4a@128k ~= 230 MB
    each)."""
    return int(os.environ.get("RECAPSHARK_AUDIO_CACHE_MAX_GB", "10"))


def use_partial_download() -> bool:
    """Truthy = use the partial-audio-download path for karaoke chunks
    (range-fetch only the bytes needed for the requested chunk instead of
    downloading the full audio file upfront). Default ON."""
    val = os.environ.get("RECAPSHARK_USE_PARTIAL_DOWNLOAD", "1").strip().lower()
    return val in ("1", "true", "yes", "on")


def backfill_enabled() -> bool:
    """Truthy = fire the background audio backfill after the first karaoke
    chunk delivers. Default ON. Set to `0` and `pm2 restart` to disable
    the backfill while keeping the partial-download path enabled."""
    val = os.environ.get("RECAPSHARK_BACKFILL_ENABLED", "1").strip().lower()
    return val in ("1", "true", "yes", "on")


def karaoke_slice_mode() -> str:
    """How the chunk orchestrator slices audio before uploading to the ASR
    provider. Two paths:

      `pcm` (default): decode-only → 22kHz mono WAV. Much faster slice than
                       AAC re-encode. Sample-accurate by construction (PCM
                       has no keyframes). Larger upload per chunk but
                       providers accept WAV without quality loss for speech.

      `aac`: re-encode to AAC m4a at 128k. Original production path; kept
             as a fallback so we can flip back via env var if a regression
             surfaces (PCM compatibility on a specific audio shape, etc.).

    Set `RECAPSHARK_KARAOKE_SLICE_MODE=aac` in .env + `pm2 restart` to
    revert. Cache rows are key-compatible across modes (the timestamps are
    identical), so flipping back doesn't invalidate anything."""
    val = os.environ.get("RECAPSHARK_KARAOKE_SLICE_MODE", "pcm").strip().lower()
    return "aac" if val == "aac" else "pcm"
