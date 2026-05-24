# pipeline/karaoke/

Word-level subtitle alignment ("karaoke" highlighting) for YouTube videos
whose published captions are missing or unreliable.

The full implementation is intentionally withheld from this code-review
sample — chunked transcription with cost-aware per-IP billing, partial
range-fetched audio backfill, and single-flight chunk deduplication. It's
the project's main differentiator.

Only the FastAPI router stub remains so the rest of the pipeline imports
cleanly. All endpoints respond `501 Not Implemented` at runtime.

The shape of the original module (split across `routes.py`,
`chunk_orchestrator.py`, `chunk_store.py`, `client.py`, `billing.py`,
`errors.py`, `_constants.py`, `stats.py`) is described at a high level in
`docs/_tech/REFACTORING_LESSONS.md`.
