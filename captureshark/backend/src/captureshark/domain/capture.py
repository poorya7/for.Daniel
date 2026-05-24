"""Capture domain — the user-supplied input that becomes one (or more) sheet rows.

A `Capture` is one *capture event*: a typed note, a voice memo, or a photo of
a sign-in sheet. Each capture passes through the extraction pipeline and
eventually produces one or more rows in the user's connected Google Sheet.

For step 2 of the build (text capture local-only) we only model the text path.
Voice and photo land in later steps; their fields will join `CaptureSource`
and the input shape will widen to a discriminated union.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class CaptureSource(StrEnum):
    """Where the capture came from. Mirrors the Source column written to the sheet."""

    TEXT = "text"
    VOICE = "voice"
    PHOTO = "photo"


@dataclass(frozen=True, slots=True)
class TextCaptureInput:
    """The raw input for a text-source capture.

    Trimmed and validated at the service boundary. Empty input becomes an
    `ExtractionError(kind=EMPTY_INPUT)` rather than a 400 — the API layer
    decides the HTTP status from the error kind.
    """

    text: str


@dataclass(frozen=True, slots=True)
class VoiceCaptureInput:
    """The raw input for a voice-source capture.

    Audio bytes + a content-type hint so the transcriber adapter can give
    Whisper the right filename extension. The browser produces audio/webm
    on Chrome/Firefox and audio/mp4 on Safari; both are accepted formats.
    """

    audio: bytes
    content_type: str


@dataclass(frozen=True, slots=True)
class PhotoCaptureInput:
    """The raw input for a photo-source capture.

    Image bytes + a content-type hint. The hint is only that — the
    preprocessor sniffs the actual magic-number on the bytes before
    trusting it (a bad client can mislabel a blob as `image/jpeg`).
    HEIC, JPEG, PNG, and WEBP are supported via the preprocessor;
    everything else is rejected as `UNSUPPORTED_IMAGE`.

    `capture_id` is a short server-generated identifier the route
    layer mints for this specific capture event. It seeds the per-row
    idempotency keys the service emits on `photo_row` events so the
    offline-queue drainer can dedupe row-level saves across retries.
    """

    image: bytes
    content_type: str
    capture_id: str
