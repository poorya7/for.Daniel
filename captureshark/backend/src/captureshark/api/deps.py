"""Dependency-injection factories for FastAPI routes.

Centralised here so routes can declare their dependencies declaratively
(`Depends(get_extraction_service)`) without knowing how the service is wired
together. This is the seam where adapters get injected into services.

The OpenAI client and the Google Sheets resource are constructed once per
process (`lru_cache`) — building them allocates connection pools and reads
key files, so doing that per request would be wasteful.
"""

from collections.abc import Callable
from datetime import UTC, datetime
from functools import lru_cache
from typing import Annotated

import httpx
from cryptography.fernet import Fernet
from fastapi import Depends, HTTPException, Request, status
from googleapiclient.discovery import Resource
from openai import OpenAI
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from captureshark.adapters.assemblyai_token_provider import AssemblyAITokenProvider
from captureshark.adapters.google_docai_vision_extractor import (
    GoogleDocAiVisionExtractor,
    build_documentai_client,
)
from captureshark.adapters.google_oauth_provider import GoogleOAuthProvider
from captureshark.adapters.google_sheets_repo import (
    GoogleSheetsRepo,
    build_sheets_resource,
    fetch_sheet_display_name,
)
from captureshark.adapters.image_preprocessor import (
    PreprocessOutcome,
)
from captureshark.adapters.image_preprocessor import (
    normalize as image_normalize,
)
from captureshark.adapters.openai_chat_extractor import OpenAIChatExtractor
from captureshark.adapters.openai_vision_extractor import OpenAIVisionExtractor
from captureshark.adapters.openai_whisper_transcriber import OpenAIWhisperTranscriber
from captureshark.adapters.sqlite_idempotency_store import SqliteIdempotencyStore
from captureshark.adapters.sqlite_session_store import SqliteSessionStore
from captureshark.adapters.sqlite_sheet_connection_repo import SqliteSheetConnectionRepo
from captureshark.adapters.sqlite_token_store import SqliteTokenStore
from captureshark.adapters.sqlite_user_repo import SqliteUserRepo
from captureshark.adapters.user_oauth_sheets_header_reader import (
    UserOAuthSheetsHeaderReader,
)
from captureshark.adapters.user_oauth_sheets_writer import UserOAuthSheetsWriter
from captureshark.api.security import CookieSigner
from captureshark.config import Settings, get_settings
from captureshark.db.engine import create_engine_from_settings, create_session_factory
from captureshark.domain.auth import (
    OAuthProviderPort,
    SessionStorePort,
    SignedInUser,
    TokenStorePort,
    UserRepoPort,
)
from captureshark.domain.extraction import ExtractorPort
from captureshark.domain.idempotency import IdempotencyStorePort
from captureshark.domain.live_captions import LiveCaptionTokenPort
from captureshark.domain.sheets import (
    SheetConnectionRepoPort,
    SheetHeaderReaderPort,
    SheetsRepoPort,
    SheetTarget,
    UserSheetsWriterPort,
)
from captureshark.domain.transcription import TranscriberPort
from captureshark.domain.vision import VisionExtractorPort
from captureshark.services.auth_service import AuthService
from captureshark.services.extraction_service import ExtractionService
from captureshark.services.live_captions_service import LiveCaptionsService
from captureshark.services.sheets_service import SheetsService
from captureshark.services.user_mapping_service import UserMappingService
from captureshark.services.user_sheets_service import UserSheetsService

# --- Extraction (text capture, step 2) -----------------------------------


@lru_cache(maxsize=1)
def _build_openai_client(api_key: str) -> OpenAI:
    """One client per (api_key) — practically one per process.

    The cache key is the api key so test-time settings overrides yield a
    fresh client. In production it's set once and never changes.
    """
    return OpenAI(api_key=api_key)


def get_text_extractor(
    settings: Annotated[Settings, Depends(get_settings)],
) -> ExtractorPort:
    """Provide the production text extractor.

    Raises 503 (service-unavailable) if `OPENAI_API_KEY` is missing — that's
    a config problem, not a request problem, so we surface it as
    infra-down rather than 500 (server bug).
    """
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OpenAI is not configured on the server.",
        )
    client = _build_openai_client(settings.openai_api_key)
    return OpenAIChatExtractor(client=client)


def get_voice_transcriber(
    settings: Annotated[Settings, Depends(get_settings)],
) -> TranscriberPort | None:
    """Provide the production Whisper-backed transcriber, or None when
    OpenAI isn't configured.

    Returns None (rather than 503-ing) so the surrounding extraction
    service can be built without a voice adapter — the voice route
    then refuses cleanly via `service.supports_voice` before opening
    its SSE response. Refusing at the route layer beats 503-ing inside
    the Depends chain because the failure mode is uniform across
    capture modes (each route checks its own capability).

    Tests can override this dep to swap in a stub transcriber; that
    pattern is unchanged.
    """
    if not settings.openai_api_key:
        return None
    client = _build_openai_client(settings.openai_api_key)
    return OpenAIWhisperTranscriber(client=client)


def get_image_preprocessor() -> Callable[[bytes, str], PreprocessOutcome]:
    """Provide the production image preprocessor.

    Defaults to the `image_preprocessor.normalize` function. Tests
    override this dep to inject a passthrough stub when they want
    to exercise the service-layer routing logic without running
    real Pillow/HEIC decode on every call.
    """
    return image_normalize


@lru_cache(maxsize=1)
def _build_documentai_client_cached(
    service_account_path: str,
    processor_name: str,
) -> object:
    """One Doc AI client per process — building it reads the SA key
    and constructs a gRPC channel, so don't redo per request.

    Return type is `object` because the concrete
    `DocumentProcessorServiceClient` type isn't a stable public
    surface to type-annotate against here; the caller knows what it
    asked for.
    """
    return build_documentai_client(
        service_account_path=service_account_path,
        processor_name=processor_name,
    )


def get_vision_extractor(
    settings: Annotated[Settings, Depends(get_settings)],
) -> VisionExtractorPort | None:
    """Provide the production vision extractor, or None when not configured.

    Returns None (rather than 503-ing) so the surrounding extraction
    service can be built without a vision adapter — the photo route
    then refuses cleanly via `service.supports_photo` before opening
    its SSE response. Mirrors the voice transcriber pattern.

    Provider selection is driven by `settings.vision_provider`:
      * `"docai"` — Google Document AI Form Parser (the v1-locked
        production provider per `docs/_spec/photo_capture.md`).
        Requires `google_docai_processor_name` + `google_docai_sa_path`.
      * anything else (default `"openai"`) — the OpenAI vision adapter.
        Kept wired so a one-line env flip (`VISION_PROVIDER=openai`)
        rolls back the photo path if Doc AI misbehaves in production.

    Swapping the default value of `vision_provider` is a Rule #0
    model swap — the operator flips the env var explicitly.
    """
    if settings.vision_provider == "docai":
        processor_name = settings.google_docai_processor_name
        sa_path = settings.resolved_google_docai_sa_path
        if not processor_name or not sa_path:
            return None
        client = _build_documentai_client_cached(sa_path, processor_name)
        return GoogleDocAiVisionExtractor(
            client=client,  # type: ignore[arg-type]
            processor_name=processor_name,
        )

    # Default path: OpenAI vision (legacy production provider, kept
    # as the v1 rollback target).
    if not settings.openai_api_key:
        return None
    client = _build_openai_client(settings.openai_api_key)
    return OpenAIVisionExtractor(client=client)


def get_extraction_service(
    extractor: Annotated[ExtractorPort, Depends(get_text_extractor)],
    transcriber: Annotated[TranscriberPort | None, Depends(get_voice_transcriber)],
    vision_extractor: Annotated[
        VisionExtractorPort | None, Depends(get_vision_extractor)
    ],
    image_preprocessor: Annotated[
        Callable[[bytes, str], PreprocessOutcome], Depends(get_image_preprocessor)
    ],
) -> ExtractionService:
    return ExtractionService(
        extractor=extractor,
        transcriber=transcriber,
        vision_extractor=vision_extractor,
        image_preprocessor=image_preprocessor,
    )


# --- Sheets (write to dev test sheet, step 3) ----------------------------


@lru_cache(maxsize=1)
def _build_sheets_resource_cached(service_account_path: str) -> Resource:
    """One Sheets resource per process — building it reads the key file
    and constructs a connection pool, so don't redo per request."""
    return build_sheets_resource(service_account_path)


@lru_cache(maxsize=1)
def _resolve_sheet_target(
    spreadsheet_id: str,
    worksheet_title: str,
    override_name: str | None,
    service_account_path: str,
) -> SheetTarget:
    """Build the dev `SheetTarget`, fetching the live sheet title if no
    override is supplied. Cached because we only need to do this once per
    process; restart picks up sheet renames."""
    if override_name:
        return SheetTarget(
            spreadsheet_id=spreadsheet_id,
            worksheet_title=worksheet_title,
            display_name=override_name,
        )
    resource = _build_sheets_resource_cached(service_account_path)
    fetched = fetch_sheet_display_name(resource, spreadsheet_id)
    return SheetTarget(
        spreadsheet_id=spreadsheet_id,
        worksheet_title=worksheet_title,
        display_name=fetched or "your sheet",
    )


def get_sheets_repo(
    settings: Annotated[Settings, Depends(get_settings)],
) -> SheetsRepoPort:
    """Provide the production sheets repo.

    Raises 503 if either the service-account key path or the dev sheet ID
    is missing — both are config, not request, problems.
    """
    if not settings.resolved_service_account_path:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google service account is not configured on the server.",
        )
    resource = _build_sheets_resource_cached(settings.resolved_service_account_path)
    return GoogleSheetsRepo(sheets_resource=resource)


def get_sheet_target(
    settings: Annotated[Settings, Depends(get_settings)],
) -> SheetTarget:
    if not settings.dev_test_sheet_id or not settings.resolved_service_account_path:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Dev test sheet is not configured on the server.",
        )
    return _resolve_sheet_target(
        settings.dev_test_sheet_id,
        settings.dev_test_sheet_tab,
        settings.dev_test_sheet_name,
        settings.resolved_service_account_path,
    )


def _now() -> datetime:
    """Wall clock used by `SheetsService`. Local timezone keeps the
    confirmation copy ("May 7, 2:30 PM") in the user's reading frame."""
    return datetime.now(tz=UTC).astimezone()


def get_sheets_service(
    repo: Annotated[SheetsRepoPort, Depends(get_sheets_repo)],
    target: Annotated[SheetTarget, Depends(get_sheet_target)],
) -> SheetsService:
    return SheetsService(repo=repo, target=target, clock=_now)


def get_optional_sheets_service(
    settings: Annotated[Settings, Depends(get_settings)],
) -> SheetsService | None:
    """Build the dev (service-account) sheets service if configured, else `None`.

    `get_sheets_service` raises 503 when the dev path isn't set up. That's
    fine for routes whose ONLY save path is the dev one, but step 4
    routes have both the user-OAuth path AND the dev fallback — declaring
    a hard dep on the dev service would 503 every signed-in request the
    moment the dev path was de-configured (e.g. in production). This
    optional flavour lets the route gracefully fall back without forcing
    the operator to keep the dev path wired.
    """
    sa_path = settings.resolved_service_account_path
    if not sa_path or not settings.dev_test_sheet_id:
        return None
    repo = GoogleSheetsRepo(sheets_resource=_build_sheets_resource_cached(sa_path))
    target = _resolve_sheet_target(
        settings.dev_test_sheet_id,
        settings.dev_test_sheet_tab,
        settings.dev_test_sheet_name,
        sa_path,
    )
    return SheetsService(repo=repo, target=target, clock=_now)


# --- Auth (OAuth + sessions, step 4) -------------------------------------


@lru_cache(maxsize=1)
def _build_engine_cached(database_url: str) -> AsyncEngine:
    """One async engine per process (per database URL).

    Tests override `database_url` to spin up an isolated in-memory DB;
    that override yields a different cache key and therefore a fresh
    engine, so the cache doesn't leak fixtures across tests.
    """
    # The engine is built from a synthetic Settings so the SQLite
    # parent-directory `mkdir` path runs even when the URL is overridden
    # without going through `get_settings()`.
    return create_engine_from_settings(Settings(database_url=database_url))


@lru_cache(maxsize=1)
def _build_session_factory_cached(
    database_url: str,
) -> async_sessionmaker[AsyncSession]:
    return create_session_factory(_build_engine_cached(database_url))


@lru_cache(maxsize=1)
def _build_fernet_cached(token_encryption_key: str) -> Fernet:
    """Fernet is cheap to construct but caching avoids accidental key
    string handling in hot paths."""
    return Fernet(token_encryption_key.encode("utf-8"))


@lru_cache(maxsize=1)
def _build_cookie_signer_cached(session_secret_key: str) -> CookieSigner:
    return CookieSigner(session_secret_key)


@lru_cache(maxsize=1)
def _build_oauth_http_client_cached() -> httpx.AsyncClient:
    """Shared `httpx.AsyncClient` for the Google OAuth adapter.

    Re-using the connection pool across calls is meaningfully faster
    than building a fresh client each request. Disposed at app shutdown
    by the lifespan handler in `main.py`.
    """
    return httpx.AsyncClient(timeout=15.0)


def get_cookie_signer(
    settings: Annotated[Settings, Depends(get_settings)],
) -> CookieSigner:
    if not settings.session_secret_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session signing key is not configured on the server.",
        )
    return _build_cookie_signer_cached(settings.session_secret_key)


def get_oauth_provider(
    settings: Annotated[Settings, Depends(get_settings)],
) -> OAuthProviderPort:
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google OAuth client is not configured on the server.",
        )
    return GoogleOAuthProvider(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        http_client=_build_oauth_http_client_cached(),
    )


def get_user_repo(
    settings: Annotated[Settings, Depends(get_settings)],
) -> UserRepoPort:
    return SqliteUserRepo(_build_session_factory_cached(settings.resolved_database_url))


def get_token_store(
    settings: Annotated[Settings, Depends(get_settings)],
) -> TokenStorePort:
    if not settings.token_encryption_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Token encryption key is not configured on the server.",
        )
    return SqliteTokenStore(
        session_factory=_build_session_factory_cached(settings.resolved_database_url),
        fernet=_build_fernet_cached(settings.token_encryption_key),
    )


def get_session_store(
    settings: Annotated[Settings, Depends(get_settings)],
) -> SessionStorePort:
    return SqliteSessionStore(
        _build_session_factory_cached(settings.resolved_database_url)
    )


def get_sheet_connection_repo(
    settings: Annotated[Settings, Depends(get_settings)],
) -> SheetConnectionRepoPort:
    return SqliteSheetConnectionRepo(
        _build_session_factory_cached(settings.resolved_database_url)
    )


def get_idempotency_store(
    settings: Annotated[Settings, Depends(get_settings)],
) -> IdempotencyStorePort:
    """Provide the SQLite-backed idempotency-key store.

    Shares the same async session factory as the other persistent
    adapters; no separate connection pool. The route layer reads the
    `X-Idempotency-Key` header and uses this store to short-circuit
    replays — see `routes/sheets.py` for the integration.
    """
    return SqliteIdempotencyStore(
        _build_session_factory_cached(settings.resolved_database_url)
    )


def get_auth_service(
    oauth: Annotated[OAuthProviderPort, Depends(get_oauth_provider)],
    users: Annotated[UserRepoPort, Depends(get_user_repo)],
    tokens: Annotated[TokenStorePort, Depends(get_token_store)],
    sessions: Annotated[SessionStorePort, Depends(get_session_store)],
) -> AuthService:
    return AuthService(
        oauth_provider=oauth,
        user_repo=users,
        token_store=tokens,
        session_store=sessions,
    )


def get_user_oauth_writer() -> UserSheetsWriterPort:
    """Shared `httpx.AsyncClient`-backed writer.

    Reuses the same client the OAuth provider holds — Google's OAuth
    and Sheets endpoints are different hosts, but `httpx` keeps a
    per-host pool internally, so sharing one client across both
    surfaces is the right balance of simplicity and connection reuse.
    """
    return UserOAuthSheetsWriter(http_client=_build_oauth_http_client_cached())


def get_user_oauth_header_reader() -> SheetHeaderReaderPort:
    """Sibling of `get_user_oauth_writer` — same shared http client.

    Reads use `GET /spreadsheets/{id}/values/{range}`; writes use
    `POST .../values/{range}:append`. Same host, same auth, so they
    share the connection pool with no fuss.
    """
    return UserOAuthSheetsHeaderReader(
        http_client=_build_oauth_http_client_cached(),
    )


def get_user_sheets_service(
    connections: Annotated[SheetConnectionRepoPort, Depends(get_sheet_connection_repo)],
    tokens: Annotated[TokenStorePort, Depends(get_token_store)],
    oauth: Annotated[OAuthProviderPort, Depends(get_oauth_provider)],
    reader: Annotated[SheetHeaderReaderPort, Depends(get_user_oauth_header_reader)],
    writer: Annotated[UserSheetsWriterPort, Depends(get_user_oauth_writer)],
) -> UserSheetsService:
    return UserSheetsService(
        connections=connections,
        tokens=tokens,
        oauth=oauth,
        reader=reader,
        writer=writer,
        clock=_now_utc,
    )


def get_live_captions_token_provider(
    settings: Annotated[Settings, Depends(get_settings)],
) -> LiveCaptionTokenPort | None:
    """Wire the AssemblyAI temp-token adapter, or `None` when unconfigured.

    Returning `None` lets the service distinguish "operator hasn't set the
    key" from "AssemblyAI is down" — the route maps the former to 503
    (operator problem) and the latter to 502 (upstream problem).
    """
    if not settings.assemblyai_api_key:
        return None
    return AssemblyAITokenProvider(
        api_key=settings.assemblyai_api_key,
        http_client=_build_oauth_http_client_cached(),
    )


def get_live_captions_service(
    settings: Annotated[Settings, Depends(get_settings)],
    provider: Annotated[
        LiveCaptionTokenPort | None, Depends(get_live_captions_token_provider)
    ],
) -> LiveCaptionsService:
    return LiveCaptionsService(
        feature_enabled=settings.live_captions_enabled,
        token_provider=provider,
    )


def get_user_mapping_service(
    connections: Annotated[SheetConnectionRepoPort, Depends(get_sheet_connection_repo)],
    tokens: Annotated[TokenStorePort, Depends(get_token_store)],
    oauth: Annotated[OAuthProviderPort, Depends(get_oauth_provider)],
    reader: Annotated[SheetHeaderReaderPort, Depends(get_user_oauth_header_reader)],
) -> UserMappingService:
    return UserMappingService(
        connections=connections,
        tokens=tokens,
        oauth=oauth,
        reader=reader,
        clock=_now_utc,
    )


# --- Auth-aware route dependencies -----------------------------------------


async def get_optional_signed_in_user(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    auth: Annotated[AuthService, Depends(get_auth_service)],
    signer: Annotated[CookieSigner, Depends(get_cookie_signer)],
) -> SignedInUser | None:
    """Resolve the session cookie to a `SignedInUser`, or `None` if absent.

    Use in routes that have *both* an authenticated path and an
    unauthenticated fallback (e.g. `/sheets/append` routes signed-in
    users to their picked sheet, signed-out users to the dev path).
    Routes that REQUIRE auth should use `get_required_signed_in_user`
    instead — that one raises 401.
    """
    raw = request.cookies.get(settings.session_cookie_name)
    if raw is None:
        return None
    session_id = signer.unsign_session_id(raw)
    if session_id is None:
        return None
    outcome = await auth.get_user_for_session(session_id)
    return outcome[1] if outcome[0] == "ok" else None


async def get_required_signed_in_user(
    signed_in: Annotated[SignedInUser | None, Depends(get_optional_signed_in_user)],
) -> SignedInUser:
    """Same as the optional flavour but raises 401 if the user isn't signed in."""
    if signed_in is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not signed in.",
        )
    return signed_in


def _now_utc() -> datetime:
    """UTC-aware clock for the user-sheets service. Tests pin a different one."""
    return datetime.now(UTC)
