"""Tests for the generic SSE heartbeat helper.

Each test wraps a known-shape sync iterator in `with_heartbeat`
and asserts the resulting async stream produces the expected
interleaving of real chunks + heartbeat frames.

Time-based assertions use a short heartbeat interval (50ms) so
the suite stays fast — `asyncio.wait_for`'s timeout granularity
is well-behaved at that scale.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator

import pytest

from captureshark.api.sse_heartbeat import (
    HEARTBEAT_FRAME,
    with_heartbeat,
)


# ────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────


async def _collect(stream: object) -> list[bytes]:
    """Drain an async iterator into a list. Test-only convenience."""
    out: list[bytes] = []
    async for chunk in stream:  # type: ignore[misc]
        out.append(chunk)
    return out


# ────────────────────────────────────────────────────────────────
# Happy paths
# ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fast_iterator_yields_no_heartbeats() -> None:
    """When the inner iterator produces every chunk immediately,
    no heartbeats should appear between them."""

    def _factory() -> Iterator[bytes]:
        yield b"event: photo_row\ndata: {\"row\":1}\n\n"
        yield b"event: photo_row\ndata: {\"row\":2}\n\n"
        yield b"event: photo_done\ndata: {}\n\n"

    out = await _collect(with_heartbeat(_factory, interval_seconds=0.5))

    assert HEARTBEAT_FRAME not in out
    assert len(out) == 3
    assert out[0].startswith(b"event: photo_row")
    assert out[2].startswith(b"event: photo_done")


@pytest.mark.asyncio
async def test_empty_iterator_completes_cleanly() -> None:
    """An iterator that produces zero chunks should complete the
    async stream cleanly (no chunks, no error)."""

    def _factory() -> Iterator[bytes]:
        return
        yield  # unreachable — marks function as a generator

    out = await _collect(with_heartbeat(_factory, interval_seconds=0.5))

    assert out == []


# ────────────────────────────────────────────────────────────────
# Heartbeat interleaving
# ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_slow_iterator_interleaves_heartbeats() -> None:
    """When the inner iterator pauses between chunks, heartbeats
    should appear in the gaps. Concrete scenario: one chunk after
    a 250ms pause, with a 50ms heartbeat interval → at least 3
    heartbeats before the chunk arrives."""

    def _factory() -> Iterator[bytes]:
        time.sleep(0.25)
        yield b"event: photo_done\ndata: {}\n\n"

    out = await _collect(with_heartbeat(_factory, interval_seconds=0.05))

    # The trailing real chunk MUST be there.
    assert out[-1] == b"event: photo_done\ndata: {}\n\n"

    # Heartbeats fill the gap before it. With 250ms pause / 50ms
    # interval, expect 3+ heartbeats. Bound loosely to tolerate
    # scheduler jitter on slow CI runners.
    heartbeats = [c for c in out if c == HEARTBEAT_FRAME]
    assert len(heartbeats) >= 3, (
        f"Expected ≥3 heartbeats, got {len(heartbeats)}; full stream: {out!r}"
    )

    # Real chunks and heartbeats appear in the right ORDER — every
    # heartbeat comes before the real chunk, never after.
    real_chunk_index = out.index(b"event: photo_done\ndata: {}\n\n")
    for hb in heartbeats:
        assert out.index(hb) < real_chunk_index


@pytest.mark.asyncio
async def test_chunks_in_quick_succession_pass_through_in_order() -> None:
    """Three chunks emitted at < interval-apart should all reach
    the consumer in order, with no heartbeats interleaved."""

    def _factory() -> Iterator[bytes]:
        for i in range(3):
            yield f"event: photo_row\ndata: {{\"row\":{i}}}\n\n".encode()

    out = await _collect(with_heartbeat(_factory, interval_seconds=0.5))

    assert out == [
        b"event: photo_row\ndata: {\"row\":0}\n\n",
        b"event: photo_row\ndata: {\"row\":1}\n\n",
        b"event: photo_row\ndata: {\"row\":2}\n\n",
    ]


# ────────────────────────────────────────────────────────────────
# Error propagation
# ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_inner_exception_propagates() -> None:
    """An exception raised mid-iteration in the sync factory should
    surface as an exception on the async side — not get swallowed
    or replaced with a heartbeat."""

    class _MyError(RuntimeError):
        pass

    def _factory() -> Iterator[bytes]:
        yield b"event: photo_row\ndata: {\"row\":0}\n\n"
        raise _MyError("upstream went sideways")

    received: list[bytes] = []
    with pytest.raises(_MyError, match="upstream went sideways"):
        async for chunk in with_heartbeat(_factory, interval_seconds=0.5):
            received.append(chunk)

    # The pre-exception chunk should have made it through.
    assert received == [b"event: photo_row\ndata: {\"row\":0}\n\n"]


@pytest.mark.asyncio
async def test_immediate_exception_propagates() -> None:
    """An exception raised before the iterator yields ANY chunks
    should still propagate cleanly (no chunks, then raise)."""

    def _factory() -> Iterator[bytes]:
        raise RuntimeError("nothing to give you")
        yield  # unreachable

    with pytest.raises(RuntimeError, match="nothing to give you"):
        async for _ in with_heartbeat(_factory, interval_seconds=0.5):
            pass


# ────────────────────────────────────────────────────────────────
# Heartbeat frame shape
# ────────────────────────────────────────────────────────────────


def test_heartbeat_frame_is_well_formed_sse() -> None:
    """The pre-encoded heartbeat frame must parse as a valid SSE
    frame so the client's existing frame parser handles it without
    special-casing."""

    text = HEARTBEAT_FRAME.decode("utf-8")
    # Frame separator
    assert text.endswith("\n\n")
    # Has both `event:` and `data:` lines (the client's parser
    # rejects frames missing either).
    assert "event: heartbeat\n" in text
    assert "data: " in text
    # The data payload is valid JSON — `{}` parses to an empty dict.
    data_line = text.split("\n")[1]
    payload_text = data_line[len("data: "):]
    assert payload_text == "{}"
