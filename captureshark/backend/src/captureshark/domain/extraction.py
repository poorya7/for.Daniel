"""Extraction domain — pure types describing what AI extraction produces.

This module has no dependencies on adapters, frameworks, or I/O. It defines:

  * The canonical set of fields v1 extracts from a lead capture.
  * A plain-English confidence label per field (per the v1 sketch — confidence
    is shown as words like "Check this", never colored dots).
  * `ExtractionResult` — the success-shape of an extraction run.
  * `ExtractionError` — the error-shape (errors as data, not exceptions, per
    the tech plan).
  * `ExtractorPort` — the Protocol adapters implement. Services depend on
    this interface; the OpenAI adapter is one implementation.

Adding a new field = add it to `LeadFieldName` and `ExtractedFields`. The
adapter prompt and the API schema both pivot off these types.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal, Protocol, runtime_checkable


class LeadFieldName(StrEnum):
    """The canonical fields v1 extracts from a single lead.

    Order matters — this is also the default display order on the review card.

    Field ordering rationale (3-page review layout, 4 fields each):

    * **Page 1 (Contact + qualifying signal):** name, phone, email, has_agent.
      The top three are the no-which-lead-is-this contact triple; has_agent
      lives on page 1 because it's the binary qualification field brokers ask
      about up-front at open houses (NAR ethics: you can't pursue a
      represented buyer), AND the corner agent-status ribbon reads off it —
      so the value needs to be on the first page a broker sees.
    * **Page 2 (Intent + prioritisation):** intent, timeline,
      financing_status, budget. These four are the broker-prioritisation
      signals: who is this person (buyer/seller/both/browsing), how soon are
      they moving, can they pay, and how much. Budget is single-line free
      text (e.g. "500-600k") so it lives with the structured prioritisation
      fields rather than the long-form preferences.
    * **Page 3 (Preferences + follow-up):** area, follow_up, notes. The
      free-form long-tail fields where the broker captures location
      preferences, what they'll do next, and any voice-memo flavour.

    intent / timeline / financing_status are CONSTRAINED enums — the LLM is
    instructed to return one of a fixed set of plain-language tokens. They
    render as multi-option pickers (an extension of the binary has_agent
    pattern) rather than free-text editors.
    """

    NAME = "name"
    PHONE = "phone"
    EMAIL = "email"
    HAS_AGENT = "has_agent"
    INTENT = "intent"
    TIMELINE = "timeline"
    FINANCING_STATUS = "financing_status"
    BUDGET = "budget"
    AREA = "area"
    FOLLOW_UP = "follow_up"
    NOTES = "notes"


# Allowed enum values for the constrained prioritisation fields. Kept here
# next to the canonical field list so the LLM prompt builder, the column
# mapper, the review-card picker UI, and tests all read off the same source
# of truth.
#
# `intent` — what is this person here for? "browsing" captures the
#   "they just wandered in, no real intent yet" case so the broker can
#   triage out of it later.
# `timeline` — when do they expect to move? Friend's original spec
#   included "browsing" as a 5th value, but that duplicates the intent
#   field's "browsing" value and reads as a contradiction (a "browsing
#   timeline" makes no sense — timeline answers "by when?"). Dropped to
#   four buckets that map cleanly to broker prioritisation.
# `financing_status` — can they actually buy? Cash is gold,
#   pre-approved is hot, needs_lender is "follow up with mortgage
#   referral", unknown is "don't know yet, ask later".
INTENT_VALUES: tuple[str, ...] = ("buyer", "seller", "both", "browsing")
TIMELINE_VALUES: tuple[str, ...] = ("now", "3mo", "6mo", "12mo+")
FINANCING_STATUS_VALUES: tuple[str, ...] = (
    "cash",
    "pre_approved",
    "needs_lender",
    "unknown",
)


class Confidence(StrEnum):
    """Plain-English confidence labels.

    The values map directly to the user-facing review-card copy. `HIGH` shows
    no label (clean field reads as trusted); `MEDIUM` and `LOW` surface the
    labels next to the value.
    """

    HIGH = "high"  # → no label shown
    MEDIUM = "medium"  # → "Check this"
    LOW = "low"  # → "Couldn't read this"


@dataclass(frozen=True, slots=True)
class ExtractedField:
    """One extracted field with its confidence and any alternative guesses.

    `value` is `None` when the model couldn't extract anything for this field
    (e.g., the user's note never mentioned a phone number). Empty strings are
    normalised to `None` at the adapter boundary so domain code can rely on
    "missing means None."

    `alternatives` is the list of runner-up guesses the model considered.
    Used by the review screen's tap-to-fix-with-5-guesses pattern. Empty when
    the model only had one candidate or the field is high-confidence.
    """

    value: str | None
    confidence: Confidence
    alternatives: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True, slots=True)
class ExtractedFields:
    """The full set of extracted fields for one captured lead.

    Each field is always present (even if its `value` is `None`), so callers
    can render the full review card without conditional key checks.
    """

    name: ExtractedField
    phone: ExtractedField
    email: ExtractedField
    has_agent: ExtractedField
    intent: ExtractedField
    timeline: ExtractedField
    financing_status: ExtractedField
    budget: ExtractedField
    area: ExtractedField
    follow_up: ExtractedField
    notes: ExtractedField

    def as_mapping(self) -> Mapping[LeadFieldName, ExtractedField]:
        """Return the fields keyed by their canonical name. Iteration order
        follows `LeadFieldName`."""
        return {
            LeadFieldName.NAME: self.name,
            LeadFieldName.PHONE: self.phone,
            LeadFieldName.EMAIL: self.email,
            LeadFieldName.HAS_AGENT: self.has_agent,
            LeadFieldName.INTENT: self.intent,
            LeadFieldName.TIMELINE: self.timeline,
            LeadFieldName.FINANCING_STATUS: self.financing_status,
            LeadFieldName.BUDGET: self.budget,
            LeadFieldName.AREA: self.area,
            LeadFieldName.FOLLOW_UP: self.follow_up,
            LeadFieldName.NOTES: self.notes,
        }


@dataclass(frozen=True, slots=True)
class ExtractionResult:
    """Success-shape of an extraction run.

    `original_text` is the text the extractor was given (post-transcription
    for voice; identical to user input for text). Carrying it through means
    the salvage path ("save the original note as a row anyway") doesn't need
    to plumb it separately.
    """

    fields: ExtractedFields
    original_text: str


class ExtractionErrorKind(StrEnum):
    """Coarse error categories the API layer maps to user-facing copy.

    Adding a kind = adding a copy mapping in the API layer. The domain stays
    free of HTTP / UI concerns.
    """

    EMPTY_INPUT = "empty_input"  # Caller submitted no text.
    NO_SIGNAL = "no_signal"  # Input had no extractable signal (e.g. "um", a
    # Whisper hallucination on silence like "Thank you for watching"). Distinct
    # from EMPTY_INPUT — the user did submit *something*, it just wasn't
    # extraction-worthy. UI treats this as a graceful re-record prompt, not
    # an error.
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"  # OpenAI down / network.
    UPSTREAM_RATE_LIMITED = "upstream_rate_limited"
    UPSTREAM_INVALID_RESPONSE = "upstream_invalid_response"  # JSON malformed.
    UNEXPECTED = "unexpected"  # Anything else; bug-shaped.

    # --- Photo-path-specific kinds (step 7).
    # Distinct from UPSTREAM_INVALID_RESPONSE so the client (and our
    # debugging) can tell "user gave us bad bytes" from "the vision API
    # returned malformed JSON". The latter is an upstream bug; the
    # former is a user-input problem with different recovery copy.
    IMAGE_TOO_LARGE = "image_too_large"  # Blob exceeded the upload byte cap.
    UNSUPPORTED_IMAGE = "unsupported_image"  # Magic-number sniff failed or format not in supported set.
    IMAGE_DECODE_FAILED = "image_decode_failed"  # Bytes were present, decoder threw.
    IMAGE_TOO_SMALL = "image_too_small"  # Decoded dimensions below floor (~200x200).
    IMAGE_PREPROCESS_FAILED = "image_preprocess_failed"  # EXIF / HEIC / normalize step threw an unexpected error.
    IMAGE_MODERATION_REFUSED = "image_moderation_refused"  # Vision API safety classifier rejected the image.


@dataclass(frozen=True, slots=True)
class ExtractionError:
    """Error-shape of an extraction run.

    Domain code treats errors as values, not exceptions, so the success path
    stays pure and adapters carry the burden of catching upstream noise.
    """

    kind: ExtractionErrorKind
    detail: str


# Discriminated union so callers `match` on the outcome without isinstance
# towers. Mypy --strict is happy with this shape.
ExtractionOutcome = (
    tuple[Literal["ok"], ExtractionResult] | tuple[Literal["error"], ExtractionError]
)


@dataclass(frozen=True, slots=True)
class StreamDelta:
    """Incremental content fragment from a streaming extraction call.

    `content` is the raw fragment as the upstream model emits it — not
    necessarily a complete JSON token. The frontend accumulates these and
    parses progressively (using a tolerant partial-JSON parser) so
    individual fields can render the moment they're complete in the buffer.
    """

    content: str


@dataclass(frozen=True, slots=True)
class StreamWarning:
    """Non-terminal advisory event emitted during a stream.

    Distinct from `StreamError` (which is terminal — the stream stops
    after one). A warning communicates something the user should know
    (e.g. "multiple leads detected in a photo we only review one of in
    this version") while the extraction itself still succeeds.

    The frontend renders warnings as calm in-flow explainers, not as
    error states. `code` is the machine-readable identifier the route
    layer maps to user-facing copy; `message` carries the plain-English
    text if no mapping exists for the code.

    The contract is strict: warnings MUST appear BEFORE the terminal
    `done` / `error` event in the stream, and never AFTER one.
    """

    code: str
    message: str


@dataclass(frozen=True, slots=True)
class PhotoRowPayload:
    """One extracted row, ready for a `photo_row` SSE event.

    Photo capture has its own per-row event vocabulary so the multi-row
    review UI can paint rows progressively as they're parsed (and so the
    offline-queue path can dedupe row-level saves via the per-row
    idempotency key). See `docs/_spec/photo_capture.md`
    for the locked wire contract.

    `row_index` is the zero-based, dense, monotonic position of this
    row in the source photo. Document reading order — never reordered
    by the service.

    `idempotency_key` is server-generated and deterministic across
    retries: `<capture_id>:<row_index>:<sha8_of_canonical_fields>`.
    Built via `photo_row_idempotency_key()` so callers can't drift the
    format. The offline-queue drainer hashes the same triple
    independently and only writes one row per unique key, surviving
    flaky-network retries from any layer of the stack.

    `row_confidence` is the aggregated row-level signal — min of the
    contact-triple (name / phone / email) per-field confidences,
    blank fields ignored. Drives the green-check vs amber-warning
    indicator on the multi-row summary surface.

    `warnings` carries per-row issues the model surfaced — e.g.
    "couldn't read phone clearly". Step C's per-row edit surface
    renders the relevant warning next to the suspect field.
    """

    row_index: int
    idempotency_key: str
    fields: ExtractedFields
    row_confidence: Confidence
    warnings: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True, slots=True)
class PhotoDonePayload:
    """Terminal payload for the `photo_done` SSE event.

    `status`:
      * `"ok"` — all rows parsed cleanly.
      * `"partial"` — some rows parsed; one or more rows failed
        mid-stream. `warnings` carries codes naming what failed.
      * `"no_signal"` — extraction ran, found zero readable rows.
        Slice B's failure overlay surfaces from this status (NOT
        from an `error` event — `error` is reserved for hard failures
        like network/upstream).

    `total_rows` lets the client validate against the number of
    `photo_row` events it actually received (catches a dropped event).

    `provider` is the vision adapter that answered (`"docai"` today;
    new values when the v2 LLM fallback lands).

    `warnings` carries batch-level advisory codes (string codes only;
    empty tuple on the clean path).

    The contract is strict (see 04_REFERENCE.md):
      * Terminal event always emitted (`photo_done` OR `error`).
      * Single-row case uses the same wire (one `photo_row` + one
        `photo_done`).
      * Additive-only versioning — optional fields may be added; never
        renamed or removed without a new event name.
    """

    status: Literal["ok", "partial", "no_signal"]
    total_rows: int
    provider: str
    warnings: tuple[str, ...] = field(default_factory=tuple)


def photo_row_idempotency_key(
    capture_id: str, row_index: int, fields: ExtractedFields
) -> str:
    """Build the deterministic per-row idempotency key.

    Format: `<capture_id>:<row_index>:<sha8_of_canonical_fields>`.
    Stable across retries because the inputs are stable across retries.

    `fields` is canonicalised as JSON with sorted keys before hashing
    so two clients producing the same logical row always get the same
    key (no whitespace / ordering drift). Truncated to 8 hex chars —
    enough entropy to disambiguate rows within a single capture, short
    enough to embed in URLs cleanly.
    """

    mapping = fields.as_mapping()
    canonical = json.dumps(
        {name.value: mapping[name].value for name in LeadFieldName},
        sort_keys=True,
        separators=(",", ":"),
    )
    sha = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:8]
    return f"{capture_id}:{row_index}:{sha}"


# Discriminated stream-event union. Adapters yield one of these per chunk
# until the stream ends; routes translate them to SSE frames; the frontend
# pattern-matches and updates state.
#
# Per-source vocabularies:
#   * text + voice — emit `delta` (progressive token deltas), then
#     terminal `done` (single-row `ExtractionResult`) or `error`.
#   * photo — emits `photo_warning` (non-terminal advisory), `photo_row`
#     (one per extracted row, document reading order), then terminal
#     `photo_done` (batch-level metadata + status) or `error`. Photo
#     does NOT emit `delta` or `done` — its review surface is multi-row.
#
# `delta` / `photo_row` / `photo_warning` are non-terminal — any number
# may appear in a stream. `done` / `photo_done` / `error` are terminal —
# exactly one ends every stream, and no events follow.
StreamEvent = (
    tuple[Literal["delta"], StreamDelta]
    | tuple[Literal["done"], ExtractionResult]
    | tuple[Literal["error"], ExtractionError]
    | tuple[Literal["photo_row"], PhotoRowPayload]
    | tuple[Literal["photo_done"], PhotoDonePayload]
    | tuple[Literal["photo_warning"], StreamWarning]
)


@runtime_checkable
class ExtractorPort(Protocol):
    """Adapter interface: turns raw user-supplied text into structured fields.

    Implementations live in `adapters/`. Services depend on this Protocol so
    tests can swap in fakes without spinning up real LLM calls.
    """

    def extract_from_text(self, text: str) -> ExtractionOutcome:
        """Extract lead fields from a free-form text note (non-streaming).

        Implementations MUST return a result; they MUST NOT raise on upstream
        failure (timeouts, rate limits, malformed responses) — those become
        `("error", ExtractionError(...))`. Programmer errors (assertion
        violations, type mismatches in our own code) are still allowed to
        bubble; they're not error-as-data, they're bugs.
        """
        ...

    def stream_from_text(self, text: str) -> Iterator[StreamEvent]:
        """Streaming variant of `extract_from_text`.

        Yields `("delta", StreamDelta(content))` events as the upstream model
        emits content fragments. Terminates with exactly one `("done", ...)`
        on success or `("error", ...)` on failure. After that terminal event,
        the iterator stops — callers SHOULD NOT keep polling.

        Same error contract as `extract_from_text`: recoverable upstream
        failure becomes an `("error", ...)` event, not an exception.
        """
        ...
