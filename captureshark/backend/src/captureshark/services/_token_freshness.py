"""Shared token-freshness helper for the services that talk to Google as a user.

Two services need the same "load tokens, refresh if expiry is near,
persist if refresh rotated the refresh-token, hand back the current
pair" flow:

  * `AuthService.get_fresh_access_token` (powers `/auth/picker-token`
    so the frontend can hand a live token to the Picker SDK).
  * `UserSheetsService.save_for_user` (refreshes ahead of the Sheets
    API call).

Without this helper they'd duplicate ~25 lines of subtle logic. The
helper is private (leading `_` in the filename) because nothing
outside `services/` should call it directly — domain code uses the
service surfaces, not the freshness helper.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Final, Literal

from captureshark.domain.auth import (
    AuthError,
    AuthErrorKind,
    OAuthProviderPort,
    OAuthTokens,
    TokenStorePort,
)

# Refresh slightly before the access token actually expires so the
# downstream Google call doesn't race the boundary. 60 seconds is
# enough margin for Google to propagate the new token *and* for our
# request to round-trip with it.
REFRESH_BUFFER: Final = timedelta(seconds=60)


# Shared outcome shape — wrap whatever `OAuthTokens` we resolved, or an
# `AuthError`. Both callers map the error to their own domain shape.
FreshTokensOutcome = (
    tuple[Literal["ok"], OAuthTokens] | tuple[Literal["error"], AuthError]
)


async def get_fresh_tokens(
    *,
    user_id: int,
    tokens_store: TokenStorePort,
    oauth: OAuthProviderPort,
    now: Callable[[], datetime],
) -> FreshTokensOutcome:
    """Resolve a non-expired token bundle for the user — refresh if needed.

    Returns the existing tokens unchanged when they're still valid,
    refreshed-and-persisted tokens when expiry is near, or an error
    when no tokens exist or the refresh against Google failed.
    """
    tokens = await tokens_store.get_for_user(user_id)
    if tokens is None:
        return (
            "error",
            AuthError(
                kind=AuthErrorKind.SESSION_NOT_FOUND,
                detail="No OAuth tokens stored for this user.",
            ),
        )

    if now() + REFRESH_BUFFER < tokens.access_token_expires_at:
        return ("ok", tokens)

    refresh = await oauth.refresh_access_token(refresh_token=tokens.refresh_token)
    if refresh[0] == "error":
        return refresh
    refreshed = refresh[1]

    # Google occasionally rotates the refresh token; persist the new
    # one if so, otherwise carry the existing through. Same for the
    # scope set — sometimes the refresh response omits it, in which
    # case the prior grant set is still in effect.
    new_tokens = OAuthTokens(
        access_token=refreshed.access_token,
        refresh_token=refreshed.refresh_token or tokens.refresh_token,
        access_token_expires_at=refreshed.access_token_expires_at,
        granted_scopes=refreshed.granted_scopes or tokens.granted_scopes,
    )
    await tokens_store.save_for_user(user_id, new_tokens)
    return ("ok", new_tokens)
