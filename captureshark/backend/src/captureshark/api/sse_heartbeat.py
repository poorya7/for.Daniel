"""Generic SSE heartbeat helper.

Wraps any synchronous bytes-producing iterator with periodic
"still alive" SSE frames, emitted whenever the underlying iterator
is slow to produce its next chunk. Used by routes that wrap a
long-running upstream call (LLM, OCR, etc.) inside a Server-Sent
Events response: without these heartbeats, the client has no way
to tell "upstream is just slow" from "TCP dropped, server's gone"
— and guess-based client-side watchdogs end up showing the user a
false *"No internet"* message during normal-but-slow operations.

Design:

  * Caller supplies a zero-arg factory returning a sync byte
    iterator (typically a generator function like
    `_photo_event_stream`).
  * Helper runs the factory in a worker thread via
    `asyncio.to_thread`, funnels every chunk through an
    `asyncio.Queue` back to the async loop.
  * Main coroutine `wait_for`s the queue with `interval_seconds`
    timeout. Each timeout yields a `HEARTBEAT_FRAME`. Each real
    chunk yields straight through. Exceptions raised by the inner
    iterator propagate.

The helper is generic on event vocabulary — heartbeats live under
their own event name (`heartbeat`) so domain consumers (text /
voice / photo / anything that wraps a slow upstream call in SSE)
ignore them with a single dispatch line.

Why pre-encoded bytes on the wire (not domain events): the
existing capture routes format their `StreamEvent`s into SSE
bytes via `_format_sse` BEFORE handing them to `StreamingResponse`.
This helper drops into that same byte layer, so it has zero
coupling to any specific domain event vocabulary. Voice + future
capture types adopt it by wrapping their sync generators in the
exact same one-liner the photo route uses.

Client side: see `frontend/src/lib/api.ts` — the SSE dispatcher
recognises the `heartbeat` event name and resets a client-side
watchdog timer on each one. Receiver code never has to "know"
about heartbeats beyond that.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from typing import Final

# Pre-encoded SSE frame. ~30 bytes on the wire. The data payload is
# an empty JSON object so the frame parses through the same client-
# side SSE parser used for real events — no special casing on the
# receiver beyond an event-name dispatch.
HEARTBEAT_FRAME: Final[bytes] = b"event: heartbeat\ndata: {}\n\n"

# 2-second interval matches the project's UX preference for snappy
# drop detection. Client-side watchdog is set at 3x this (~6s) so a
# single dropped heartbeat doesn't trip a false network error.
DEFAULT_HEARTBEAT_INTERVAL_SECONDS: Final[float] = 2.0


@dataclass(frozen=True, slots=True)
class _ExcSentinel:
    """Sentinel queue entry carrying an exception across the
    thread → event-loop boundary so the main coroutine can re-raise
    it cleanly."""

    exc: BaseException


class _DoneSentinel:
    """Marker class signalling "inner iterator exhausted cleanly."

    A bespoke class (rather than `None`) keeps the contract honest:
    callers whose inner iterator legitimately yields `None` won't
    have it confused with end-of-stream by accident. No current
    caller does, but this guards the future.
    """


_DONE: Final = _DoneSentinel()


async def with_heartbeat(
    sync_iter_factory: Callable[[], Iterator[bytes]],
    *,
    interval_seconds: float = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
) -> AsyncIterator[bytes]:
    """Wrap a sync bytes-iterator factory with periodic SSE heartbeats.

    Args:
        sync_iter_factory: Zero-arg callable returning an iterator
            of already-SSE-encoded byte chunks (one chunk = one
            frame). Invoked exactly once, in a worker thread.
        interval_seconds: How long to wait for the next inner chunk
            before yielding a heartbeat frame instead. Defaults to
            ``DEFAULT_HEARTBEAT_INTERVAL_SECONDS``.

    Yields:
        Every byte chunk the inner iterator produces, in order, PLUS
        a `HEARTBEAT_FRAME` whenever the inner iterator has been
        idle for `interval_seconds`. Order between real chunks is
        preserved; heartbeats only appear in the gaps.

    Raises:
        Whatever the inner iterator raises, re-raised on the async
        side after the worker thread exits. The wrapper handles its
        own cleanup either way.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes | _DoneSentinel | _ExcSentinel] = asyncio.Queue()

    def _drain() -> None:
        """Run the sync iterator on a worker thread, posting each
        chunk back to the asyncio queue via `call_soon_threadsafe`
        (the only thread-safe write path).

        On clean exhaustion posts `_DONE`. On any exception posts
        an `_ExcSentinel` wrapping the cause so the async side can
        re-raise it without losing the traceback.
        """
        try:
            for chunk in sync_iter_factory():
                loop.call_soon_threadsafe(queue.put_nowait, chunk)
            loop.call_soon_threadsafe(queue.put_nowait, _DONE)
        except BaseException as exc:  # noqa: BLE001
            loop.call_soon_threadsafe(queue.put_nowait, _ExcSentinel(exc))

    drain_task: asyncio.Task[None] = asyncio.create_task(
        asyncio.to_thread(_drain)
    )
    try:
        while True:
            try:
                item = await asyncio.wait_for(
                    queue.get(),
                    timeout=interval_seconds,
                )
            except TimeoutError:
                # Inner iterator hasn't produced a chunk for
                # `interval_seconds`. Emit a heartbeat to tell the
                # client "still working" and keep waiting — the
                # inner work is still in flight on the worker
                # thread.
                yield HEARTBEAT_FRAME
                continue
            if isinstance(item, _DoneSentinel):
                return
            if isinstance(item, _ExcSentinel):
                raise item.exc
            yield item
    finally:
        # If the consumer abandoned the iterator (client disconnect,
        # cancellation), the inner sync call is still running on the
        # worker thread — we can't actually cancel a sync HTTP call
        # mid-flight, but we DO need to drain any pending queue
        # writes so `call_soon_threadsafe` doesn't pile up posts
        # on a queue nobody's reading from.
        if not drain_task.done():
            while not queue.empty():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            # Best-effort await; if the worker thread is still
            # blocked in the upstream call we'll wait for it,
            # which is correct — letting it complete is cleaner
            # than orphaning a half-done HTTP request.
            try:
                await drain_task
            except BaseException:  # noqa: BLE001
                pass
