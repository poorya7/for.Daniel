"""Vision domain — pure types for image → structured-fields extraction.

The photo capture path takes a normalized image and produces zero, one,
or many extracted lead rows. This module defines the boundary between
"clean image bytes ready for the model" and "structured field data
ready for the review surface."

Adapters live in `adapters/` (e.g. `OpenAIVisionExtractor`); the
preprocessor that produces the clean bytes lives next to those
adapters as a module (not a Port — single implementation, no swap
need yet — promote to a Port when a second implementation materialises).

**Asymmetry vs the voice pipeline (deliberate):** the vision adapter
does OCR-equivalent reading AND structured extraction in a single
model call. Voice splits these (`TranscriberPort` produces text,
`ExtractorPort` extracts structured fields from that text). The vision
case keeps them merged because handing a structured-output prompt to
the vision model directly preserves spatial cues (table layout,
handwriting confidence per cell, crossed-out content) that an
intermediate text-only step would discard. Don't "fix" this asymmetry
later — it's load-bearing.

**Multi-row from day one:** photos can naturally contain many leads
(a sign-in sheet) even when the step-7 UI only displays one. The
domain shape is multi-row-capable from day one; the step-7 service
adapts to single-row at the application boundary (picks the
highest-confidence row, emits a non-terminal `StreamWarning` to
explain the situation, drops the rest). Step 8 will consume the
photo-level result natively without that reduction.

**Streaming model:** the port is NON-streaming. It returns a single
`PhotoExtractionOutcome`. The service that orchestrates the route
emits deterministic SSE deltas wrapping the result (one delta per
field, in canonical order, with small inter-field pauses for UX
feel). This keeps the wire-level streaming contract identical to
text + voice while sidestepping the fragile-partial-JSON problem of
parsing upstream vision-model token streams.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

from captureshark.domain.extraction import (
    Confidence,
    ExtractedFields,
    ExtractionError,
)


@dataclass(frozen=True, slots=True)
class PhotoExtractionRow:
    """One row extracted from a photo.

    `source_text` is the OCR-equivalent text the row was extracted
    from when the vision pipeline surfaces it (useful for the salvage
    path — *"save the original note as a row anyway?"* — and for the
    Recent Captures original-input display in step 9). May be `None`
    when the vision adapter doesn't return per-row source text.

    `row_index` is the row's 0-based position in the source photo,
    set for multi-row sign-in-sheet extractions. `None` for
    single-record photos (business cards, handwritten notes).

    `confidence` is a row-level aggregate signal — the model's
    overall read of "did I get this row right?", distinct from the
    per-field `Confidence` values inside `fields`. Used by step 8's
    sort/triage logic ("show the iffy rows first").

    `warnings` carries per-row issues the model surfaced — e.g.
    *"couldn't read phone clearly"*, *"two plausible spellings of
    name — picked the more common one"*. Step 8's iffy-row carousel
    surfaces these next to the field; step 7 ignores them on the
    discarded rows but surfaces them as part of the kept row's
    review-card.
    """

    fields: ExtractedFields
    source_text: str | None = None
    row_index: int | None = None
    confidence: Confidence = Confidence.MEDIUM
    warnings: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True, slots=True)
class PhotoExtractionResult:
    """Photo-level extraction outcome — multi-row-capable.

    `rows` is the full set of extracted rows. The order MUST be
    stable (top-to-bottom, left-to-right for a sign-in sheet) so the
    service's single-row reduction rule has a deterministic pick and
    step 8's review carousel orders rows the way the user sees them
    in the photo.

    `image_summary` is an optional one-line description of what the
    model thinks the photo is (*"a paper sign-in sheet with 4
    columns"*, *"a business card"*). Used by step 8 for the status
    banner — *"Found 24 names on this sign-in sheet"*. Step 7 ignores
    it. None when the adapter doesn't produce one.

    `warnings` carries photo-level issues the model surfaced — e.g.
    *"image was crooked, results may be partial"*, *"some rows were
    cropped off the edge"*. The service forwards these as
    non-terminal `StreamWarning` events the frontend renders as
    calm in-flow explainers.
    """

    rows: tuple[PhotoExtractionRow, ...]
    image_summary: str | None = None
    warnings: tuple[str, ...] = field(default_factory=tuple)


# Discriminated outcome union — same shape as `ExtractionOutcome`,
# differs in the success type only. Callers `match` without
# `isinstance` towers; mypy --strict is happy.
PhotoExtractionOutcome = (
    tuple[Literal["ok"], PhotoExtractionResult]
    | tuple[Literal["error"], ExtractionError]
)


@runtime_checkable
class VisionExtractorPort(Protocol):
    """Adapter interface: turns a normalized image into a photo-level
    extraction result.

    The image bytes MUST already have passed through the image
    preprocessor (mandatory normalization — EXIF orientation, HEIC
    decode, JPEG conversion, metadata strip, dimension cap). Adapters
    do NOT re-preprocess; if the bytes look wrong, that's a
    programmer error in the call site, not an error-as-data case.

    Implementations MUST return an outcome; they MUST NOT raise on
    upstream failure (timeouts, rate limits, malformed responses,
    safety-classifier refusals). Those become
    `("error", ExtractionError(...))`. Programmer errors still
    bubble — those aren't error-as-data, they're bugs.

    The model call is non-streaming end-to-end (see module docstring
    for why). For the per-field reveal UX, the service that consumes
    this port emits deterministic SSE deltas wrapping the result.

    `provider_name` is the short identifier the adapter answers to on
    the wire — `"docai"`, `"openai"`, etc. The service stamps it into
    the terminal `photo_done` SSE event so the frontend (and our
    telemetry, when it lands) can tell which adapter produced the
    result. Keep it kebab-case and stable; renaming breaks the
    additive-only wire contract.
    """

    provider_name: str

    def extract_from_image(
        self, image: bytes, content_type: str
    ) -> PhotoExtractionOutcome:
        """Extract zero, one, or many lead rows from a normalized image.

        `content_type` is the post-normalization content-type
        (typically `image/jpeg` after the preprocessor runs). It's
        passed through for adapter-internal use (e.g. setting the
        right MIME on the multipart body the adapter sends upstream).
        """
        ...
