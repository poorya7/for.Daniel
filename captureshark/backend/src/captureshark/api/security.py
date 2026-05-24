"""HTTP-layer security primitives — signed cookies + small constants.

Lives in `api/` because it's strictly an HTTP-transport concern: how do
we ship server-trusted state to a browser via cookies and read it back
without the browser being able to forge it?

Two distinct cookies, one shared secret:

  * ``oauth_state``  — short-lived (10 min), set by the start endpoint,
    read by the return endpoint, used purely for CSRF protection on
    the OAuth round-trip.
  * ``captureshark_session`` — long-lived, set after a successful sign-in,
    carries the opaque server-side session id.

`itsdangerous.URLSafeTimedSerializer` is the workhorse — it timestamps
and HMAC-signs. We use *different salts per cookie kind* so a leaked
``oauth_state`` cookie value can't be replayed as a session cookie even
if both are signed with the same secret.
"""

from __future__ import annotations

from typing import Final

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

# Cookie names — single source of truth for routes + tests.
OAUTH_STATE_COOKIE_NAME: Final = "oauth_state"
"""Short-lived CSRF-state cookie set during the sign-in round-trip."""

# Salts — namespaced so two cookies signed with the same secret can't
# be cross-substituted. Free defence-in-depth.
_OAUTH_STATE_SALT: Final = "captureshark.oauth_state.v1"
_SESSION_SALT: Final = "captureshark.session.v1"

# Lifetimes (seconds).
OAUTH_STATE_MAX_AGE_SECONDS: Final = 10 * 60  # 10 min — enough for a slow OAuth.
SESSION_COOKIE_MAX_AGE_SECONDS: Final = 30 * 24 * 60 * 60  # 30 days.


class CookieSigner:
    """Sign / unsign small string values for round-tripping via cookies.

    Reused by both the OAuth-state and session cookies; the salt
    parameter on each method namespaces them so `oauth_state` values
    can't be presented as session ids.
    """

    def __init__(self, secret_key: str) -> None:
        if not secret_key:
            raise ValueError("CookieSigner requires a non-empty secret_key.")
        self._serializer = URLSafeTimedSerializer(secret_key)

    # ----- OAuth state ----------------------------------------------------

    def sign_oauth_state(self, state: str) -> str:
        return self._serializer.dumps(state, salt=_OAUTH_STATE_SALT)

    def unsign_oauth_state(self, signed: str) -> str | None:
        return self._unsign(signed, salt=_OAUTH_STATE_SALT, max_age=OAUTH_STATE_MAX_AGE_SECONDS)

    # ----- Session id ----------------------------------------------------

    def sign_session_id(self, session_id: str) -> str:
        return self._serializer.dumps(session_id, salt=_SESSION_SALT)

    def unsign_session_id(self, signed: str) -> str | None:
        # No `max_age` here — session lifetime is enforced server-side
        # by the `sessions` table (we can revoke instantly via DELETE),
        # not by cookie expiry. The browser still drops the cookie on
        # `Max-Age` expiry; this just decouples the signature TTL from
        # the lifetime check so refreshing in-place doesn't re-sign.
        return self._unsign(signed, salt=_SESSION_SALT, max_age=None)

    # ----- Internals -----------------------------------------------------

    def _unsign(self, signed: str, *, salt: str, max_age: int | None) -> str | None:
        try:
            value = self._serializer.loads(signed, salt=salt, max_age=max_age)
        except (BadSignature, SignatureExpired):
            return None
        return value if isinstance(value, str) else None
