"""Live-captions service — mints AssemblyAI session tokens for the browser.

Wraps the `LiveCaptionTokenPort` adapter with the feature-flag and
configuration guards. Routes call into this service so policy lives in
one place — adapters do HTTP, services do policy, routes do HTTP shaping.
"""

from __future__ import annotations

from captureshark.domain.live_captions import (
    LiveCaptionTokenError,
    LiveCaptionTokenErrorKind,
    LiveCaptionTokenOutcome,
    LiveCaptionTokenPort,
)


class LiveCaptionsService:
    """Thin orchestration over the token adapter.

    Policy decisions encoded here (rather than in the route):
      * Feature-flag gate — if `LIVE_CAPTIONS_ENABLED` is off, the
        endpoint behaves as if the surface doesn't exist.
      * Configuration gate — if no AssemblyAI key is set, fail with a
        distinct error so operators can tell their own missing config
        apart from a real upstream outage.
    """

    def __init__(
        self,
        *,
        feature_enabled: bool,
        token_provider: LiveCaptionTokenPort | None,
    ) -> None:
        self._feature_enabled = feature_enabled
        self._token_provider = token_provider

    async def mint_session_token(
        self, *, expires_in_seconds: int
    ) -> LiveCaptionTokenOutcome:
        """Return a fresh AssemblyAI temp token, or an error outcome."""
        if not self._feature_enabled:
            return (
                "error",
                LiveCaptionTokenError(
                    kind=LiveCaptionTokenErrorKind.FEATURE_DISABLED,
                    detail="LIVE_CAPTIONS_ENABLED is off",
                ),
            )
        if self._token_provider is None:
            return (
                "error",
                LiveCaptionTokenError(
                    kind=LiveCaptionTokenErrorKind.NOT_CONFIGURED,
                    detail="ASSEMBLYAI_API_KEY is not set",
                ),
            )
        return await self._token_provider.mint_token(
            expires_in_seconds=expires_in_seconds
        )
