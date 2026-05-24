"""Integration tests for `RequestIDMiddleware`.

The middleware has three observable behaviours:

1. Inbound `X-Request-ID` header is honoured (so a load balancer can
   tag a request and have downstream services log under the same ID).
2. Missing inbound header → fresh `uuid4().hex` minted server-side.
3. Outbound response always carries `X-Request-ID`.

We exercise all three via TestClient hitting `/api/v1/health` (the
cheapest no-side-effect endpoint).
"""

from __future__ import annotations

import re

from fastapi.testclient import TestClient

from captureshark.main import app

_HEX32 = re.compile(r"^[0-9a-f]{32}$")


def test_inbound_request_id_is_honoured() -> None:
    """If the upstream sets `X-Request-ID`, we preserve it."""
    client = TestClient(app)
    response = client.get(
        "/api/v1/health",
        headers={"X-Request-ID": "tracecorp-abc-123"},
    )
    assert response.status_code == 200
    assert response.headers["x-request-id"] == "tracecorp-abc-123"


def test_missing_request_id_is_minted() -> None:
    """No inbound header → a fresh `uuid4().hex` lands on the response."""
    client = TestClient(app)
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert _HEX32.match(response.headers["x-request-id"]) is not None


def test_each_request_gets_a_distinct_id() -> None:
    """Two consecutive un-tagged requests get different minted IDs.

    Pins that we don't accidentally cache a single ID across requests
    (which would defeat the whole correlation point).
    """
    client = TestClient(app)
    a = client.get("/api/v1/health").headers["x-request-id"]
    b = client.get("/api/v1/health").headers["x-request-id"]
    assert a != b
