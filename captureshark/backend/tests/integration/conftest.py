"""Shared per-test fixtures for the integration suite.

`reset_cost_cap_state` is the load-bearing one — the production
`CostCapMiddleware` holds in-process state (per-IP request buckets
+ daily spend total) on the instance, and the FastAPI app is a
module-level singleton. Without this reset, the 11th capture-route
hit from `testclient` (across ANY integration test file) gets 429'd
and downstream assertions break in confusing ways.

Tests that genuinely want to exercise the rate-limiter (e.g.
`test_cost_cap.py`) build their own isolated `FastAPI` app — they're
unaffected by this autouse fixture because it targets the global
`app`'s middleware stack only.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from captureshark.api.middleware.cost_cap import CostCapMiddleware
from captureshark.main import app


def _find_cost_cap_middleware() -> CostCapMiddleware | None:
    """Walk the live middleware chain to find the CostCapMiddleware
    instance attached to the global app.

    Starlette wraps middlewares as a nested chain via `app` attributes;
    we descend until we find the one we want or run out of layers. The
    chain isn't a stable public API but it's stable enough — and
    reaching the instance is the only way to reset its per-process
    state, which is the point of this fixture.
    """
    current: object = app.middleware_stack
    while current is not None:
        if isinstance(current, CostCapMiddleware):
            return current
        current = getattr(current, "app", None)
    return None


@pytest.fixture(autouse=True)
def reset_cost_cap_state() -> Iterator[None]:
    """Reset the cost-cap middleware's bucket state before each test.

    Runs as setup (before the test body) — not teardown — so tests
    can see the cleared state in their own assertions if they want
    to. After the test, no extra cleanup is needed; the next test's
    setup wipes whatever this one accrued.
    """
    middleware = _find_cost_cap_middleware()
    if middleware is not None:
        middleware._minute_hits.clear()
        middleware._hour_hits.clear()
        middleware._spend_today_usd = 0.0
    yield
