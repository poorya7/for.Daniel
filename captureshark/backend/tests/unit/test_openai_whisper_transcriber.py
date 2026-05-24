"""Adapter-level tests for `OpenAIWhisperTranscriber`.

We exercise the boundary the adapter owns: SDK exceptions → domain
errors, format detection, empty-audio guards, transcript-empty handling.
A `_FakeOpenAIClient` stands in for the real OpenAI SDK so we never hit
the network here.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from openai import APIConnectionError, APITimeoutError, RateLimitError

from captureshark.adapters.openai_whisper_transcriber import OpenAIWhisperTranscriber
from captureshark.domain.transcription import (
    TranscriptionErrorKind,
    TranscriptionResult,
)


class _FakeAudio:
    def __init__(self, transcriptions: "_FakeTranscriptions") -> None:
        self.transcriptions = transcriptions


class _FakeTranscriptions:
    def __init__(self, behaviour: Any) -> None:
        self._behaviour = behaviour
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        # Capture what extension the SDK saw — the adapter sets `.name`
        # on the BytesIO file, which the real SDK reads to detect format.
        file = kwargs.get("file")
        self.calls.append(
            {
                "filename": getattr(file, "name", None),
                "model": kwargs.get("model"),
                "prompt": kwargs.get("prompt"),
                "response_format": kwargs.get("response_format"),
            }
        )
        if isinstance(self._behaviour, Exception):
            raise self._behaviour
        if callable(self._behaviour):
            return self._behaviour()
        return self._behaviour


class _FakeOpenAIClient:
    def __init__(self, behaviour: Any) -> None:
        self.audio = _FakeAudio(_FakeTranscriptions(behaviour))


def test_returns_transcription_result_on_success() -> None:
    client = _FakeOpenAIClient("Maria Lopez, 555 0192, looking on Maple")
    transcriber = OpenAIWhisperTranscriber(client=client)  # type: ignore[arg-type]

    outcome = transcriber.transcribe(b"\x00\x01fake-audio", "audio/webm")

    assert outcome[0] == "ok"
    assert isinstance(outcome[1], TranscriptionResult)
    assert outcome[1].text == "Maria Lopez, 555 0192, looking on Maple"
    # Confirm we passed the right extension hint to the SDK.
    assert client.audio.transcriptions.calls[0]["filename"] == "capture.webm"
    # And used response_format="text" so we get a plain string back.
    assert client.audio.transcriptions.calls[0]["response_format"] == "text"


def test_empty_audio_returns_empty_audio_error_without_calling_sdk() -> None:
    client = _FakeOpenAIClient("should never get here")
    transcriber = OpenAIWhisperTranscriber(client=client)  # type: ignore[arg-type]

    outcome = transcriber.transcribe(b"", "audio/webm")

    assert outcome[0] == "error"
    assert outcome[1].kind == TranscriptionErrorKind.EMPTY_AUDIO
    assert client.audio.transcriptions.calls == []


def test_unsupported_format_short_circuits_before_sdk_call() -> None:
    client = _FakeOpenAIClient("should never get here")
    transcriber = OpenAIWhisperTranscriber(client=client)  # type: ignore[arg-type]

    outcome = transcriber.transcribe(b"\x00\x01", "video/mp4")

    assert outcome[0] == "error"
    assert outcome[1].kind == TranscriptionErrorKind.UNSUPPORTED_FORMAT
    assert client.audio.transcriptions.calls == []


def test_codec_parameter_is_stripped_when_matching_format() -> None:
    """`audio/webm;codecs=opus` should resolve to webm."""
    client = _FakeOpenAIClient("hello")
    transcriber = OpenAIWhisperTranscriber(client=client)  # type: ignore[arg-type]

    outcome = transcriber.transcribe(b"\x00", "audio/webm;codecs=opus")

    assert outcome[0] == "ok"
    assert client.audio.transcriptions.calls[0]["filename"] == "capture.webm"


def test_empty_transcript_returns_no_speech_error() -> None:
    """Whisper occasionally returns an empty transcript on silence/noise."""
    client = _FakeOpenAIClient("   \n  ")
    transcriber = OpenAIWhisperTranscriber(client=client)  # type: ignore[arg-type]

    outcome = transcriber.transcribe(b"\x00\x01", "audio/webm")

    assert outcome[0] == "error"
    assert outcome[1].kind == TranscriptionErrorKind.NO_SPEECH


@pytest.mark.parametrize(
    ("exc", "expected_kind"),
    [
        (
            APIConnectionError(request=httpx.Request("POST", "https://x")),
            TranscriptionErrorKind.UPSTREAM_UNAVAILABLE,
        ),
        (
            APITimeoutError(request=httpx.Request("POST", "https://x")),
            TranscriptionErrorKind.UPSTREAM_UNAVAILABLE,
        ),
        (
            RateLimitError(
                "rate limited",
                response=httpx.Response(
                    429, request=httpx.Request("POST", "https://x")
                ),
                body=None,
            ),
            TranscriptionErrorKind.UPSTREAM_RATE_LIMITED,
        ),
    ],
)
def test_sdk_exceptions_translate_to_domain_errors(
    exc: Exception, expected_kind: TranscriptionErrorKind
) -> None:
    client = _FakeOpenAIClient(exc)
    transcriber = OpenAIWhisperTranscriber(client=client)  # type: ignore[arg-type]

    outcome = transcriber.transcribe(b"\x00\x01", "audio/webm")

    assert outcome[0] == "error"
    assert outcome[1].kind == expected_kind
