"""Integration tests for `CostCapMiddleware`.

Covers all three failure modes the spec calls out:

- Per-IP minute bucket exceeded → 429 / `rate_limited_ip`.
- Per-IP hour bucket exceeded → 429 / `rate_limited_ip`.
- Daily spend cap exceeded → 429 / `daily_spend_capped`.

We construct an isolated `FastAPI` app per test (rather than importing
the global `app`) so the middleware's in-process state doesn't leak
between tests. The capture endpoint itself is stubbed out — we're
exercising the gate, not the OpenAI call.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from captureshark.api.middleware.cost_cap import CostCapMiddleware


def _build_app(
    *,
    per_minute: int = 10,
    per_hour: int = 60,
    daily_spend_cap_usd: float | None = None,
) -> FastAPI:
    """Minimal app: real middleware, fake `/api/v1/captures` route.

    The route returns the same shape (200 + JSON) on every call so the
    middleware's behaviour is the only thing under test.
    """
    app = FastAPI()
    app.add_middleware(
        CostCapMiddleware,
        per_minute=per_minute,
        per_hour=per_hour,
        daily_spend_cap_usd=daily_spend_cap_usd,
    )

    @app.post("/api/v1/captures")
    def _stub_capture() -> JSONResponse:  # pragma: no cover - trivial
        return JSONResponse(status_code=200, content={"ok": True})

    @app.post("/api/v1/captures/stream")
    def _stub_stream() -> JSONResponse:  # pragma: no cover - trivial
        return JSONResponse(status_code=200, content={"ok": True})

    @app.get("/api/v1/captures")
    def _stub_get() -> JSONResponse:  # pragma: no cover - trivial
        return JSONResponse(status_code=200, content={"ok": True})

    return app


def _hits_with_ip(client: TestClient, ip: str, n: int) -> Iterator[Any]:
    """Drive `n` POSTs through the middleware tagged as the same IP."""
    for _ in range(n):
        yield client.post(
            "/api/v1/captures",
            json={"text": "hi"},
            headers={"X-Forwarded-For": ip},
        )


def test_eleventh_minute_request_from_same_ip_is_refused() -> None:
    """10 succeed, the 11th gets 429 with `rate_limited_ip`."""
    app = _build_app(per_minute=10, per_hour=1000)
    client = TestClient(app)

    responses = list(_hits_with_ip(client, "1.2.3.4", 11))
    statuses = [r.status_code for r in responses]
    assert statuses[:10] == [200] * 10
    assert statuses[10] == 429

    body = responses[10].json()
    assert body["error"]["code"] == "rate_limited_ip"
    # Retry-After is set so a polite client knows when to come back.
    assert responses[10].headers["Retry-After"] == "60"


def test_hour_bucket_refuses_after_per_hour_cap() -> None:
    """With per_minute high but per_hour=5, the 6th from same IP is 429."""
    app = _build_app(per_minute=1000, per_hour=5)
    client = TestClient(app)

    responses = list(_hits_with_ip(client, "5.6.7.8", 6))
    assert [r.status_code for r in responses[:5]] == [200] * 5
    assert responses[5].status_code == 429
    assert responses[5].json()["error"]["code"] == "rate_limited_ip"
    # Hour bucket → Retry-After ≈ an hour.
    assert responses[5].headers["Retry-After"] == "3600"


def test_separate_ips_have_separate_buckets() -> None:
    """An IP at its limit shouldn't lock out a different IP."""
    app = _build_app(per_minute=2, per_hour=1000)
    client = TestClient(app)

    # IP A burns through its 2/min then gets refused.
    a = list(_hits_with_ip(client, "10.0.0.1", 3))
    assert [r.status_code for r in a] == [200, 200, 429]

    # IP B, meanwhile, is untouched and gets its own 2 successes.
    b = list(_hits_with_ip(client, "10.0.0.2", 2))
    assert [r.status_code for r in b] == [200, 200]


def test_daily_spend_cap_refuses_with_distinct_code() -> None:
    """When the spend cap is below the per-call estimate, the very
    second call is refused with `daily_spend_capped` (not the IP code).

    Per-call estimate is $0.001; cap of $0.0005 means the first call
    charges + crosses the threshold so the second call sees the cap.
    """
    app = _build_app(per_minute=1000, per_hour=1000, daily_spend_cap_usd=0.0005)
    client = TestClient(app)

    first = client.post(
        "/api/v1/captures",
        json={"text": "hi"},
        headers={"X-Forwarded-For": "9.9.9.9"},
    )
    second = client.post(
        "/api/v1/captures",
        json={"text": "hi"},
        headers={"X-Forwarded-For": "9.9.9.9"},
    )

    assert first.status_code == 200
    assert second.status_code == 429
    body = second.json()
    assert body["error"]["code"] == "daily_spend_capped"
    # Retry-After should be a positive number of seconds to UTC midnight.
    assert int(second.headers["Retry-After"]) > 0


def test_get_requests_pass_through() -> None:
    """Non-POSTs (e.g. swagger fetches) bypass the middleware entirely.

    Otherwise OpenAPI doc loads would tick the bucket too.
    """
    app = _build_app(per_minute=1, per_hour=1)
    client = TestClient(app)

    # Burn the cap with one POST first.
    burn = client.post(
        "/api/v1/captures",
        json={"text": "hi"},
        headers={"X-Forwarded-For": "8.8.8.8"},
    )
    assert burn.status_code == 200

    # Now POST is locked, but GET still works.
    locked = client.post(
        "/api/v1/captures",
        json={"text": "hi"},
        headers={"X-Forwarded-For": "8.8.8.8"},
    )
    assert locked.status_code == 429

    untouched = client.get(
        "/api/v1/captures",
        headers={"X-Forwarded-For": "8.8.8.8"},
    )
    assert untouched.status_code == 200


def test_non_capture_paths_bypass_middleware() -> None:
    """A path outside `/api/v1/captures` is never gated."""
    app = _build_app(per_minute=1, per_hour=1)

    @app.post("/api/v1/other")
    def _other() -> JSONResponse:  # pragma: no cover - trivial
        return JSONResponse(status_code=200, content={"ok": True})

    client = TestClient(app)
    for _ in range(5):
        r = client.post(
            "/api/v1/other",
            json={},
            headers={"X-Forwarded-For": "7.7.7.7"},
        )
        assert r.status_code == 200
