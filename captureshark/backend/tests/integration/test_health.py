"""End-to-end test for the health endpoint.

Hits the FastAPI app via its in-process test client — no real network. Proves
the wiring is correct: app factory → router mount → request → response shape.
"""

from fastapi.testclient import TestClient

from captureshark.main import app


def test_health_endpoint_returns_ok() -> None:
    client = TestClient(app)

    response = client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "captureshark"
    assert "version" in body
    assert "environment" in body
