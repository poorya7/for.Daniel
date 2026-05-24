"""Coarse-grained rate limiting primitive for outbound HTTP.

General-purpose infrastructure (NOT karaoke-specific): any caller that needs
to stay under a vendor's per-second / per-minute call ceiling can wrap their
HTTP calls with `AsyncTokenBucket.acquire()`.

Single-worker only — multi-worker would need a Redis/Postgres-backed
equivalent.
"""
import asyncio
import time


class AsyncTokenBucket:
    """Token bucket. Refills `rate_per_sec` tokens per second up to `capacity`.
    `acquire()` waits until a token is available. Thread-safe via the asyncio
    Lock — single-worker only.
    """

    def __init__(self, rate_per_sec: float, capacity: int):
        self.rate_per_sec = rate_per_sec
        self.capacity = capacity
        self.tokens = float(capacity)
        self.updated_at = time.monotonic()
        self.lock = asyncio.Lock()

    async def acquire(self) -> None:
        while True:
            async with self.lock:
                now = time.monotonic()
                elapsed = now - self.updated_at
                self.tokens = min(self.capacity, self.tokens + elapsed * self.rate_per_sec)
                self.updated_at = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                wait_s = (1 - self.tokens) / self.rate_per_sec
            # Sleep OUTSIDE the lock so other coroutines can keep accumulating
            # token-update work without serializing on this one waiter.
            await asyncio.sleep(wait_s)
