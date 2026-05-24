"""Transcription domain — pure types for audio → text conversion.

The voice capture path uses Whisper to turn an audio blob into a text
transcript, then feeds that transcript through the same `ExtractorPort`
pipeline as the text capture path. This module defines the boundary
between "audio in" and "text ready for extraction."

Adapters live in `adapters/` (e.g. `OpenAIWhisperTranscriber`); services
depend on the `TranscriberPort` Protocol so tests can swap in fakes.

No coupling to extraction at the domain level — `TranscriptionResult`
just carries the transcript text. The voice service in
`services/extraction_service.py` is the place that joins transcribe →
extract into a single user-facing flow.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    """Success-shape of a transcription run.

    `text` is the primary-speaker transcript Whisper returned. Empty
    transcripts become `TranscriptionError(kind=NO_SPEECH)` at the
    adapter boundary, so callers can rely on a non-empty string here.
    """

    text: str


class TranscriptionErrorKind(StrEnum):
    """Coarse error categories the API layer maps to user-facing copy.

    Adding a kind = adding a copy mapping where the service translates
    transcription errors to extraction errors (so the route + frontend
    only deal with one error vocabulary).
    """

    EMPTY_AUDIO = "empty_audio"  # Caller submitted an empty blob.
    UNSUPPORTED_FORMAT = "unsupported_format"  # Whisper rejected the format.
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"  # OpenAI down / network.
    UPSTREAM_RATE_LIMITED = "upstream_rate_limited"
    NO_SPEECH = "no_speech"  # Whisper returned an empty transcript.
    UNEXPECTED = "unexpected"  # Anything else; bug-shaped.


@dataclass(frozen=True, slots=True)
class TranscriptionError:
    """Error-shape of a transcription run."""

    kind: TranscriptionErrorKind
    detail: str


# Discriminated union mirrored after `ExtractionOutcome`.
TranscriptionOutcome = (
    tuple[Literal["ok"], TranscriptionResult]
    | tuple[Literal["error"], TranscriptionError]
)


@runtime_checkable
class TranscriberPort(Protocol):
    """Adapter interface: turns an audio blob into a transcript.

    Implementations MUST return an outcome; they MUST NOT raise on
    upstream failure (timeouts, rate limits, format rejections). Those
    become `("error", TranscriptionError(...))`. Programmer errors still
    bubble — those aren't error-as-data, they're bugs.
    """

    def transcribe(self, audio: bytes, content_type: str) -> TranscriptionOutcome:
        """Transcribe the given audio bytes."""
        ...
