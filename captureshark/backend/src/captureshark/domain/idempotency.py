"""Idempotency-key persistence — the backstop against duplicate sheet rows.

Why this exists: the offline-resilient capture queue (see
`docs/_planning/offline_queue.md §7`) retries save attempts after
ambiguous failures (timeout, dropped connection). Without a server-side
dedupe, a retry that succeeds on the second try after the FIRST try
actually wrote the row will produce two rows in the user's sheet —
a silent data-quality regression that's hard to detect after the fact.

The cure: the client generates a stable `idempotency_key` (uuid v4) at
submit time and sends it on every retry of the same logical save. The
backend records the key + the response it returned the first time;
replays hit the cache and short-circuit to the same response.

Scoping: keys are scoped per `user_id`. Two different users using the
same uuid (collision is astronomically unlikely with v4, but defence
in depth) are treated as two different requests.

What we cache: ONLY HTTP 200 success responses. Failures are not
cached because (a) the most common cause of a retry is the client
not having seen the response, and (b) caching failures would block
legitimate recovery paths (user re-auths, restores a deleted sheet,
fixes a column mapping) from working on the second attempt. See plan
§7 commentary for the full rationale.

This module is the *domain* surface — pure value types + a Protocol
port. The SQLite implementation lives in `adapters/`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol


@dataclass(frozen=True, slots=True)
class CachedResponse:
    """One previously-returned response we'll replay on key hits.

    Fields:
      status: HTTP status code (always 200 in v1; the field is here
              for forwards compatibility if we ever decide to cache
              permanent-failure responses too).
      body_json: serialised response body. Stored as text so the
              route layer can hand it straight back to the client
              without re-serialising through Pydantic.
    """

    status: int
    body_json: str


class IdempotencyStorePort(Protocol):
    """Adapter port the route layer uses to dedupe replays.

    Two operations:
      * `lookup` — has this (key, user) tuple been seen, and not yet
        expired? Returns the cached response if so, `None` otherwise.
      * `record` — stash the response we just returned, so a future
        replay hits the cache.

    A third operation (`sweep_expired`) is exposed so the lifespan
    handler or a periodic task can prune rows that have aged out;
    `lookup` is also expiry-aware (it ignores rows past their TTL) so
    correctness doesn't depend on the sweep being timely.
    """

    async def lookup(
        self,
        key: str,
        user_id: int,
    ) -> CachedResponse | None: ...

    async def record(
        self,
        key: str,
        user_id: int,
        response: CachedResponse,
        expires_at: datetime,
    ) -> None: ...

    async def sweep_expired(self, now: datetime) -> int: ...
