"""Application configuration — typed, env-driven, single source of truth.

Reads the project-root `.env` file (one level above `backend/`). All runtime
configuration flows through `Settings`; no module reaches directly for
`os.environ`. This is the boundary where untyped strings become typed values.
"""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Project root = parent of the `backend/` directory.
_REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    """Typed application settings.

    Loaded once at startup and injected via FastAPI's dependency system.
    """

    model_config = SettingsConfigDict(
        env_file=_REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- App identity ---------------------------------------------------
    app_name: str = "captureshark"
    app_version: str = "0.1.0"
    environment: str = Field(
        default="development",
        description="development | staging | production",
    )

    # --- HTTP -----------------------------------------------------------
    api_prefix: str = "/api/v1"

    # CORS: in dev, the Vite dev server proxies /api/* to us, so same-origin
    # in the browser. We still allow the dev-server origin for direct calls.
    cors_allow_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5174", "http://127.0.0.1:5174"]
    )

    # --- External services (filled in as features land) -----------------
    openai_api_key: str | None = None
    google_client_id: str | None = None
    google_client_secret: str | None = None
    # AssemblyAI Universal-3 Pro Streaming — server-side only. Used to
    # mint short-lived temp tokens the browser holds for the live-caption
    # WebSocket. The raw key NEVER reaches the browser.
    assemblyai_api_key: str | None = None

    # --- Vision provider (photo capture) --------------------------------
    # Which adapter `get_vision_extractor()` builds. Default `"openai"`
    # preserves the pre-Doc AI production behaviour; flipping to `"docai"`
    # requires Doc AI config below + explicit operator sign-off
    # (model-swap = Rule #0). Override via `VISION_PROVIDER=docai` in
    # `.env`. Any other value falls back to OpenAI.
    vision_provider: str = "openai"

    # Doc AI Form Parser config. Both must be set when `vision_provider`
    # is `"docai"`; otherwise the factory returns `None` and the photo
    # route refuses cleanly. The processor name is the full resource
    # path (`projects/.../locations/<region>/processors/<id>`) — the
    # adapter parses the region out of it to pin the client endpoint.
    google_docai_processor_name: str | None = None
    google_docai_sa_path: str | None = None

    # --- Auth / session (step 4 — OAuth + Picker) -----------------------
    # Symmetric secret used to sign the HttpOnly session cookie. Generate
    # with: `python -c "import secrets; print(secrets.token_urlsafe(64))"`.
    # The auth service refuses to boot without it.
    session_secret_key: str | None = None

    # Fernet key (urlsafe-base64, 32 raw bytes) used to encrypt Google
    # refresh tokens at rest in the SQLite store. Generate with:
    # `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
    token_encryption_key: str | None = None

    # SQLAlchemy URL for the auth / session / token store. Default is a
    # local SQLite file under `backend/data/` (created on first run).
    # Override with a managed Postgres URL in production.
    database_url: str = "sqlite+aiosqlite:///backend/data/captureshark.db"

    # Name of the HttpOnly session cookie. Constant in code; exposed here
    # so tests can override without monkey-patching production code.
    session_cookie_name: str = "captureshark_session"

    # Optional explicit base URL for the OAuth redirect (e.g.
    # `https://captureshark.com`). When unset, the server derives it from
    # the incoming request — fine for `localhost` and tunnel-fronted
    # dev, but pin it in prod so a spoofed `Host` header can't redirect
    # Google to an attacker-controlled URL.
    oauth_redirect_base_url: str | None = None

    # --- Feature flags --------------------------------------------------
    # Live captions during voice capture (AssemblyAI streaming). OFF by
    # default as of 2026-05-15 (PM) — we are on AssemblyAI's free tier,
    # which per their ToS makes audio/transcripts eligible for use in
    # their model improvement program. Free-tier accounts cannot opt
    # out; the opt-out path requires paid (pay-as-you-go) and an email
    # to data-opt-out@assemblyai.com. Flip back to `true` only after
    # the account is upgraded AND opt-out confirmation is on file.
    # When `false`, voice capture uses the MediaRecorder → Whisper
    # batch path end-to-end.
    live_captions_enabled: bool = False

    # --- Cost cap on capture endpoints ----------------------------------
    # Per-IP token bucket on /captures and /captures/stream. Defaults are
    # generous for a real broker doing rapid-fire field capture and
    # lethal for a bot loop. Override via env vars when you have signal
    # that real users are bumping into them.
    rate_limit_per_minute: int = 10
    rate_limit_per_hour: int = 60

    # Daily $-spend kill-switch. When the cumulative estimated USD spend
    # for the UTC day exceeds this cap, /captures and /captures/stream
    # refuse new requests until 00:00 UTC. `None` = off (unsafe in
    # production; main.py logs a startup warning if env=production and
    # this isn't set).
    daily_openai_spend_cap_usd: float | None = None

    # --- Sheets dev path (step 3) ---------------------------------------
    # Service-account-backed write path used until OAuth lands in step 4.
    # The user creates a service account in Google Cloud, downloads the
    # JSON key, points `google_service_account_path` at it, and shares the
    # dev test sheet with the service account's email as Editor.
    google_service_account_path: str | None = None
    dev_test_sheet_id: str | None = None
    dev_test_sheet_tab: str = "Sheet1"
    # Optional manual override; if `None`, the adapter fetches the real
    # sheet title from Google so the confirmation card reads naturally.
    dev_test_sheet_name: str | None = None

    @property
    def resolved_service_account_path(self) -> str | None:
        """Return the service-account JSON path resolved against repo root.

        Authors of `.env` can write either an absolute path or a path
        relative to the repo root (e.g. `secrets/captureshark-dev-sa.json`).
        Resolving here means `os.getcwd()` is irrelevant — uvicorn started
        from any directory still finds the file.
        """
        if not self.google_service_account_path:
            return None
        path = Path(self.google_service_account_path)
        if path.is_absolute():
            return str(path)
        return str((_REPO_ROOT / path).resolve())

    @property
    def resolved_google_docai_sa_path(self) -> str | None:
        """Doc AI's service-account JSON path, resolved against repo root.

        Kept separate from `resolved_service_account_path` because the
        Sheets adapter and the Doc AI adapter authenticate to different
        services and shouldn't share credentials.
        """
        if not self.google_docai_sa_path:
            return None
        path = Path(self.google_docai_sa_path)
        if path.is_absolute():
            return str(path)
        return str((_REPO_ROOT / path).resolve())

    @property
    def google_app_id(self) -> str | None:
        """The Google Cloud project number, derived from the OAuth client_id.

        The Picker SDK needs the project number (a numeric id) for
        `setAppId(...)`. Google client_ids are formatted
        `<project_number>-<random>.apps.googleusercontent.com`, so we
        can derive without another env var. Returns `None` if the
        client_id is missing or malformed.
        """
        if not self.google_client_id:
            return None
        head = self.google_client_id.split("-", 1)[0]
        return head if head.isdigit() else None

    @property
    def resolved_database_url(self) -> str:
        """Return the database URL with any relative SQLite path resolved.

        SQLite URLs of the shape `sqlite+aiosqlite:///relative/path.db`
        get rewritten to point at `<repo_root>/relative/path.db`, so the
        DB lives in a stable location regardless of `os.getcwd()`. Other
        URLs (Postgres, MySQL, absolute SQLite) pass through untouched.
        """
        url = self.database_url
        prefix = "sqlite+aiosqlite:///"
        if not url.startswith(prefix):
            return url
        path_part = url[len(prefix):]
        if Path(path_part).is_absolute():
            return url
        resolved = (_REPO_ROOT / path_part).resolve()
        # SQLAlchemy on Windows accepts forward slashes in the URL even
        # though Path produces backslashes; normalise to forward slashes.
        return f"{prefix}{resolved.as_posix()}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Singleton-style settings accessor for use as a FastAPI dependency."""
    return Settings()
