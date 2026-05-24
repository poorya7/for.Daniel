"""End-to-end tests for the feature-flags endpoint."""

from fastapi.testclient import TestClient

from captureshark.config import get_settings
from captureshark.main import app


def test_features_endpoint_defaults_to_live_captions_on() -> None:
    # Live captions flipped ON by default 2026-05-15 — kept as a kill
    # switch but the production default is now `true`.
    get_settings.cache_clear()
    client = TestClient(app)

    response = client.get("/api/v1/features")

    assert response.status_code == 200
    body = response.json()
    assert body == {"live_captions_enabled": True}


def test_features_endpoint_reflects_kill_switch_override(
    monkeypatch: object,
) -> None:
    # Setting `LIVE_CAPTIONS_ENABLED=false` flips the kill switch and
    # forces the endpoint to report the feature dark even though the
    # in-code default is now `true`.
    import os

    os.environ["LIVE_CAPTIONS_ENABLED"] = "false"
    get_settings.cache_clear()
    try:
        client = TestClient(app)
        response = client.get("/api/v1/features")
        assert response.status_code == 200
        assert response.json() == {"live_captions_enabled": False}
    finally:
        del os.environ["LIVE_CAPTIONS_ENABLED"]
        get_settings.cache_clear()
