"""Adapter-level tests for `OpenAIVisionExtractor` (GPT-5 + v1.3.1 prompt).

Exercises the boundary the adapter owns: SDK exceptions → domain
errors, JSON parsing of the `{"people": [...]}` shape, multi-row
handling, and the Chat-Completions call shape (model, reasoning
effort, json_object response_format, image_url data URL input).

A `_FakeOpenAIClient` stands in for the real OpenAI SDK so we never
hit the network here. A minimal `system_prompt` is injected per
test to avoid loading the real prompt file repeatedly — that file
is exercised in the smoke test at the bottom.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import httpx
import pytest
from openai import APIConnectionError, APIError, APITimeoutError, RateLimitError

from captureshark.adapters.openai_vision_extractor import (
    OpenAIVisionExtractor,
)
from captureshark.domain.extraction import (
    Confidence,
    ExtractionErrorKind,
)
from captureshark.domain.vision import (
    PhotoExtractionResult,
)

_MINIMAL_PROMPT = "(stub system prompt)"


# ────────────────────────────────────────────────────────────────
# Fake SDK
# ────────────────────────────────────────────────────────────────


class _FakeMessage:
    def __init__(self, content: str | None) -> None:
        self.content = content


class _FakeChoice:
    def __init__(self, content: str | None) -> None:
        self.message = _FakeMessage(content)


class _FakeChatResponse:
    """Mimics the shape of an OpenAI Chat Completions response."""

    def __init__(self, content: str | None) -> None:
        self.choices = [_FakeChoice(content)]


class _FakeCompletions:
    def __init__(self, behaviour: Any) -> None:
        self._behaviour = behaviour
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if isinstance(self._behaviour, Exception):
            raise self._behaviour
        if callable(self._behaviour):
            return self._behaviour()
        return self._behaviour


class _FakeChatNamespace:
    def __init__(self, behaviour: Any) -> None:
        self.completions = _FakeCompletions(behaviour)


class _FakeOpenAIClient:
    def __init__(self, behaviour: Any) -> None:
        self.chat = _FakeChatNamespace(behaviour)


def _api_error(code: str = "", err_type: str = "", message: str = "") -> APIError:
    """Build a minimally-populated `APIError` for testing the
    error-classification helper."""
    request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    err = APIError(message or "fake error", request, body={"code": code, "type": err_type})
    err.code = code
    err.type = err_type
    return err


def _rate_limit_error() -> RateLimitError:
    response = httpx.Response(
        status_code=429,
        request=httpx.Request("POST", "https://api.openai.com/v1/chat/completions"),
    )
    return RateLimitError("at capacity", response=response, body=None)


def _people_payload(people: list[dict[str, Any]]) -> str:
    """Wrap a list of `{name, phone, email}` dicts in the `people`
    envelope and serialise to JSON."""
    return json.dumps({"people": people})


def _person(
    *,
    name: str | None = "Maria Lopez",
    phone: str | None = "5550192",
    email: str | None = "maria@example.com",
) -> dict[str, Any]:
    return {"name": name, "phone": phone, "email": email}


def _build(client: _FakeOpenAIClient) -> OpenAIVisionExtractor:
    return OpenAIVisionExtractor(client=client, system_prompt=_MINIMAL_PROMPT)  # type: ignore[arg-type]


# ────────────────────────────────────────────────────────────────
# Empty-input guard
# ────────────────────────────────────────────────────────────────


def test_empty_bytes_short_circuit_without_calling_sdk() -> None:
    client = _FakeOpenAIClient(_FakeChatResponse(_people_payload([_person()])))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.IMAGE_DECODE_FAILED
    assert client.chat.completions.calls == []


# ────────────────────────────────────────────────────────────────
# Happy paths
# ────────────────────────────────────────────────────────────────


def test_single_person_response_parses_to_photo_extraction_result() -> None:
    payload = _people_payload([_person()])
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    result = outcome[1]
    assert isinstance(result, PhotoExtractionResult)
    assert len(result.rows) == 1
    row = result.rows[0]
    assert row.fields.name.value == "Maria Lopez"
    assert row.fields.phone.value == "5550192"
    assert row.fields.email.value == "maria@example.com"
    # Per Rule 2 of the v1.3.1 prompt, every emitted value is reliable
    # so non-null fields land HIGH.
    assert row.fields.name.confidence is Confidence.HIGH
    assert row.fields.phone.confidence is Confidence.HIGH
    assert row.fields.email.confidence is Confidence.HIGH
    # The 8 non-contact fields are always null on the photo path —
    # text/voice fill them from the transcript.
    assert row.fields.has_agent.value is None
    assert row.fields.intent.value is None
    assert row.fields.budget.value is None
    # Row-level aggregate stays HIGH whenever any contact field is
    # present (Rule 7 guarantees that for every emitted row).
    assert row.confidence is Confidence.HIGH
    # No image_summary or batch warnings on the photo path under v1.3.1.
    assert result.image_summary is None
    assert result.warnings == ()


def test_multi_person_response_keeps_document_order_and_row_indices() -> None:
    payload = _people_payload(
        [
            _person(name="Alpha", phone="5550001", email=None),
            _person(name="Bravo", phone=None, email="bravo@example.com"),
            _person(name="Charlie", phone="5550003", email="charlie@example.com"),
        ]
    )
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0sheet", "image/jpeg")

    assert outcome[0] == "ok"
    result = outcome[1]
    assert tuple(r.fields.name.value for r in result.rows) == ("Alpha", "Bravo", "Charlie")
    assert tuple(r.row_index for r in result.rows) == (0, 1, 2)
    # Bravo has no phone → phone field carries null + LOW confidence,
    # but the row still aggregates to HIGH because email is present
    # and the v1.3.1 prompt treats emitted values as reliable.
    assert result.rows[1].fields.phone.value is None
    assert result.rows[1].fields.phone.confidence is Confidence.LOW
    assert result.rows[1].fields.email.value == "bravo@example.com"
    assert result.rows[1].confidence is Confidence.HIGH


def test_null_contact_fields_are_passed_through_as_null_low() -> None:
    """A person with only a name should still come through — Rule 7's
    plausible-name branch (two alphabetic words) emits the row."""
    payload = _people_payload([_person(name="Solo Visitor", phone=None, email=None)])
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    row = outcome[1].rows[0]
    assert row.fields.name.value == "Solo Visitor"
    assert row.fields.phone.value is None
    assert row.fields.email.value is None
    assert row.fields.phone.confidence is Confidence.LOW
    assert row.fields.email.confidence is Confidence.LOW
    # source_text falls back to whatever fields ARE present.
    assert row.source_text == "Solo Visitor"


def test_empty_people_array_yields_zero_rows() -> None:
    """The v1.3.1 prompt says return `{"people": []}` when the image
    has no legible visitor data. The adapter must accept that as a
    clean ok-outcome with zero rows — the service layer maps that to
    `photo_done { status: "no_signal" }` downstream."""
    payload = _people_payload([])
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert outcome[1].rows == ()


def test_whitespace_only_values_normalise_to_null() -> None:
    """Models occasionally emit empty / whitespace strings for blank
    fields. The prompt says null in that case; the adapter normalises
    defensively."""
    payload = _people_payload(
        [{"name": "Real Name", "phone": "   ", "email": ""}]
    )
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    row = outcome[1].rows[0]
    assert row.fields.name.value == "Real Name"
    assert row.fields.phone.value is None
    assert row.fields.email.value is None


def test_row_with_all_null_contacts_is_dropped() -> None:
    """Rule 7 guarantees at least one contact field per emitted row.
    If the model ignores its own gate and emits an all-null person,
    drop it rather than surfacing a ghost entry."""
    payload = _people_payload(
        [
            _person(name="Real", phone="5550001", email=None),
            {"name": None, "phone": None, "email": None},
            _person(name="AlsoReal", phone="5550003", email=None),
        ]
    )
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    # An all-null person in the middle of the response is a hard
    # failure — drop the whole response rather than silently shifting
    # row indices.
    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE


def test_unknown_extra_keys_on_person_are_tolerated() -> None:
    """The prompt asks for clean output but models sometimes append
    extras like `_observations`. Don't fail on them."""
    payload = json.dumps(
        {
            "people": [
                {
                    "name": "Maria Lopez",
                    "phone": "5550192",
                    "email": None,
                    "_observations": "she seemed nice",
                }
            ]
        }
    )
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert outcome[1].rows[0].fields.name.value == "Maria Lopez"


# ────────────────────────────────────────────────────────────────
# Call-shape assertions (locked behaviour from the eval harness)
# ────────────────────────────────────────────────────────────────


def test_call_uses_chat_completions_with_pinned_model_and_minimal_reasoning() -> None:
    payload = _people_payload([_person()])
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = _build(client)

    extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    call = client.chat.completions.calls[0]
    assert call["model"] == "gpt-5"
    # `reasoning_effort="minimal"` is the load-bearing parameter that
    # made p50 drop from 30s to 2.8s. Don't let a refactor silently
    # remove it.
    assert call["reasoning_effort"] == "minimal"
    # The eval measured against `response_format={"type":"json_object"}`,
    # not json_schema strict — keep production matching the measurement.
    assert call["response_format"] == {"type": "json_object"}
    # No temperature: the eval didn't set one. Don't add it back
    # without re-measuring.
    assert "temperature" not in call


def test_image_passed_as_base64_data_url_in_user_message() -> None:
    """The adapter base64-encodes the bytes and prefixes with the
    supplied content-type. The preprocessor normalises everything
    upstream, but the adapter still forwards what it got."""
    payload = _people_payload([_person()])
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = _build(client)
    image = b"\xff\xd8\xff\xe0fake-image-bytes"

    extractor.extract_from_image(image, "image/jpeg")

    call = client.chat.completions.calls[0]
    messages = call["messages"]
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == _MINIMAL_PROMPT
    user_msg = messages[1]
    assert user_msg["role"] == "user"
    image_part = user_msg["content"][0]
    assert image_part["type"] == "image_url"
    expected = f"data:image/jpeg;base64,{base64.b64encode(image).decode('ascii')}"
    assert image_part["image_url"]["url"] == expected


def test_custom_model_and_reasoning_kwargs_are_honoured() -> None:
    payload = _people_payload([_person()])
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = OpenAIVisionExtractor(
        client=client,  # type: ignore[arg-type]
        model="gpt-5-mini",
        reasoning_effort="low",
        system_prompt=_MINIMAL_PROMPT,
    )

    extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    call = client.chat.completions.calls[0]
    assert call["model"] == "gpt-5-mini"
    assert call["reasoning_effort"] == "low"


def test_provider_name_is_openai() -> None:
    """The service stamps this into the terminal `photo_done` SSE
    event. Keep it stable so the wire contract doesn't drift."""
    assert OpenAIVisionExtractor.provider_name == "openai"


# ────────────────────────────────────────────────────────────────
# Error translation
# ────────────────────────────────────────────────────────────────


def test_connection_error_maps_to_upstream_unavailable() -> None:
    client = _FakeOpenAIClient(
        APIConnectionError(
            request=httpx.Request("POST", "https://api.openai.com/v1/chat/completions"),
        )
    )
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_UNAVAILABLE


def test_timeout_error_maps_to_upstream_unavailable() -> None:
    client = _FakeOpenAIClient(
        APITimeoutError(
            request=httpx.Request("POST", "https://api.openai.com/v1/chat/completions"),
        )
    )
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_UNAVAILABLE


def test_rate_limit_error_maps_to_upstream_rate_limited() -> None:
    client = _FakeOpenAIClient(_rate_limit_error())
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_RATE_LIMITED


@pytest.mark.parametrize(
    "code",
    ["content_policy_violation", "policy_violation", "moderation_blocked"],
)
def test_moderation_signal_maps_to_image_moderation_refused(code: str) -> None:
    """OpenAI surfaces moderation refusals through `code` / `type` /
    body text — the helper sniffs all three. Each surfaces as
    IMAGE_MODERATION_REFUSED so the frontend shows the right copy."""
    client = _FakeOpenAIClient(_api_error(code=code))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.IMAGE_MODERATION_REFUSED


def test_generic_api_error_maps_to_upstream_unavailable() -> None:
    client = _FakeOpenAIClient(_api_error(code="server_error"))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_UNAVAILABLE


# ────────────────────────────────────────────────────────────────
# Bad response handling
# ────────────────────────────────────────────────────────────────


def test_empty_message_content_maps_to_invalid_response() -> None:
    client = _FakeOpenAIClient(_FakeChatResponse(""))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE


def test_null_message_content_maps_to_invalid_response() -> None:
    client = _FakeOpenAIClient(_FakeChatResponse(None))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE


def test_malformed_json_maps_to_invalid_response() -> None:
    client = _FakeOpenAIClient(_FakeChatResponse("not json at all"))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE


def test_json_missing_people_key_maps_to_invalid_response() -> None:
    client = _FakeOpenAIClient(_FakeChatResponse('{"rows": []}'))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE


def test_json_with_people_not_a_list_maps_to_invalid_response() -> None:
    client = _FakeOpenAIClient(_FakeChatResponse('{"people": "not a list"}'))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_INVALID_RESPONSE


# ────────────────────────────────────────────────────────────────
# Real prompt-file smoke test
# ────────────────────────────────────────────────────────────────


def test_default_construction_loads_v1_3_1_prompt_file() -> None:
    """The adapter loads its prompt from
    `src/captureshark/prompts/vision_extraction_v1_3_1.txt` by default.
    Confirms the file exists, the loader resolves the path, and the
    prompt carries the v1.3.1-locked rules."""
    payload = _people_payload([_person()])
    client = _FakeOpenAIClient(_FakeChatResponse(payload))
    extractor = OpenAIVisionExtractor(client=client)  # type: ignore[arg-type]

    extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    call = client.chat.completions.calls[0]
    system_msg = call["messages"][0]
    assert system_msg["role"] == "system"
    instructions = system_msg["content"]
    assert isinstance(instructions, str)
    # Sniff for fragments that are load-bearing in v1.3.1 — a future
    # accidental truncation or swap of the prompt file fails this.
    assert "data-extraction system" in instructions.lower()
    assert "zero guessing" in instructions.lower()
    assert "dedupe" in instructions.lower()  # the v1.3.1 addition
