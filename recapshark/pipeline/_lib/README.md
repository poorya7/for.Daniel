# pipeline/_lib/

Shared infrastructure primitives — general-purpose pieces used across multiple
backend domains (analytics / karaoke / transcript / etc.). Anything
domain-specific belongs in its own subpackage; `_lib/` is for the cross-cutting
utility layer.

The leading underscore signals "internal infrastructure, not a public API
surface." Callers within `pipeline/` import freely (`from pipeline._lib.rate_limit
import AsyncTokenBucket`); nothing outside `pipeline/` should reach in here.

## Per-file responsibilities

| File | Owns |
|---|---|
| `rate_limit.py` | `AsyncTokenBucket` — coarse-grained per-second / per-minute call ceiling for any outbound HTTP. Used by karaoke's AsrProvider client today; future OpenAI / Google Translate clients should reuse it instead of redefining their own. **Single-worker only** (D22) — multi-worker needs a Redis/Postgres-backed equivalent. |
| `__init__.py` | Re-exports `AsyncTokenBucket` for short import paths (`from pipeline._lib import AsyncTokenBucket`). |

## When to add a new file here

A new module belongs in `_lib/` when **all** of these hold:

- It's pure infrastructure (no domain knowledge: doesn't know about karaoke,
  analytics, transcripts, etc.)
- It's reusable across at least 2 domains (or there's a clear roadmap to a
  second consumer)
- It can be tested in isolation — no implicit coupling to a specific domain's
  state

If you're tempted to put domain-specific helpers here ("just temporarily"),
that's the signal to put them in the relevant domain subpackage instead.

## Cycle history

- **Cycle 6** (2026-05-06): created during the asr_provider_routes split. `AsyncTokenBucket`
  moved out of the karaoke chunk-loader into `_lib/rate_limit.py` because rate
  limiting has nothing to do with audio transcription specifically.
