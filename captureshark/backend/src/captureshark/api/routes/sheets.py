"""Sheets router — write a captured row to the sheet, plus the Picker hook.

Two endpoints:

  * `POST /sheets/append` — saves a row. If the request carries a valid
    session cookie *and* that user has picked a sheet via the Picker,
    we route to their picked sheet via the user-OAuth path. Otherwise
    we fall back to the service-account dev path (step 3) — kept alive
    so back-end smoke tests work without going through the full OAuth
    round-trip.

  * `POST /sheets/connect` — Picker selection lands here; we persist
    the user's pick. Requires auth.

Per tech plan §6 + the v1 sketch's "fail clean" principle, every error
gets plain-English copy. The two error tables below map both writer-
level (`SheetsErrorKind`) and orchestrator-level (`UserSaveErrorKind`)
errors to HTTP status + user copy in one place.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Header, status
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

from captureshark.api.deps import (
    get_idempotency_store,
    get_optional_sheets_service,
    get_optional_signed_in_user,
    get_required_signed_in_user,
    get_sheet_connection_repo,
    get_user_mapping_service,
    get_user_sheets_service,
)
from captureshark.api.schemas import (
    ColumnMappingDTO,
    ConnectedSheetDTO,
    ConnectSheetRequest,
    ConnectSheetResponse,
    ErrorBody,
    ErrorResponse,
    MappingProposalDTO,
    ProposedMappingResponse,
    SaveMappingRequest,
    SaveMappingResponse,
    SaveRowRequest,
    SaveRowResponse,
    SheetTargetDTO,
)
from captureshark.domain.auth import SignedInUser
from captureshark.domain.column_mapping import ColumnMapping, LeadField, MappingProposal
from captureshark.domain.idempotency import CachedResponse, IdempotencyStorePort
from captureshark.domain.sheets import (
    SheetConnectionRepoPort,
    SheetsErrorKind,
    SheetTarget,
    SheetWriteError,
    UserSaveError,
    UserSaveErrorKind,
)
from captureshark.services.sheets_service import SheetsService
from captureshark.services.user_mapping_service import UserMappingService
from captureshark.services.user_sheets_service import UserSheetsService

router = APIRouter(tags=["sheets"])


# Cached idempotency-key responses live for 7 days from first write.
# Long enough to cover the longest realistic offline period for the
# persona (Linda at an open house in a dead zone for an afternoon);
# short enough that we're not carrying a runaway key table. Matches
# `docs/_planning/offline_queue.md §7.2`.
_IDEMPOTENCY_TTL = timedelta(days=7)


_ERROR_TABLE: dict[SheetsErrorKind, tuple[int, str, str]] = {
    SheetsErrorKind.NOT_FOUND: (
        status.HTTP_404_NOT_FOUND,
        "sheet_not_found",
        "We can't find your sheet anymore. Did it get deleted or moved?",
    ),
    SheetsErrorKind.PERMISSION_DENIED: (
        status.HTTP_403_FORBIDDEN,
        "sheet_no_permission",
        "We don't have permission to write to this sheet. Check sharing and try again.",
    ),
    SheetsErrorKind.AUTH_EXPIRED: (
        status.HTTP_401_UNAUTHORIZED,
        "session_lost",
        "Your sign-in expired. Sign in again to save.",
    ),
    SheetsErrorKind.UPSTREAM_UNAVAILABLE: (
        status.HTTP_502_BAD_GATEWAY,
        "sheets_unavailable",
        "Google Sheets is taking a moment, hang on — try again in a sec.",
    ),
    SheetsErrorKind.UPSTREAM_RATE_LIMITED: (
        status.HTTP_429_TOO_MANY_REQUESTS,
        "sheets_busy",
        "Google Sheets is rate-limiting us — try again in a minute. Your row is safe.",
    ),
    SheetsErrorKind.UNEXPECTED: (
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "sheet_save_failed",
        "Something went wrong on our end. Try again in a moment.",
    ),
}


_USER_SAVE_ERROR_TABLE: dict[UserSaveErrorKind, tuple[int, str, str]] = {
    UserSaveErrorKind.NO_CONNECTION: (
        status.HTTP_409_CONFLICT,
        "no_sheet_connected",
        "Pick a sheet to save to first.",
    ),
    UserSaveErrorKind.NO_TOKENS: (
        status.HTTP_401_UNAUTHORIZED,
        "session_lost",
        "Your sign-in expired. Sign in again to save.",
    ),
    UserSaveErrorKind.REFRESH_FAILED: (
        status.HTTP_401_UNAUTHORIZED,
        "session_lost",
        "Google needs you to sign in again.",
    ),
}


@router.post(
    "/sheets/append",
    response_model=SaveRowResponse,
    summary="Append a captured row to the user's connected sheet (or dev sheet)",
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def append_row(
    payload: SaveRowRequest,
    signed_in: Annotated[
        SignedInUser | None, Depends(get_optional_signed_in_user)
    ],
    user_service: Annotated[UserSheetsService, Depends(get_user_sheets_service)],
    dev_service: Annotated[
        SheetsService | None, Depends(get_optional_sheets_service)
    ],
    idempotency_store: Annotated[
        IdempotencyStorePort, Depends(get_idempotency_store)
    ],
    idempotency_key: Annotated[str | None, Header(alias="X-Idempotency-Key")] = None,
) -> SaveRowResponse | JSONResponse:
    """Save a row.

    Routing rule:
      * Signed in → user-OAuth path (writes to their picked sheet,
        refreshes their token if needed).
      * Signed out → service-account dev path if configured, else 503.
        The dev path is what lets the team smoke-test extraction
        without going through the full OAuth round-trip.

    Idempotency:
      Clients can send `X-Idempotency-Key: <uuid v4>` to dedupe
      retries of the same logical save (see
      `docs/_planning/offline_queue.md §7`). Only honoured for
      signed-in users — the dev path is for smoke tests and doesn't
      need it. We cache ONLY the success response (HTTP 200);
      failures fall through so the client can retry after fixing
      whatever the upstream failure was (re-auth, restore a deleted
      sheet, fix a column mapping). Header omitted = normal flow,
      backward-compatible with clients that don't send it yet.
    """
    # Wrap the whole orchestration in a generic exception handler so
    # an unexpected raise (Google client crash, schema mismatch, null
    # deref deep in the service, etc.) doesn't escape to FastAPI's
    # default 500 handler — which returns `{"detail": "Internal Server
    # Error"}`, a shape the frontend's `apiFetch` can't parse, so the
    # user sees the raw fallback "Request failed (500)." We log the
    # traceback for diagnosis + return the same friendly body the
    # domain's `SheetsErrorKind.UNEXPECTED` path returns. PII is
    # never in the log — only structural metadata (source, whether
    # the user was signed in, whether an idempotency key was sent).
    try:
        if signed_in is not None:
            # Idempotency: pre-write cache check.
            if idempotency_key is not None:
                cached = await idempotency_store.lookup(
                    key=idempotency_key,
                    user_id=signed_in.user.id,
                )
                if cached is not None:
                    return JSONResponse(
                        status_code=cached.status,
                        content=json.loads(cached.body_json),
                    )

            outcome = await user_service.save_for_user(
                user_id=signed_in.user.id,
                name=payload.name,
                phone=payload.phone,
                email=payload.email,
                has_agent=payload.has_agent,
                intent=payload.intent,
                timeline=payload.timeline,
                financing_status=payload.financing_status,
                area=payload.area,
                budget=payload.budget,
                follow_up=payload.follow_up,
                notes=payload.notes,
                source=payload.source.value,
                client_tz=payload.client_tz,
            )
            if outcome[0] == "ok":
                success = _success_response(outcome[1].target)
                # Idempotency: cache successes for replay. Failures
                # are intentionally not cached — see route docstring.
                if idempotency_key is not None:
                    await idempotency_store.record(
                        key=idempotency_key,
                        user_id=signed_in.user.id,
                        response=CachedResponse(
                            status=status.HTTP_200_OK,
                            body_json=success.model_dump_json(),
                        ),
                        expires_at=datetime.now(UTC) + _IDEMPOTENCY_TTL,
                    )
                return success
            if outcome[0] == "write_error":
                return _write_error_response(outcome[1])
            return _user_save_error_response(outcome[1])

        if dev_service is None:
            body = ErrorResponse(
                error=ErrorBody(
                    code="not_signed_in",
                    message="Sign in to save your row.",
                )
            )
            return JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content=body.model_dump(),
            )

        # Unauthenticated *and* dev path configured: fall back to it.
        dev_outcome = dev_service.save_lead(
            name=payload.name,
            phone=payload.phone,
            email=payload.email,
            has_agent=payload.has_agent,
            intent=payload.intent,
            timeline=payload.timeline,
            financing_status=payload.financing_status,
            area=payload.area,
            budget=payload.budget,
            follow_up=payload.follow_up,
            notes=payload.notes,
            source=payload.source.value,
            client_tz=payload.client_tz,
        )
        if dev_outcome[0] == "ok":
            return _success_response(dev_outcome[1].target)
        return _write_error_response(dev_outcome[1])
    except Exception:
        # Diagnostic log: traceback + structural metadata, no PII.
        # `logger.exception` includes the full traceback automatically
        # — that's the single most useful artifact next time a 500
        # hits, because uvicorn writes it to stderr where the
        # operator (or me) can read it.
        logger.exception(
            "sheets.append.unexpected_failure",
            extra={
                "source": payload.source.value,
                "signed_in": signed_in is not None,
                "has_idempotency_key": idempotency_key is not None,
                "dev_path_available": dev_service is not None,
            },
        )
        # Friendly body — same code + copy the domain-error table
        # uses for SheetsErrorKind.UNEXPECTED, so the frontend can
        # branch on the code consistently regardless of whether
        # the error was domain-raised or a true bolt from the blue.
        unexpected_body = ErrorResponse(
            error=ErrorBody(
                code="sheet_save_failed",
                message="Something went wrong on our end. Try again in a moment.",
            )
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=unexpected_body.model_dump(),
        )


@router.post(
    "/sheets/connect",
    response_model=ConnectSheetResponse,
    summary="Persist the user's Picker selection",
    responses={
        401: {"model": ErrorResponse},
    },
)
async def connect_sheet(
    payload: ConnectSheetRequest,
    signed_in: Annotated[SignedInUser, Depends(get_required_signed_in_user)],
    connections: Annotated[
        SheetConnectionRepoPort, Depends(get_sheet_connection_repo)
    ],
) -> ConnectSheetResponse:
    """Record the user's Picker selection — overwrites any previous pick."""
    connection = await connections.upsert_for_user(
        user_id=signed_in.user.id,
        spreadsheet_id=payload.spreadsheet_id,
        display_name=payload.display_name,
        worksheet_title=payload.worksheet_title,
    )
    return ConnectSheetResponse(
        connected_sheet=ConnectedSheetDTO(
            spreadsheet_id=connection.spreadsheet_id,
            display_name=connection.display_name,
            worksheet_title=connection.worksheet_title,
        )
    )


@router.post(
    "/sheets/mapping",
    response_model=SaveMappingResponse,
    summary="Persist the user-confirmed column mapping for the connected sheet",
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
    },
)
async def save_mapping(
    payload: SaveMappingRequest,
    signed_in: Annotated[SignedInUser, Depends(get_required_signed_in_user)],
    connections: Annotated[
        SheetConnectionRepoPort, Depends(get_sheet_connection_repo)
    ],
) -> SaveMappingResponse | JSONResponse:
    """Save the column mapping the user confirmed on the mapping screen.

    Validates the request keys against `LeadField` (rejecting unknown
    or missing keys with a 400 — pydantic can't enum-check dict keys
    cleanly so we do it here), then upserts onto the user's
    connection. Subsequent saves use this mapping to project rows
    onto the user's actual column layout.
    """
    parse_result = _parse_save_mapping(payload)
    if isinstance(parse_result, JSONResponse):
        return parse_result
    try:
        connection = await connections.update_mapping_for_user(
            user_id=signed_in.user.id,
            mapping=parse_result,
        )
    except LookupError:
        body = ErrorResponse(
            error=ErrorBody(
                code="no_sheet_connected",
                message="Pick a sheet first, then confirm the columns.",
            )
        )
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT, content=body.model_dump()
        )
    # `header_mapping` is non-None right after a successful upsert.
    saved = connection.header_mapping
    assert saved is not None  # noqa: S101 — invariant from the repo contract
    return SaveMappingResponse(
        mapping=ColumnMappingDTO(
            fields={field.value: header for field, header in saved.fields.items()},
            unmapped_headers=list(saved.unmapped_headers),
        )
    )


def _parse_save_mapping(
    payload: SaveMappingRequest,
) -> ColumnMapping | JSONResponse:
    """Validate dict-shaped DTO fields → typed `ColumnMapping`.

    Returns a 400 `JSONResponse` for any of:
      * Unknown lead-field keys (`"vibe": "Mood"`).
      * Missing canonical keys (must specify all seven, value can be `null`).

    Pydantic's `dict[str, str | None]` is too loose to catch these
    statically; do it here so the route is the single trust boundary.
    """
    expected_keys = {field.value for field in LeadField}
    actual_keys = set(payload.fields.keys())
    if actual_keys != expected_keys:
        unknown = sorted(actual_keys - expected_keys)
        missing = sorted(expected_keys - actual_keys)
        details = ", ".join(
            part
            for part in (
                f"unknown: {unknown}" if unknown else "",
                f"missing: {missing}" if missing else "",
            )
            if part
        )
        body = ErrorResponse(
            error=ErrorBody(
                code="invalid_mapping",
                message=f"Mapping fields don't match the canonical lead fields ({details}).",
            )
        )
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST, content=body.model_dump()
        )
    return ColumnMapping(
        fields={field: payload.fields[field.value] for field in LeadField},
        unmapped_headers=tuple(payload.unmapped_headers),
    )


@router.get(
    "/sheets/proposed-mapping",
    response_model=ProposedMappingResponse,
    summary="Read row 1 of the user's connected sheet and propose a column mapping",
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
    },
)
async def proposed_mapping(
    signed_in: Annotated[SignedInUser, Depends(get_required_signed_in_user)],
    service: Annotated[UserMappingService, Depends(get_user_mapping_service)],
) -> ProposedMappingResponse | JSONResponse:
    """Return a `MappingProposal` for the user's currently-connected sheet.

    Frontend calls this right after the Picker resolves (and on demand
    if the user comes back later wanting to re-confirm). Three success
    shapes share one HTTP 200 response — the `kind` discriminator
    tells the frontend which screen to show.

    Errors map the same way as `/sheets/append`: orchestrator errors
    land on auth-flow statuses (401 / 409); read errors map to the
    Sheets-side codes (404 / 403 / 429 / 502).
    """
    outcome = await service.propose_for_user(user_id=signed_in.user.id)
    if outcome[0] == "ok":
        return ProposedMappingResponse(proposal=_proposal_to_dto(outcome[1]))
    if outcome[0] == "read_error":
        return _write_error_response(outcome[1])
    return _user_save_error_response(outcome[1])


# --- Response helpers -----------------------------------------------------


def _proposal_to_dto(proposal: MappingProposal) -> MappingProposalDTO:
    """Project a domain `MappingProposal` to its wire shape."""
    mapping_dto: ColumnMappingDTO | None
    if proposal.mapping is None:
        mapping_dto = None
    else:
        mapping_dto = ColumnMappingDTO(
            fields={field.value: header for field, header in proposal.mapping.fields.items()},
            unmapped_headers=list(proposal.mapping.unmapped_headers),
        )
    return MappingProposalDTO(
        kind=proposal.kind.value,
        headers=list(proposal.headers),
        mapping=mapping_dto,
    )


def _success_response(target: SheetTarget) -> SaveRowResponse:
    return SaveRowResponse(
        target=SheetTargetDTO(
            spreadsheet_id=target.spreadsheet_id,
            display_name=target.display_name,
        )
    )


def _write_error_response(err: SheetWriteError) -> JSONResponse:
    http_status, code, message = _ERROR_TABLE[err.kind]
    body = ErrorResponse(error=ErrorBody(code=code, message=message))
    return JSONResponse(status_code=http_status, content=body.model_dump())


def _user_save_error_response(err: UserSaveError) -> JSONResponse:
    http_status, code, message = _USER_SAVE_ERROR_TABLE[err.kind]
    body = ErrorResponse(error=ErrorBody(code=code, message=message))
    return JSONResponse(status_code=http_status, content=body.model_dump())
