"""User-aware mapping service — propose-mapping path.

Sibling of `UserSheetsService` (the user-save path). Both compose the
same auth-orchestration prelude (connection lookup → token refresh)
but call different ports for the actual Sheets work:

  * `UserSheetsService.save_for_user`   → `UserSheetsWriterPort.append_row`
  * `UserMappingService.propose_for_user` → `SheetHeaderReaderPort.read_headers`

After the read, this service hands the headers to the pure-domain
`propose_mapping` function and wraps the result in a `UserMappingOutcome`.
The route layer pattern-matches on the outer tag and renders the
right UX state.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Literal

from captureshark.domain.auth import (
    AuthErrorKind,
    OAuthProviderPort,
    OAuthTokens,
    TokenStorePort,
)
from captureshark.domain.column_mapping import propose_mapping
from captureshark.domain.sheets import (
    SheetConnectionRepoPort,
    SheetHeaderReaderPort,
    UserMappingOutcome,
    UserSaveError,
    UserSaveErrorKind,
)
from captureshark.services._token_freshness import get_fresh_tokens


class UserMappingService:
    """Per-user propose-mapping use-case. Wired in `api/deps.py` for prod."""

    def __init__(
        self,
        *,
        connections: SheetConnectionRepoPort,
        tokens: TokenStorePort,
        oauth: OAuthProviderPort,
        reader: SheetHeaderReaderPort,
        clock: Callable[[], datetime],
    ) -> None:
        self._connections = connections
        self._tokens = tokens
        self._oauth = oauth
        self._reader = reader
        self._clock = clock

    async def propose_for_user(self, *, user_id: int) -> UserMappingOutcome:
        connection = await self._connections.get_for_user(user_id)
        if connection is None:
            return _orchestrator_err(
                UserSaveErrorKind.NO_CONNECTION,
                "No sheet picked yet — the frontend should open the Picker.",
            )

        tokens_outcome = await self._tokens_or_refresh(user_id)
        if tokens_outcome[0] != "ok":
            return tokens_outcome

        read_outcome = await self._reader.read_headers(
            access_token=tokens_outcome[1].access_token,
            target=connection.to_target(),
        )
        if read_outcome[0] == "error":
            return ("read_error", read_outcome[1])

        proposal = propose_mapping(list(read_outcome[1].headers))
        return ("ok", proposal)

    # ----- Internals -------------------------------------------------------

    async def _tokens_or_refresh(
        self, user_id: int
    ) -> (
        tuple[Literal["ok"], OAuthTokens]
        | tuple[Literal["orchestrator_error"], UserSaveError]
    ):
        """Mirrors `UserSheetsService._tokens_or_refresh` — same shared helper.

        Duplicated rather than promoted to a base class because:
          * Each service is small (~50 lines); shared base would hide
            the orchestration sequence behind an inheritance edge.
          * Composition over inheritance — `get_fresh_tokens` IS the
            shared logic; this method is just per-service error mapping.
        """
        outcome = await get_fresh_tokens(
            user_id=user_id,
            tokens_store=self._tokens,
            oauth=self._oauth,
            now=self._clock,
        )
        if outcome[0] == "ok":
            return outcome
        kind = (
            UserSaveErrorKind.NO_TOKENS
            if outcome[1].kind == AuthErrorKind.SESSION_NOT_FOUND
            else UserSaveErrorKind.REFRESH_FAILED
        )
        return _orchestrator_err(kind, outcome[1].detail)


# --- Helpers ---------------------------------------------------------------


def _orchestrator_err(
    kind: UserSaveErrorKind, detail: str
) -> tuple[Literal["orchestrator_error"], UserSaveError]:
    return ("orchestrator_error", UserSaveError(kind=kind, detail=detail))
