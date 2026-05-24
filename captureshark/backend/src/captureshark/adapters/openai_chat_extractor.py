"""OpenAI Chat Completions adapter for text-only lead extraction.

Implements `ExtractorPort.extract_from_text` using `gpt-4o-mini` (per tech
plan §1: cheap and fast for text-only). Vision and audio extraction live in
sibling adapters (`openai_vision_extractor.py`, `openai_whisper.py`).

Design notes:

  * **Errors are data.** The adapter catches every recoverable upstream
    failure mode (network, rate limit, malformed JSON) and returns an
    `ExtractionError`. The success path returns a fully-populated
    `ExtractedFields`.

  * **JSON Schema response format.** We pin the model to a strict schema so
    the parser never has to guess. Confidence is a fixed enum the model
    must pick from; alternatives is a bounded list.

  * **No PII in logs.** Per tech plan §12 we don't log raw input or the
    extracted contact fields. Only structural metadata (latency, error
    kind) lands in logs — wired in when we add real logging.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from typing import Any, Final

from openai import APIConnectionError, APIError, APITimeoutError, OpenAI, RateLimitError

from captureshark.domain.extraction import (
    Confidence,
    ExtractedField,
    ExtractedFields,
    ExtractionError,
    ExtractionErrorKind,
    ExtractionOutcome,
    ExtractionResult,
    FINANCING_STATUS_VALUES,
    INTENT_VALUES,
    LeadFieldName,
    StreamDelta,
    StreamEvent,
    TIMELINE_VALUES,
)

logger = logging.getLogger(__name__)

# Model pinned per tech plan. Bumping = explicit decision (Rule #0 territory:
# default-model swaps need user sign-off).
_MODEL: Final = "gpt-4o-mini"

# Bounded so a runaway model can't return a 1000-item alternatives list.
_MAX_ALTERNATIVES: Final = 5

_SYSTEM_PROMPT: Final = (
    "You extract structured contact information from a free-form note about a "
    "real estate / mortgage / insurance lead. The note may be messy, partial, "
    "or use shorthand. For every field, return your best guess plus a "
    "confidence label.\n\n"
    "Rules:\n"
    "- Use null when a field is not mentioned. Never invent a value.\n"
    "- Confidence: 'high' = clearly stated; 'medium' = inferred or partial; "
    "'low' = barely legible or ambiguous.\n"
    "- 'alternatives' is a list of up to 5 runner-up values you considered, "
    "in descending plausibility. Empty list when there is only one candidate.\n"
    "- 'follow_up' should be a normalised phrase like 'next Tuesday', "
    "'in 2 weeks', '2026-05-15' if a calendar date is given. Don't invent "
    "dates.\n"
    "- 'budget' must be normalised to standard US currency: digits with "
    "comma separators, no decimals, dollar prefix. Convert all shorthand "
    "and word forms (whether digits or written-out words) to full numbers. "
    "Preserve modifiers ('under', 'around', 'up to') and ranges. Examples:\n"
    "    '600k'              -> '$600,000'\n"
    "    '1.2M'              -> '$1,200,000'\n"
    "    'two million'       -> '$2,000,000'\n"
    "    'six hundred fifty' -> '$650,000' (k implied in real-estate context)\n"
    "    '$2.5m'             -> '$2,500,000'\n"
    "    'under 700k'        -> 'under $700,000'\n"
    "    'around 1.5m'       -> 'around $1,500,000'\n"
    "    '600k-700k'         -> '$600,000-$700,000'\n"
    "  When the unit is genuinely unclear (e.g. a bare '600' with no "
    "  context), keep the value as-is and lower the confidence to 'low'.\n"
    "- 'has_agent' captures whether the lead already has a real estate "
    "agent / buyer's agent. This is the FIRST question listing brokers ask "
    "at open houses, so any mention counts. Return 'yes' when the lead "
    "confirms they have one (optionally with the agent's name attached, "
    "e.g. 'yes - Jane Smith'), 'no' when they explicitly say they don't, "
    "and null when the note simply doesn't mention it. Examples:\n"
    "    'working with Jane Smith already'    -> 'yes - Jane Smith'\n"
    "    'has an agent'                       -> 'yes'\n"
    "    'no agent yet'                       -> 'no'\n"
    "    'unrepresented'                      -> 'no'\n"
    "    (not mentioned)                      -> null\n"
    "- 'intent' captures what the lead is at the open house for. Must be "
    "ONE of: 'buyer' (looking to buy), 'seller' (has a property to sell, "
    "common at open houses where curious neighbours walk through), 'both' "
    "(selling current home AND buying next), or 'browsing' (no real "
    "intent yet, just looking). Return null when the note doesn't mention "
    "or imply it.\n"
    "- 'timeline' captures how soon the lead expects to transact. Must be "
    "ONE of: 'now' (ready in the next 4 weeks), '3mo' (1-3 months), "
    "'6mo' (3-6 months), '12mo+' (more than 6 months, or just exploring). "
    "Return null when not mentioned.\n"
    "- 'financing_status' captures how the lead would pay. Must be ONE "
    "of: 'cash' (cash buyer), 'pre_approved' (has a mortgage pre-approval "
    "letter), 'needs_lender' (will need a lender / mortgage referral), "
    "or 'unknown' (lead doesn't know yet or didn't say). Return null when "
    "the note has no signal at all.\n"
    "- 'notes' is a catch-all for anything important the structured fields "
    "didn't capture (vibe, urgency, school district, family situation, etc.). "
    "If nothing else fits, leave 'notes' null.\n"
    "- Reply ONLY with the JSON object the schema describes."
)


# Enum-constrained fields: the schema pins `value` to one of these tokens
# (or null). The LLM is also told to use these exact tokens via the
# system prompt above. Two layers of constraint (prompt + schema) so the
# model can't drift to e.g. "buying" instead of "buyer".
_ENUM_VALUE_BY_FIELD: Final[dict[LeadFieldName, tuple[str, ...]]] = {
    LeadFieldName.INTENT: INTENT_VALUES,
    LeadFieldName.TIMELINE: TIMELINE_VALUES,
    LeadFieldName.FINANCING_STATUS: FINANCING_STATUS_VALUES,
}


def _field_property(field_name: LeadFieldName) -> dict[str, Any]:
    """Single-field schema fragment, reused for every lead field.

    Enum-constrained fields (intent / timeline / financing_status) get
    their `value` pinned to the allowed token set so a hallucinated
    value like "buying" instead of "buyer" is rejected by OpenAI's
    strict json_schema validator before it ever reaches our code.
    """
    enum_tokens = _ENUM_VALUE_BY_FIELD.get(field_name)
    value_schema: dict[str, Any]
    if enum_tokens is None:
        value_schema = {"type": ["string", "null"]}
    else:
        # `null` is encoded as a separate `type` branch alongside the
        # enum so the model can still return null when the note doesn't
        # mention the field at all.
        value_schema = {
            "type": ["string", "null"],
            "enum": [*enum_tokens, None],
        }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["value", "confidence", "alternatives"],
        "properties": {
            "value": value_schema,
            "confidence": {
                "type": "string",
                "enum": [c.value for c in Confidence],
            },
            "alternatives": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": _MAX_ALTERNATIVES,
            },
        },
    }


_RESPONSE_SCHEMA: Final[dict[str, Any]] = {
    "type": "object",
    "additionalProperties": False,
    "required": [name.value for name in LeadFieldName],
    "properties": {name.value: _field_property(name) for name in LeadFieldName},
}


class OpenAIChatExtractor:
    """OpenAI-backed implementation of the text extractor port.

    Constructed with an OpenAI client so tests can inject a fake. Production
    construction happens in `api/deps.py` once per process.
    """

    def __init__(self, client: OpenAI, *, model: str = _MODEL) -> None:
        self._client = client
        self._model = model

    def extract_from_text(self, text: str) -> ExtractionOutcome:
        cleaned = text.strip()
        if not cleaned:
            return (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.EMPTY_INPUT,
                    detail="No text was supplied.",
                ),
            )

        try:
            completion = self._client.chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": cleaned},
                ],
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "lead_extraction",
                        "schema": _RESPONSE_SCHEMA,
                        "strict": True,
                    },
                },
                temperature=0,
            )
        except (APIConnectionError, APITimeoutError) as exc:
            logger.warning(
                "openai connection failure",
                extra={"exc_class": exc.__class__.__name__},
            )
            return (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                    detail="Couldn't reach the AI service.",
                ),
            )
        except RateLimitError:
            logger.warning("openai rate-limited")
            return (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_RATE_LIMITED,
                    detail="The AI service is at capacity.",
                ),
            )
        except APIError as exc:
            logger.warning(
                "openai api error",
                extra={"exc_class": exc.__class__.__name__},
            )
            return (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                    detail="The AI service returned an error.",
                ),
            )

        choice = completion.choices[0] if completion.choices else None
        raw = choice.message.content if choice and choice.message else None
        if not raw:
            return (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE,
                    detail="The AI service returned an empty response.",
                ),
            )

        parsed = _parse_payload(raw)
        if parsed is None:
            return (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE,
                    detail="Couldn't parse the AI response.",
                ),
            )

        return ("ok", ExtractionResult(fields=parsed, original_text=cleaned))

    def stream_from_text(self, text: str) -> Iterator[StreamEvent]:
        """Yield delta events as the model streams, then a terminal event.

        Using OpenAI's streaming API with the same json_schema response
        format as the non-streaming variant — content arrives chunk by
        chunk, the buffer is JSON, and the frontend can parse it
        progressively to render fields the moment each one completes.

        Final event is `("done", ExtractionResult(...))` on success or
        `("error", ExtractionError(...))` on any recoverable failure.
        """
        cleaned = text.strip()
        if not cleaned:
            yield (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.EMPTY_INPUT,
                    detail="No text was supplied.",
                ),
            )
            return

        buffer: list[str] = []
        try:
            stream = self._client.chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": cleaned},
                ],
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "lead_extraction",
                        "schema": _RESPONSE_SCHEMA,
                        "strict": True,
                    },
                },
                temperature=0,
                stream=True,
            )
            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                content = getattr(delta, "content", None)
                if content:
                    buffer.append(content)
                    yield ("delta", StreamDelta(content=content))
        except (APIConnectionError, APITimeoutError) as exc:
            logger.warning(
                "openai stream connection failure",
                extra={"exc_class": exc.__class__.__name__},
            )
            yield (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                    detail="Couldn't reach the AI service.",
                ),
            )
            return
        except RateLimitError:
            logger.warning("openai stream rate-limited")
            yield (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_RATE_LIMITED,
                    detail="The AI service is at capacity.",
                ),
            )
            return
        except APIError as exc:
            logger.warning(
                "openai stream api error",
                extra={"exc_class": exc.__class__.__name__},
            )
            yield (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                    detail="The AI service returned an error.",
                ),
            )
            return

        full = "".join(buffer)
        if not full:
            yield (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE,
                    detail="The AI service returned an empty response.",
                ),
            )
            return

        parsed = _parse_payload(full)
        if parsed is None:
            yield (
                "error",
                ExtractionError(
                    kind=ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE,
                    detail="Couldn't parse the AI response.",
                ),
            )
            return

        yield ("done", ExtractionResult(fields=parsed, original_text=cleaned))


def _parse_payload(raw: str) -> ExtractedFields | None:
    """Turn the validated-by-schema JSON string into domain types.

    Returns `None` if the payload still doesn't match (defensive — strict
    json_schema should make this unreachable, but a future model update or
    schema-drift bug shouldn't crash the request).
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None

    try:
        return ExtractedFields(
            name=_field_from(data, LeadFieldName.NAME),
            phone=_field_from(data, LeadFieldName.PHONE),
            email=_field_from(data, LeadFieldName.EMAIL),
            has_agent=_field_from(data, LeadFieldName.HAS_AGENT),
            intent=_field_from(data, LeadFieldName.INTENT),
            timeline=_field_from(data, LeadFieldName.TIMELINE),
            financing_status=_field_from(data, LeadFieldName.FINANCING_STATUS),
            budget=_field_from(data, LeadFieldName.BUDGET),
            area=_field_from(data, LeadFieldName.AREA),
            follow_up=_field_from(data, LeadFieldName.FOLLOW_UP),
            notes=_field_from(data, LeadFieldName.NOTES),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _field_from(data: dict[str, Any], name: LeadFieldName) -> ExtractedField:
    raw = data[name.value]
    if not isinstance(raw, dict):
        raise TypeError(f"field {name.value!r} not an object")

    value = raw["value"]
    if value is not None and not isinstance(value, str):
        raise TypeError(f"field {name.value!r} value not str|null")
    # Treat empty strings as missing — keeps domain simple.
    normalised: str | None = value.strip() if isinstance(value, str) and value.strip() else None

    confidence_raw = raw["confidence"]
    if not isinstance(confidence_raw, str):
        raise TypeError(f"field {name.value!r} confidence not str")
    confidence = Confidence(confidence_raw)

    alternatives_raw = raw["alternatives"]
    if not isinstance(alternatives_raw, list):
        raise TypeError(f"field {name.value!r} alternatives not list")
    alternatives = tuple(
        item.strip() for item in alternatives_raw if isinstance(item, str) and item.strip()
    )[:_MAX_ALTERNATIVES]

    return ExtractedField(value=normalised, confidence=confidence, alternatives=alternatives)
