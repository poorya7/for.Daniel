"""Domain layer — pure business types and ports (interfaces).

Rules:
  * No I/O. No HTTP, DB, or third-party SDK imports.
  * No framework imports (no FastAPI, no SQLAlchemy).
  * Defines `Port` protocols that adapters implement.

If you find yourself reaching for `requests`, `openai`, or `httpx` here,
stop — that belongs in `adapters/`, and the domain should depend on an
abstract interface defined in this package.
"""

from captureshark.domain.capture import CaptureSource, TextCaptureInput
from captureshark.domain.extraction import (
    Confidence,
    ExtractedField,
    ExtractedFields,
    ExtractionError,
    ExtractionErrorKind,
    ExtractionOutcome,
    ExtractionResult,
    ExtractorPort,
    LeadFieldName,
    StreamDelta,
    StreamEvent,
)
from captureshark.domain.sheets import (
    SheetRow,
    SheetsErrorKind,
    SheetsRepoPort,
    SheetTarget,
    SheetWriteError,
    SheetWriteOutcome,
    SheetWriteSuccess,
)

__all__ = [
    "CaptureSource",
    "Confidence",
    "ExtractedField",
    "ExtractedFields",
    "ExtractionError",
    "ExtractionErrorKind",
    "ExtractionOutcome",
    "ExtractionResult",
    "ExtractorPort",
    "LeadFieldName",
    "SheetRow",
    "SheetTarget",
    "SheetWriteError",
    "SheetWriteOutcome",
    "SheetWriteSuccess",
    "SheetsErrorKind",
    "SheetsRepoPort",
    "StreamDelta",
    "StreamEvent",
    "TextCaptureInput",
]
