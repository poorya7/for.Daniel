"""User-aware Sheets service — save-to-the-user's-picked-sheet path.

Sibling of `SheetsService` (the dev / service-account path). Composes
five ports — connection repo, token store, OAuth provider, header
reader, and the writer — into one method the API layer calls per save:

    service.save_for_user(user_id=..., name=..., ...) → UserSaveOutcome

The service owns the *orchestration* concerns: which sheet, whose
token, do we need to refresh, did the refresh succeed, and — once
step 5c lands — which columns the row should land in. The writer
adapter just sees a list of cells already in the user's column order.

Two save paths inside one method, picked off `connection.header_mapping`:

  * Mapping present → read live headers, project the row through the
    persisted mapping (`project_row_to_cells`), send the result. The
    extra Sheets `values.get` is ~200ms but guarantees correctness
    even if the user re-orders / renames headers between save attempts.
  * Mapping absent (legacy connection or fresh pre-confirm) → fall
    back to `row_to_cells` fixed-order. Lets the existing dev sheet
    keep working, and gives users who haven't confirmed a mapping
    yet a working save instead of a hard error.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Literal

from captureshark.adapters._sheets_row_format import row_to_cells
from captureshark.domain.auth import (
    AuthErrorKind,
    OAuthProviderPort,
    OAuthTokens,
    TokenStorePort,
)
from captureshark.domain.column_mapping import project_row_to_cells
from captureshark.domain.sheets import (
    SheetConnection,
    SheetConnectionRepoPort,
    SheetHeaderReaderPort,
    SheetRow,
    SheetsErrorKind,
    SheetWriteError,
    UserSaveError,
    UserSaveErrorKind,
    UserSaveOutcome,
    UserSheetsWriterPort,
)
from captureshark.services._date_helpers import localise_captured_at
from captureshark.services._token_freshness import get_fresh_tokens


class UserSheetsService:
    """Per-user save use-case. Wired in `api/deps.py` for production."""

    def __init__(
        self,
        *,
        connections: SheetConnectionRepoPort,
        tokens: TokenStorePort,
        oauth: OAuthProviderPort,
        reader: SheetHeaderReaderPort,
        writer: UserSheetsWriterPort,
        clock: Callable[[], datetime],
    ) -> None:
        self._connections = connections
        self._tokens = tokens
        self._oauth = oauth
        self._reader = reader
        self._writer = writer
        self._clock = clock

    async def save_for_user(
        self,
        *,
        user_id: int,
        name: str | None,
        phone: str | None,
        email: str | None,
        has_agent: str | None,
        intent: str | None,
        timeline: str | None,
        financing_status: str | None,
        area: str | None,
        budget: str | None,
        follow_up: str | None,
        notes: str | None,
        source: str,
        client_tz: str | None = None,
    ) -> UserSaveOutcome:
        connection = await self._connections.get_for_user(user_id)
        if connection is None:
            return _orchestrator_err(
                UserSaveErrorKind.NO_CONNECTION,
                "No sheet picked yet — the frontend should open the Picker.",
            )

        tokens_outcome = await self._tokens_or_refresh(user_id)
        if tokens_outcome[0] != "ok":
            return tokens_outcome

        row = SheetRow(
            name=_clean(name),
            phone=_clean(phone),
            email=_clean(email),
            has_agent=_clean(has_agent),
            intent=_clean(intent),
            timeline=_clean(timeline),
            financing_status=_clean(financing_status),
            area=_clean(area),
            budget=_clean(budget),
            follow_up=_clean(follow_up),
            notes=_clean(notes),
            captured_at=localise_captured_at(self._clock(), client_tz),
            source=source,
        )

        cells_outcome = await self._compose_cells(
            connection=connection,
            row=row,
            access_token=tokens_outcome[1].access_token,
        )
        if cells_outcome[0] != "ok":
            return ("write_error", cells_outcome[1])

        write_outcome = await self._writer.append_cells(
            access_token=tokens_outcome[1].access_token,
            target=connection.to_target(),
            cells=cells_outcome[1],
        )
        if write_outcome[0] == "ok":
            return ("ok", write_outcome[1])
        return ("write_error", write_outcome[1])

    async def _compose_cells(
        self,
        *,
        connection: SheetConnection,
        row: SheetRow,
        access_token: str,
    ) -> (
        tuple[Literal["ok"], list[str]]
        | tuple[Literal["error"], SheetWriteError]
    ):
        """Build the cells list for `row` using the user's column layout.

        With a confirmed mapping: read live headers, project the row.
        Without one: legacy fixed-order from `_sheets_row_format`.

        The header read is the only network call here; the projection
        itself is pure-domain. We surface read failures as
        `SheetWriteError` so the caller's existing error-mapping code
        path covers them — a 404 / 403 on the read still means *"can't
        save right now"*, which is the same UX outcome as a write failure.
        """
        if connection.header_mapping is None:
            return ("ok", row_to_cells(row))

        read_outcome = await self._reader.read_headers(
            access_token=access_token,
            target=connection.to_target(),
        )
        if read_outcome[0] != "ok":
            return read_outcome
        if not read_outcome[1].headers:
            # Sheet was wiped of headers between confirm and save —
            # surface as a fixable error rather than silently writing
            # at column A. UNEXPECTED maps to the generic 500 retry copy.
            return (
                "error",
                SheetWriteError(
                    kind=SheetsErrorKind.UNEXPECTED,
                    detail="Sheet has no header row — can't place the data.",
                ),
            )
        cells = project_row_to_cells(
            row,
            headers=read_outcome[1].headers,
            mapping=connection.header_mapping,
        )
        return ("ok", cells)

    # ----- Internals -------------------------------------------------------

    async def _tokens_or_refresh(
        self, user_id: int
    ) -> (
        tuple[Literal["ok"], OAuthTokens]
        | tuple[Literal["orchestrator_error"], UserSaveError]
    ):
        """Return a fresh `OAuthTokens` for the user, mapping shared-helper
        errors into this service's `UserSaveError` shape.

        The actual freshness logic lives in `_token_freshness` so the
        auth service's picker-token endpoint can reuse it without
        duplicating the refresh-and-persist dance.
        """
        outcome = await get_fresh_tokens(
            user_id=user_id,
            tokens_store=self._tokens,
            oauth=self._oauth,
            now=self._clock,
        )
        if outcome[0] == "ok":
            return outcome
        # Map auth-domain error kinds onto user-save-domain error kinds.
        # The frontend reaction is what these flag — `NO_TOKENS` says
        # "session is gone, re-auth"; `REFRESH_FAILED` says "Google
        # rejected our refresh, also re-auth". Same UX bucket either
        # way; keep them distinct so logs stay specific.
        kind = (
            UserSaveErrorKind.NO_TOKENS
            if outcome[1].kind == AuthErrorKind.SESSION_NOT_FOUND
            else UserSaveErrorKind.REFRESH_FAILED
        )
        return _orchestrator_err(kind, outcome[1].detail)


# --- Helpers ---------------------------------------------------------------


def _clean(value: str | None) -> str | None:
    """Trim and normalise empty strings to `None`."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _orchestrator_err(
    kind: UserSaveErrorKind, detail: str
) -> tuple[Literal["orchestrator_error"], UserSaveError]:
    return ("orchestrator_error", UserSaveError(kind=kind, detail=detail))


def _utc_now() -> datetime:
    """Default clock used in `api/deps.py`. Tests pin a different one."""
    return datetime.now(UTC)
