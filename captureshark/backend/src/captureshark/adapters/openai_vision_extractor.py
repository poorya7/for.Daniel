"""OpenAI vision adapter — GPT-5 + minimal-reasoning + people-shape prompt.

Implements `VisionExtractorPort.extract_from_image` against OpenAI's
Chat Completions API using the GPT-5 family with the v1.3.1 prompt.

Why this exact shape (locked 2026-05-17 after sessions 01-09 measuring
on the structural test corpus):

  * **Chat Completions, not Responses API.** The eval harness in
    `docs/_tests/prompt_eval/prompt_eval.py` measured 98% accuracy / 2.4 s p50
    using `client.chat.completions.create()` with `response_format=
    {"type": "json_object"}` + `reasoning_effort="minimal"`. Production
    uses the same surface so production behavior matches the measured
    behavior. Switching to the Responses API later is a measurement
    cost (must re-eval to confirm parity); not worth the swap.

  * **GPT-5 `reasoning_effort="minimal"`.** Round-3 reviewer (Opus 4.7)
    flagged that GPT-5 defaults to "think carefully" mode under the
    API while the consumer ChatGPT app runs minimal-reasoning. We
    were paying ~28 s/photo for reasoning we didn't need. Setting
    minimal cut p50 latency from 30.7 s → 2.8 s with zero accuracy
    change. See `docs/_tables/01_photo_extraction/04_reasoning_minimal_BIG_WIN.md`.

  * **`response_format={"type": "json_object"}`, not json_schema strict
    mode.** The v1.3.1 prompt's output shape is trivial
    (`{"people": [{"name","phone","email"}]}`); strict-schema mode adds
    no value over `json_object` for a flat list of three nullable
    strings, and json_object is the surface the eval validated against.

  * **No `temperature` parameter.** The eval didn't pass one; the
    minimal-reasoning model is deterministic enough for our case. Don't
    add `temperature=0` without re-measuring — there have been versions
    where setting it on a reasoning-tier model affects throughput.

Output mapping (the adapter is the seam between the simple `{name,
phone, email}` shape the LLM returns and the multi-field
`PhotoExtractionRow` the downstream service + review UI expect):

  * Each `{name, phone, email}` becomes one `PhotoExtractionRow`. The
    other 8 lead fields (`has_agent`, `intent`, `timeline`,
    `financing_status`, `budget`, `area`, `follow_up`, `notes`) are
    null with LOW confidence — the photo path simply doesn't extract
    them. Review UI renders nulls calmly as "(no X)".

  * Per-field confidence: HIGH when the model emitted a value, LOW
    when null. The v1.3.1 prompt's Rule 2 ("ZERO GUESSING — if any
    part is illegible, return null") is the load-bearing reason — any
    non-null value passed the model's confidence gate, so HIGH is
    honest, not optimistic.

  * Row-level confidence: HIGH whenever at least one contact field
    is present (Rule 7's emission gate guarantees this for every
    emitted row). The review-card amber treatment is reserved for
    actual uncertainty the model surfaces, which the v1.3.1 prompt
    deliberately doesn't.

  * `source_text` is a "|"-joined recap of the three contact fields,
    matching the offline-queue + Recent-Captures expectation that
    every row carries a human-readable trail. `row_index` is the
    0-based position in the photo (top-to-bottom per Rule 10).

  * Photo-level `image_summary` is `None` (the prompt doesn't ask for
    one; the review surface's status banner falls back to a row-count
    summary). `warnings` is empty.

Logging discipline:
  * Structural metadata only (bytes-in, row count, error kind).
  * NEVER log extracted values (name / phone / email).
  * NEVER log the raw model response (carries the same PII).
"""

from __future__ import annotations

import base64
import json
import logging
from pathlib import Path
from typing import Any, Final, Literal, cast

from openai import APIConnectionError, APIError, APITimeoutError, OpenAI, RateLimitError
from openai.types.chat import (
    ChatCompletionContentPartImageParam,
    ChatCompletionMessageParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionUserMessageParam,
    completion_create_params,
)
from openai.types.shared_params import ResponseFormatJSONObject

from captureshark.domain.extraction import (
    Confidence,
    ExtractedField,
    ExtractedFields,
    ExtractionError,
    ExtractionErrorKind,
)
from captureshark.domain.vision import (
    PhotoExtractionOutcome,
    PhotoExtractionResult,
    PhotoExtractionRow,
)

logger = logging.getLogger(__name__)

# Pinned model. Bumping the model name is a default-model swap
# (Rule #0 territory: needs project-owner sign-off). Locked to gpt-5
# on 2026-05-17 after the latency + accuracy hunt
# (sessions 01-09 + reports 01-05).
_MODEL: Final = "gpt-5"

# Locked alongside the model. The eval harness measured 98% / 2.4s p50
# with this exact value; changing it requires re-measuring.
ReasoningEffort = Literal["minimal", "low", "medium", "high"]
_REASONING_EFFORT: Final[ReasoningEffort] = "minimal"

# Hard cap on rows the adapter accepts from the model. The v1.3.1
# prompt has its own Rule 12 cap at 20; this is a defensive ceiling
# in case a future prompt revision lifts that without bumping this.
_MAX_ROWS: Final = 100

# Prompt lives in a sibling text file. Reading it on adapter
# construction (once per process) means a prompt revision is a file
# edit + a restart, not a code change. Versioning is by filename —
# `vision_extraction_v1_3_2.txt` lands here when iteration resumes.
_PROMPTS_DIR: Final = Path(__file__).parent.parent / "prompts"
_PROMPT_FILENAME: Final = "vision_extraction_v1_3_1.txt"


def _load_system_prompt() -> str:
    """Read the prompt file off disk.

    Done on adapter construction (not at import time) so a test that
    uses a different prompt path can inject one without monkey-
    patching globals.
    """
    return (_PROMPTS_DIR / _PROMPT_FILENAME).read_text(encoding="utf-8")


class OpenAIVisionExtractor:
    """OpenAI-backed implementation of `VisionExtractorPort`.

    Constructed with an `OpenAI` client so tests can inject a fake.
    Production wiring happens once per process in `api/deps.py`.
    """

    provider_name = "openai"

    def __init__(
        self,
        client: OpenAI,
        *,
        model: str = _MODEL,
        reasoning_effort: ReasoningEffort = _REASONING_EFFORT,
        system_prompt: str | None = None,
    ) -> None:
        self._client = client
        self._model = model
        self._reasoning_effort = reasoning_effort
        self._system_prompt = system_prompt or _load_system_prompt()

    def extract_from_image(
        self, image: bytes, content_type: str
    ) -> PhotoExtractionOutcome:
        if not image:
            # The route + preprocessor + service all guard this; the
            # adapter is the last line of defence so the contract
            # "non-empty bytes in" is honest.
            return _error(
                ExtractionErrorKind.IMAGE_DECODE_FAILED,
                "No image bytes were supplied.",
            )

        # Build the data URL. The preprocessor normalises everything
        # to image/jpeg before this adapter sees it; pass the
        # content-type through anyway for future flexibility.
        data_url = f"data:{content_type};base64,{base64.b64encode(image).decode('ascii')}"

        # Build the messages list with the SDK's typed params so mypy
        # --strict accepts the nested image-content shape (a plain
        # `list[dict[str, Any]]` doesn't satisfy the SDK's overload).
        image_part: ChatCompletionContentPartImageParam = {
            "type": "image_url",
            "image_url": {"url": data_url},
        }
        system_msg: ChatCompletionSystemMessageParam = {
            "role": "system",
            "content": self._system_prompt,
        }
        user_msg: ChatCompletionUserMessageParam = {
            "role": "user",
            "content": [image_part],
        }
        messages: list[ChatCompletionMessageParam] = [system_msg, user_msg]
        response_format: ResponseFormatJSONObject = {"type": "json_object"}

        try:
            response = self._client.chat.completions.create(
                model=self._model,
                reasoning_effort=self._reasoning_effort,
                messages=messages,
                response_format=cast(
                    completion_create_params.ResponseFormat, response_format
                ),
            )
        except (APIConnectionError, APITimeoutError) as exc:
            logger.warning(
                "vision.connection_failure",
                extra={"exc_class": exc.__class__.__name__},
            )
            return _error(
                ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                "Couldn't reach the AI service.",
            )
        except RateLimitError:
            logger.warning("vision.rate_limited")
            return _error(
                ExtractionErrorKind.UPSTREAM_RATE_LIMITED,
                "The AI service is at capacity.",
            )
        except APIError as exc:
            # The Chat Completions API surfaces moderation refusals
            # via APIError subclasses with `code` / `type` strings.
            # Best-effort sniff — anything matching the safety
            # classifier pattern routes to IMAGE_MODERATION_REFUSED
            # so the frontend shows the right copy.
            kind = _classify_api_error(exc)
            logger.warning(
                "vision.api_error",
                extra={
                    "exc_class": exc.__class__.__name__,
                    "mapped_kind": kind.value,
                },
            )
            detail = (
                "The AI service refused to process that photo."
                if kind is ExtractionErrorKind.IMAGE_MODERATION_REFUSED
                else "The AI service returned an error."
            )
            return _error(kind, detail)

        raw = _extract_message_content(response)
        if not raw:
            logger.warning("vision.empty_response")
            return _error(
                ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE,
                "The AI service returned an empty response.",
            )

        parsed = _parse_payload(raw)
        if parsed is None:
            logger.warning(
                "vision.invalid_response",
                extra={"response_chars": len(raw)},
            )
            return _error(
                ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE,
                "Couldn't parse the AI response.",
            )

        logger.info(
            "vision.extracted",
            extra={
                "model": self._model,
                "image_bytes": len(image),
                "row_count": len(parsed.rows),
            },
        )
        return ("ok", parsed)


# ────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────


def _error(kind: ExtractionErrorKind, detail: str) -> PhotoExtractionOutcome:
    return ("error", ExtractionError(kind=kind, detail=detail))


def _classify_api_error(exc: APIError) -> ExtractionErrorKind:
    """Best-effort classification of an `APIError` into a domain kind.

    OpenAI surfaces moderation refusals through a few signals that
    have drifted across SDK versions — checking the message text
    AND the `code` attribute AND the `type` attribute covers the
    historical surface area. Everything that isn't clearly a
    moderation refusal falls through to UPSTREAM_UNAVAILABLE.
    """
    code = getattr(exc, "code", None) or ""
    err_type = getattr(exc, "type", None) or ""
    body_str = (str(exc) or "").lower()
    moderation_signals = (
        "content_policy_violation",
        "content_policy",
        "policy_violation",
        "moderation_blocked",
        "safety",
    )
    if any(
        sig in code.lower() or sig in err_type.lower() or sig in body_str
        for sig in moderation_signals
    ):
        return ExtractionErrorKind.IMAGE_MODERATION_REFUSED
    return ExtractionErrorKind.UPSTREAM_UNAVAILABLE


def _extract_message_content(response: Any) -> str | None:
    """Pull the assistant message content out of a Chat Completions response.

    `response.choices[0].message.content` is the canonical path. Done
    defensively in case the SDK shape drifts — an empty / missing
    message becomes None, which the caller maps to
    UPSTREAM_INVALID_RESPONSE.
    """
    try:
        choices = response.choices
    except AttributeError:
        return None
    if not choices:
        return None
    message = getattr(choices[0], "message", None)
    if message is None:
        return None
    content = getattr(message, "content", None)
    if not isinstance(content, str) or not content.strip():
        return None
    return content


def _parse_payload(raw: str) -> PhotoExtractionResult | None:
    """Decode the model's `{"people": [...]}` JSON into a
    `PhotoExtractionResult`.

    Returns None on any parse / shape failure — the caller translates
    that to `UPSTREAM_INVALID_RESPONSE`. The v1.3.1 prompt is explicit
    about the output shape; deviations are bugs we want to surface,
    not silently mask.
    """
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None

    people_raw = payload.get("people")
    if not isinstance(people_raw, list):
        return None
    # Defensive ceiling against runaway output — the prompt's own
    # Rule 12 cap is 20, so this should never fire on a well-behaved
    # response.
    if len(people_raw) > _MAX_ROWS:
        people_raw = people_raw[:_MAX_ROWS]

    rows: list[PhotoExtractionRow] = []
    for index, person in enumerate(people_raw):
        row = _parse_person(person, index)
        if row is None:
            return None
        rows.append(row)

    return PhotoExtractionResult(
        rows=tuple(rows),
        image_summary=None,
        warnings=(),
    )


def _parse_person(person: object, index: int) -> PhotoExtractionRow | None:
    """Map one `{name, phone, email}` dict to a `PhotoExtractionRow`.

    Unknown keys on the dict are tolerated (the model occasionally
    adds `_observations` or similar; the prompt asks for clean
    output but defensiveness here costs nothing).
    """
    if not isinstance(person, dict):
        return None

    name = _string_or_none(person.get("name"))
    phone = _string_or_none(person.get("phone"))
    email = _string_or_none(person.get("email"))

    contact_fields = (name, phone, email)
    # The prompt's Rule 7 emission gate guarantees at least one of
    # name / phone / email is present on every emitted row. If all
    # three are null, the model misbehaved — drop the row by failing
    # parse rather than surfacing a ghost entry.
    if not any(contact_fields):
        return None

    fields = ExtractedFields(
        name=_contact_field(name),
        phone=_contact_field(phone),
        email=_contact_field(email),
        has_agent=_blank_field(),
        intent=_blank_field(),
        timeline=_blank_field(),
        financing_status=_blank_field(),
        budget=_blank_field(),
        area=_blank_field(),
        follow_up=_blank_field(),
        notes=_blank_field(),
    )

    source_text = " | ".join(part for part in contact_fields if part) or None

    return PhotoExtractionRow(
        fields=fields,
        source_text=source_text,
        row_index=index,
        confidence=Confidence.HIGH,
        warnings=(),
    )


def _contact_field(value: str | None) -> ExtractedField:
    """Build an `ExtractedField` for one of name/phone/email.

    HIGH when the model emitted a value (prompt Rule 2 guarantees no
    guessing — emitted = reliable). LOW when null so downstream
    aggregation has a defined value; the review UI treats null
    calmly as "(no X)" rather than amber-warning on it.
    """
    if value is None:
        return ExtractedField(value=None, confidence=Confidence.LOW, alternatives=())
    return ExtractedField(value=value, confidence=Confidence.HIGH, alternatives=())


def _blank_field() -> ExtractedField:
    """The 8 lead fields the photo prompt doesn't extract.

    Always null; LOW confidence is the honest signal that the photo
    path didn't surface this data (vs the text / voice paths which
    fill these from the transcript).
    """
    return ExtractedField(value=None, confidence=Confidence.LOW, alternatives=())


def _string_or_none(value: object) -> str | None:
    """Coerce a JSON string-or-null to `str | None`, normalising
    empty strings and pure-whitespace strings to None.

    The prompt says "string or null" but models occasionally emit
    empty strings; treating those as null matches the prompt's
    intent (a blank field is null, not "").
    """
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
