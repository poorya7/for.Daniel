"""Karaoke routes — implementation withheld from this code-review sample.

The router itself is preserved so `server.py` can mount it without
changes. Every handler responds 501 Not Implemented.

Original surface (6 handlers): full-video transcription, admin-gated
word-level, chunked karaoke (main path), short-video single-call
bypass, admin purge for takedown, and an operational stats endpoint.
"""

from fastapi import APIRouter, HTTPException, status

asr_provider_router = APIRouter()


def _not_in_sample() -> None:
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Karaoke module not included in this code sample.",
    )


@asr_provider_router.get("/api/karaoke-chunk")
async def karaoke_chunk() -> None:
    _not_in_sample()


@asr_provider_router.get("/api/karaoke-status")
async def karaoke_status() -> None:
    _not_in_sample()


@asr_provider_router.get("/api/karaoke-words-short")
async def karaoke_words_short() -> None:
    _not_in_sample()


@asr_provider_router.get("/api/admin/karaoke-words-full")
async def admin_karaoke_words_full() -> None:
    _not_in_sample()


@asr_provider_router.post("/api/admin/karaoke/purge")
async def admin_karaoke_purge() -> None:
    _not_in_sample()


@asr_provider_router.get("/api/admin/karaoke-chunk-cache-stats")
async def admin_karaoke_cache_stats() -> None:
    _not_in_sample()
