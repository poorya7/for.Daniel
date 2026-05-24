"""OpenAI Whisper-backed implementation of `TranscriberPort`.

Wraps the `client.audio.transcriptions.create` call and translates the
SDK's exception vocabulary into the domain's `TranscriptionError` kinds.
The system prompt explicitly instructs Whisper to focus on the primary
speaker and ignore background conversations — open houses and trade
shows are loud, and stray voices 10ft away will leak in if we don't
tell the model to ignore them.
"""

from __future__ import annotations

import io
import logging
from typing import Final

from openai import APIConnectionError, APIError, APITimeoutError, OpenAI, RateLimitError

from captureshark.domain.transcription import (
    TranscriberPort,
    TranscriptionError,
    TranscriptionErrorKind,
    TranscriptionOutcome,
    TranscriptionResult,
)

logger = logging.getLogger(__name__)

_MODEL: Final = "whisper-1"

# The Whisper API takes a `prompt` string as a hint to the model. We use
# it to nudge the model toward the primary speaker (the broker holding
# the phone) and away from background chatter at open houses / trade
# shows. This is a *hint*, not a hard constraint — Whisper still
# transcribes whatever's audible. But on noisy real-world audio the
# hint reliably improves which voice the model anchors on.
_TRANSCRIBE_HINT: Final = (
    "Focus on the primary speaker. Ignore background conversations and "
    "ambient chatter. The speaker may mention names, phone numbers, "
    "neighbourhoods, dollar amounts, and follow-up timing for a real "
    "estate or insurance lead."
)

# Whisper accepts m4a / mp3 / mp4 / mpeg / mpga / oga / ogg / wav / webm.
# Browser MediaRecorder typically emits webm (Chrome / Firefox) or mp4
# (Safari). We map the common content-types we'll actually see; anything
# else falls back to .bin which Whisper rejects with a clear error.
_EXTENSION_BY_CONTENT_TYPE: Final[dict[str, str]] = {
    "audio/webm": "webm",
    "audio/webm;codecs=opus": "webm",
    "audio/ogg": "ogg",
    "audio/ogg;codecs=opus": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
}


class OpenAIWhisperTranscriber(TranscriberPort):
    """OpenAI-backed transcriber.

    Constructed with an `OpenAI` client so tests can inject a fake.
    Production wiring happens once per process in `api/deps.py`.
    """

    def __init__(self, client: OpenAI, *, model: str = _MODEL) -> None:
        self._client = client
        self._model = model

    def transcribe(self, audio: bytes, content_type: str) -> TranscriptionOutcome:
        if not audio:
            return (
                "error",
                TranscriptionError(
                    kind=TranscriptionErrorKind.EMPTY_AUDIO,
                    detail="No audio was supplied.",
                ),
            )

        ext = _extension_for(content_type)
        if ext is None:
            return (
                "error",
                TranscriptionError(
                    kind=TranscriptionErrorKind.UNSUPPORTED_FORMAT,
                    detail=f"Audio format '{content_type}' isn't supported.",
                ),
            )

        # Whisper wants a file-like object; the OpenAI SDK reads the
        # filename's extension to detect the format. BytesIO with a
        # `.name` attribute is the canonical way to pass bytes here.
        buf = io.BytesIO(audio)
        buf.name = f"capture.{ext}"

        try:
            response = self._client.audio.transcriptions.create(
                model=self._model,
                file=buf,
                prompt=_TRANSCRIBE_HINT,
                # `response_format="text"` returns a plain string; the
                # default JSON object includes a `text` field we'd just
                # extract anyway. Both cost the same.
                response_format="text",
            )
        except (APIConnectionError, APITimeoutError) as exc:
            logger.warning(
                "whisper connection failure",
                extra={"exc_class": exc.__class__.__name__},
            )
            return (
                "error",
                TranscriptionError(
                    kind=TranscriptionErrorKind.UPSTREAM_UNAVAILABLE,
                    detail="Couldn't reach the AI service.",
                ),
            )
        except RateLimitError:
            logger.warning("whisper rate-limited")
            return (
                "error",
                TranscriptionError(
                    kind=TranscriptionErrorKind.UPSTREAM_RATE_LIMITED,
                    detail="The AI service is at capacity.",
                ),
            )
        except APIError as exc:
            logger.warning(
                "whisper api error",
                extra={"exc_class": exc.__class__.__name__},
            )
            return (
                "error",
                TranscriptionError(
                    kind=TranscriptionErrorKind.UPSTREAM_UNAVAILABLE,
                    detail="The AI service returned an error.",
                ),
            )

        # `response_format="text"` returns a plain str via the SDK.
        text = (response if isinstance(response, str) else str(response)).strip()
        if not text:
            return (
                "error",
                TranscriptionError(
                    kind=TranscriptionErrorKind.NO_SPEECH,
                    detail="Couldn't hear any speech in the recording.",
                ),
            )

        return ("ok", TranscriptionResult(text=text))


def _extension_for(content_type: str) -> str | None:
    """Return the file extension Whisper expects for this content-type,
    or `None` if the type isn't in our supported set.

    Match the leading mime portion (before any parameters like
    `;codecs=opus`) first, then try the full string. Browsers don't
    standardise the parameters part, so the loose match catches more.
    """
    base = content_type.split(";", 1)[0].strip().lower()
    if base in _EXTENSION_BY_CONTENT_TYPE:
        return _EXTENSION_BY_CONTENT_TYPE[base]
    return _EXTENSION_BY_CONTENT_TYPE.get(content_type.strip().lower())
