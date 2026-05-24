"""End-to-end tests for `/captures/live-token`.

Exercises the route + service + adapter wiring. The adapter is swapped
for a stub via FastAPI's `dependency_overrides` so we don't depend on
either a real AssemblyAI account or network connectivity.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from captureshark.api.deps import get_live_captions_token_provider
from captureshark.config import Settings, get_settings
from captureshark.domain.live_captions import (
    LiveCaptionToken,
    LiveCaptionTokenError,
    LiveCaptionTokenErrorKind,
    LiveCaptionTokenOutcome,
)
from captureshark.main import app


class _StubProvider:
    """In-memory `LiveCaptionTokenPort` — returns whatever it was constructed with."""

    def __init__(self, outcome: LiveCaptionTokenOutcome) -> None:
        self._outcome = outcome
        self.calls: list[int] = []

    async def mint_token(self, *, expires_in_seconds: int) -> LiveCaptionTokenOutcome:
        self.calls.append(expires_in_seconds)
        return self._outcome


def _settings_with(*, flag: bool, key: str | None) -> Settings:
    """Build a `Settings` that ignores `.env` so tests stay hermetic.

    Pydantic-settings reads `.env` at construction; with the dev `.env` on
    disk holding a real AssemblyAI key, `os.environ.pop` doesn't make the
    key invisible. Disabling `env_file` is the clean way to pin only the
    fields a given test cares about.
    """
    return Settings.model_construct(  # type: ignore[call-arg]
        live_captions_enabled=flag,
        assemblyai_api_key=key,
    )


@pytest.fixture(autouse=True)
def _reset_overrides():
    get_settings.cache_clear()
    app.dependency_overrides = {}
    try:
        yield
    finally:
        get_settings.cache_clear()
        app.dependency_overrides = {}


def test_live_token_404_when_flag_disabled() -> None:
    app.dependency_overrides[get_settings] = lambda: _settings_with(
        flag=False, key="anything"
    )
    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/live-token",
        headers={"X-Forwarded-For": "203.0.113.10"},
    )
    assert response.status_code == 404, response.json()
    assert response.json()["error"]["code"] == "feature_disabled"


def test_live_token_503_when_flag_on_but_key_missing() -> None:
    app.dependency_overrides[get_settings] = lambda: _settings_with(
        flag=True, key=None
    )
    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/live-token",
        headers={"X-Forwarded-For": "203.0.113.11"},
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "not_configured"


def test_live_token_200_returns_token_and_expiry_when_provider_succeeds() -> None:
    app.dependency_overrides[get_settings] = lambda: _settings_with(
        flag=True, key="key-anything"
    )
    expires = datetime.now(UTC) + timedelta(seconds=60)
    stub = _StubProvider(("ok", LiveCaptionToken(token="t-xyz", expires_at=expires)))
    app.dependency_overrides[get_live_captions_token_provider] = lambda: stub

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/live-token",
        headers={"X-Forwarded-For": "203.0.113.12"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["token"] == "t-xyz"
    assert body["expires_at"] == expires.isoformat()
    assert stub.calls == [60]


def test_live_token_502_when_upstream_rejects() -> None:
    app.dependency_overrides[get_settings] = lambda: _settings_with(
        flag=True, key="key-anything"
    )
    stub = _StubProvider(
        (
            "error",
            LiveCaptionTokenError(
                kind=LiveCaptionTokenErrorKind.UPSTREAM_REJECTED,
                detail="HTTP 401",
            ),
        )
    )
    app.dependency_overrides[get_live_captions_token_provider] = lambda: stub

    client = TestClient(app)
    response = client.post(
        "/api/v1/captures/live-token",
        headers={"X-Forwarded-For": "203.0.113.13"},
    )

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "captions_unavailable"
