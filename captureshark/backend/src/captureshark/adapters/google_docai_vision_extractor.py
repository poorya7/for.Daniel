"""Google Document AI Form Parser adapter for photo lead extraction.

Implements `VisionExtractorPort.extract_from_image` against Doc AI's
Form Parser processor. Replaces the OpenAI vision adapter as the
production vision provider per the v1 plan (locked 2026-05-16 after
a 6-model bake-off — see `docs/_spec/photo_capture.md`).

Differences from the bake-off candidate
(`docs/_tests/vision_bakeoff/candidates/google_docai.py`):

  * Per-cell + per-field confidence is pulled from the real Doc AI
    response (`cell.layout.confidence`, `field_value.confidence`)
    and bucketed into the domain's three-level `Confidence` enum.
    The candidate hardcoded every value to MEDIUM, which collapsed
    Slice B's low-confidence retake path. This adapter must NOT
    re-introduce that.

  * Row-level confidence is the MIN of the contact-triple
    (name / phone / email) confidences. Conservative on purpose:
    one LOW field flags the whole row for review.

  * Mojibake repair (pitfall #29) is applied defensively at the
    read boundary — no-op for clean ASCII, fixes Latin-1-encoded
    UTF-8 like `MÃ¼ller` → `Müller`.

  * Error mapping follows the v1 plan §A.4 table:
    DeadlineExceeded / ServiceUnavailable / PermissionDenied /
    other GoogleAPICallError → UPSTREAM_UNAVAILABLE;
    ResourceExhausted → UPSTREAM_RATE_LIMITED;
    InvalidArgument → IMAGE_DECODE_FAILED.

Doc AI doesn't have free-text "summary of this photo" output, so
`image_summary` is always `None`. Doc AI also doesn't have a
moderation-refusal concept like OpenAI — the
`IMAGE_MODERATION_REFUSED` error kind stays in the domain but
never fires from this adapter.

Field coverage: Doc AI only surfaces what's literally on the form
(name / phone / email at best). The other eight lead fields
(`has_agent`, `intent`, `timeline`, `financing_status`, `budget`,
`area`, `follow_up`, `notes`) stay blank — those are LLM-style
judgments Doc AI doesn't make. Slice C's review UI renders blanks
as "(no X)" calmly.

Logging discipline:
  * Log structural metadata (bytes-in, row count, error kind).
  * NEVER log extracted values (name / phone / email).
  * NEVER log the raw Doc AI response (carries the same PII).
"""

from __future__ import annotations

import logging
from typing import Any, Final

from google.api_core.exceptions import (
    DeadlineExceeded,
    GoogleAPICallError,
    InvalidArgument,
    PermissionDenied,
    ResourceExhausted,
    ServiceUnavailable,
)
from google.cloud import documentai_v1 as docai
from google.oauth2 import service_account

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

# ────────────────────────────────────────────────────────────────
# Confidence bucketing
# ────────────────────────────────────────────────────────────────

# Doc AI returns confidence in [0.0, 1.0]. Map into the domain's
# three-level enum. Starting bands per Doc AI's published distribution;
# tune later if real-world telemetry shows the buckets misclassify.
_HIGH_THRESHOLD: Final = 0.90
_MEDIUM_THRESHOLD: Final = 0.70


def _bucket_confidence(score: float | None) -> Confidence:
    if score is None:
        return Confidence.LOW
    if score >= _HIGH_THRESHOLD:
        return Confidence.HIGH
    if score >= _MEDIUM_THRESHOLD:
        return Confidence.MEDIUM
    return Confidence.LOW


# Order of severity so we can take the min across a row's contact triple.
_CONFIDENCE_RANK: Final[dict[Confidence, int]] = {
    Confidence.LOW: 0,
    Confidence.MEDIUM: 1,
    Confidence.HIGH: 2,
}


def _min_confidence(*fields: ExtractedField) -> Confidence:
    """Min across the present fields' confidence levels.

    Empty/blank fields are ignored (a row with name=HIGH, phone=blank,
    email=blank shouldn't be dragged down to LOW by absent fields).
    All-blank → LOW.
    """
    present = [f.confidence for f in fields if f.value]
    if not present:
        return Confidence.LOW
    return min(present, key=lambda c: _CONFIDENCE_RANK[c])


# ────────────────────────────────────────────────────────────────
# Label patterns + cluster threshold
# ────────────────────────────────────────────────────────────────

_NAME_LABELS: Final = ("name", "visitor", "member", "guest", "attendee")
_PHONE_LABELS: Final = ("phone", "tel", "mobile", "cell", "number")
_EMAIL_LABELS: Final = ("email", "e-mail", "mail")

# Labels we deliberately skip — they appear on real sign-in forms but
# aren't part of the lead's contact triple.
_IGNORE_LABELS: Final = (
    "address",
    "date",
    "signature",
    "location",
    "company",
    "real estate",
    "owner",
    "title",
    "price",
)

# Vertical-distance threshold for "same row" clustering when Doc AI
# returns form_fields without explicit row structure. Coordinates are
# normalised against page height, so 0.025 ≈ 2.5%.
_ROW_Y_THRESHOLD: Final = 0.025


# ────────────────────────────────────────────────────────────────
# Mojibake repair (pitfall #29)
# ────────────────────────────────────────────────────────────────

# Some Doc AI outputs surface non-ASCII strings as double-encoded
# UTF-8 (UTF-8 bytes re-encoded as Latin-1). `MÃ¼ller` → `Müller`.
# Detect via `Ã` / `Â` marker bytes, repair via the latin-1/utf-8
# round-trip. Safe no-op for pure ASCII.
def _repair_mojibake(value: str) -> str:
    if not value or ("Ã" not in value and "Â" not in value):
        return value
    try:
        return value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


# ────────────────────────────────────────────────────────────────
# Client builder (called once per process from `api/deps.py`)
# ────────────────────────────────────────────────────────────────


def build_documentai_client(
    service_account_path: str,
    processor_name: str,
) -> docai.DocumentProcessorServiceClient:
    """Build a Doc AI client pinned to the processor's region.

    Doc AI's gRPC endpoint is region-scoped (`us-documentai...`,
    `eu-documentai...`, etc.), so we parse the region out of the
    processor resource path and point the client at the right host.
    A future region change is then a one-config-line swap.
    """
    region = _region_from_processor_name(processor_name)
    # google-auth doesn't ship type stubs for from_service_account_file.
    creds = service_account.Credentials.from_service_account_file(  # type: ignore[no-untyped-call]
        service_account_path
    )
    return docai.DocumentProcessorServiceClient(
        credentials=creds,
        client_options={"api_endpoint": f"{region}-documentai.googleapis.com"},
    )


def _region_from_processor_name(name: str) -> str:
    parts = name.split("/")
    try:
        return parts[parts.index("locations") + 1]
    except (ValueError, IndexError):
        return "us"


# ────────────────────────────────────────────────────────────────
# Adapter class
# ────────────────────────────────────────────────────────────────


class GoogleDocAiVisionExtractor:
    """Doc AI Form Parser-backed implementation of `VisionExtractorPort`.

    Constructed with a Doc AI client + processor name so tests can
    inject a fake client directly. Production wiring happens once
    per process in `api/deps.py`.
    """

    provider_name = "docai"

    def __init__(
        self,
        client: docai.DocumentProcessorServiceClient,
        processor_name: str,
    ) -> None:
        self._client = client
        self._processor_name = processor_name

    def extract_from_image(
        self, image: bytes, content_type: str
    ) -> PhotoExtractionOutcome:
        if not image:
            # Route + preprocessor + service all guard this; adapter is
            # the last line of defence so the contract "non-empty bytes
            # in" is honest.
            return _error(
                ExtractionErrorKind.IMAGE_DECODE_FAILED,
                "No image bytes were supplied.",
            )

        request = docai.ProcessRequest(
            name=self._processor_name,
            raw_document=docai.RawDocument(
                content=image,
                mime_type=content_type or "image/jpeg",
            ),
        )

        try:
            response = self._client.process_document(request=request)
        except DeadlineExceeded:
            logger.warning("vision.docai.timeout")
            return _error(
                ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                "Doc AI timed out.",
            )
        except ResourceExhausted:
            logger.warning("vision.docai.rate_limited")
            return _error(
                ExtractionErrorKind.UPSTREAM_RATE_LIMITED,
                "Doc AI is at quota.",
            )
        except ServiceUnavailable:
            logger.warning("vision.docai.service_unavailable")
            return _error(
                ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                "Doc AI service unavailable.",
            )
        except PermissionDenied as exc:
            # Misconfiguration on the server — operator-visible. Bump to
            # error-level so it shows up in alerting; user-facing copy
            # stays calm.
            logger.error(
                "vision.docai.permission_denied",
                extra={"exc_class": exc.__class__.__name__},
            )
            return _error(
                ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                "Doc AI authorisation failed.",
            )
        except InvalidArgument:
            # The preprocessor normalises bytes upstream, so this firing
            # means Doc AI couldn't decode despite normalisation. Route
            # to IMAGE_DECODE_FAILED for the calm retake path.
            logger.warning("vision.docai.invalid_argument")
            return _error(
                ExtractionErrorKind.IMAGE_DECODE_FAILED,
                "Doc AI couldn't read the image.",
            )
        except GoogleAPICallError as exc:
            logger.warning(
                "vision.docai.api_error",
                extra={"exc_class": exc.__class__.__name__},
            )
            return _error(
                ExtractionErrorKind.UPSTREAM_UNAVAILABLE,
                "Doc AI returned an error.",
            )

        rows = _document_to_rows(response.document)
        logger.info(
            "vision.docai.extracted",
            extra={
                "image_bytes": len(image),
                "row_count": len(rows),
            },
        )
        return (
            "ok",
            PhotoExtractionResult(
                rows=tuple(rows),
                image_summary=None,
                warnings=(),
            ),
        )


def _error(kind: ExtractionErrorKind, detail: str) -> PhotoExtractionOutcome:
    return ("error", ExtractionError(kind=kind, detail=detail))


# ────────────────────────────────────────────────────────────────
# Document → rows
# ────────────────────────────────────────────────────────────────


def _document_to_rows(document: Any) -> list[PhotoExtractionRow]:
    """Pull rows out of the parsed document.

    Doc AI Form Parser surfaces two different result shapes depending
    on the document layout (pitfall #28): tabular forms emit
    `pages[].tables`; labelled forms emit `pages[].form_fields`.
    Neither is a superset. Try tables first, fall back to form_fields.
    """
    rows = _tables_to_rows(document)
    if rows:
        return rows
    return _form_fields_to_rows(document)


def _tables_to_rows(document: Any) -> list[PhotoExtractionRow]:
    """One PhotoExtractionRow per detected body row, labelled by the
    first header row."""
    full_text = getattr(document, "text", "") or ""
    photo_rows: list[PhotoExtractionRow] = []
    for page in getattr(document, "pages", ()) or ():
        for table in getattr(page, "tables", ()) or ():
            header_rows = getattr(table, "header_rows", ()) or ()
            body_rows = getattr(table, "body_rows", ()) or ()
            if not header_rows or not body_rows:
                continue
            header_cells = [
                _normalise_label(_layout_text(full_text, cell.layout))
                for cell in (header_rows[0].cells or ())
            ]
            for row in body_rows:
                merged: dict[str, tuple[str, float | None]] = {}
                for col_idx, cell in enumerate(row.cells or ()):
                    if col_idx >= len(header_cells):
                        break
                    label = header_cells[col_idx]
                    value = _repair_mojibake(
                        _layout_text(full_text, cell.layout).strip()
                    )
                    if value:
                        merged[label] = (value, _layout_confidence(cell.layout))

                name_value, name_conf = _find_field(merged, _NAME_LABELS)
                phone_value, phone_conf = _find_field(merged, _PHONE_LABELS)
                email_value, email_conf = _find_field(merged, _EMAIL_LABELS)

                if not (name_value or phone_value or email_value):
                    continue

                name_field = _field(name_value, name_conf)
                phone_field = _field(phone_value, phone_conf)
                email_field = _field(email_value, email_conf)

                photo_rows.append(
                    PhotoExtractionRow(
                        fields=ExtractedFields(
                            name=name_field,
                            phone=phone_field,
                            email=email_field,
                            has_agent=_blank(),
                            intent=_blank(),
                            timeline=_blank(),
                            financing_status=_blank(),
                            budget=_blank(),
                            area=_blank(),
                            follow_up=_blank(),
                            notes=_blank(),
                        ),
                        source_text=None,
                        row_index=len(photo_rows),
                        confidence=_min_confidence(name_field, phone_field, email_field),
                        warnings=(),
                    )
                )
    return photo_rows


def _form_fields_to_rows(document: Any) -> list[PhotoExtractionRow]:
    """Cluster form_fields by y-coordinate (Doc AI doesn't surface
    explicit row structure for label/value forms), map each cluster
    to a row."""
    items = _collect_form_field_items(document)
    if not items:
        return []
    items.sort(key=lambda t: t[3])  # by y_center

    clusters: list[list[tuple[str, str, float | None, float]]] = []
    current: list[tuple[str, str, float | None, float]] = []
    last_y: float | None = None
    for item in items:
        _, _, _, y = item
        if last_y is not None and abs(y - last_y) > _ROW_Y_THRESHOLD:
            if current:
                clusters.append(current)
            current = []
        current.append(item)
        last_y = y
    if current:
        clusters.append(current)

    rows: list[PhotoExtractionRow] = []
    for idx, cluster in enumerate(clusters):
        merged: dict[str, tuple[str, float | None]] = {}
        for label, value, conf, _y in cluster:
            if label in merged and merged[label][0]:
                # First non-empty value wins — later partials don't overwrite.
                continue
            merged[label] = (value, conf)

        name_value, name_conf = _find_field(merged, _NAME_LABELS)
        phone_value, phone_conf = _find_field(merged, _PHONE_LABELS)
        email_value, email_conf = _find_field(merged, _EMAIL_LABELS)

        if not (name_value or phone_value or email_value):
            continue

        name_field = _field(name_value, name_conf)
        phone_field = _field(phone_value, phone_conf)
        email_field = _field(email_value, email_conf)

        rows.append(
            PhotoExtractionRow(
                fields=ExtractedFields(
                    name=name_field,
                    phone=phone_field,
                    email=email_field,
                    has_agent=_blank(),
                    intent=_blank(),
                    timeline=_blank(),
                    financing_status=_blank(),
                    budget=_blank(),
                    area=_blank(),
                    follow_up=_blank(),
                    notes=_blank(),
                ),
                source_text=None,
                row_index=idx,
                confidence=_min_confidence(name_field, phone_field, email_field),
                warnings=(),
            )
        )
    return rows


def _collect_form_field_items(
    document: Any,
) -> list[tuple[str, str, float | None, float]]:
    """Walk every page's form_fields: (label, value, value_confidence, y_center)."""
    items: list[tuple[str, str, float | None, float]] = []
    full_text = getattr(document, "text", "") or ""
    for page in getattr(document, "pages", ()) or ():
        for ff in getattr(page, "form_fields", ()) or ():
            label = _normalise_label(_layout_text(full_text, ff.field_name))
            value = _repair_mojibake(
                _layout_text(full_text, ff.field_value).strip()
            )
            if not value:
                continue
            if label in _IGNORE_LABELS:
                continue
            confidence = _layout_confidence(ff.field_value)
            y_center = _layout_y_center(ff.field_value)
            items.append((label, value, confidence, y_center))
    return items


def _layout_text(full_text: str, layout: Any) -> str:
    """Resolve a Layout's text_anchor segments to the underlying string."""
    if layout is None:
        return ""
    text_anchor = getattr(layout, "text_anchor", None)
    if text_anchor is None:
        return ""
    segments = getattr(text_anchor, "text_segments", None) or []
    if not segments:
        return ""
    parts: list[str] = []
    for seg in segments:
        start_index = getattr(seg, "start_index", 0)
        end_index = getattr(seg, "end_index", 0)
        start = int(start_index) if start_index else 0
        end = int(end_index) if end_index else 0
        parts.append(full_text[start:end])
    return "".join(parts)


def _layout_confidence(layout: Any) -> float | None:
    """Pull the confidence number off a Layout, if present.

    Doc AI sometimes returns 0.0 as the "no signal" sentinel rather
    than omitting the field — treat that as None so it buckets to LOW
    instead of accidentally landing as HIGH after some future float
    comparison gets it wrong.
    """
    if layout is None:
        return None
    value = getattr(layout, "confidence", None)
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f <= 0.0:
        return None
    return f


def _layout_y_center(layout: Any) -> float:
    """Centre-y of a Layout's bounding poly, in normalised page space."""
    if layout is None:
        return 0.0
    poly = getattr(layout, "bounding_poly", None)
    if poly is None:
        return 0.0
    verts = getattr(poly, "normalized_vertices", None) or []
    if not verts:
        return 0.0
    ys: list[float] = [
        float(v.y) for v in verts if getattr(v, "y", None) is not None
    ]
    if not ys:
        return 0.0
    return sum(ys) / len(ys)


def _normalise_label(raw: str) -> str:
    """Strip trailing punctuation + lowercase + collapse whitespace so
    label-pattern matching is stable across small layout variations."""
    s = raw.strip().rstrip(":").rstrip(".").lower()
    return " ".join(s.split())


def _find_field(
    merged: dict[str, tuple[str, float | None]],
    patterns: tuple[str, ...],
) -> tuple[str | None, float | None]:
    """Return (value, confidence) for the first label matching any pattern."""
    for label, (value, conf) in merged.items():
        if not value:
            continue
        if any(p in label for p in patterns):
            return (value, conf)
    return (None, None)


def _field(value: str | None, confidence_score: float | None) -> ExtractedField:
    return ExtractedField(
        value=value if value else None,
        confidence=_bucket_confidence(confidence_score) if value else Confidence.LOW,
        alternatives=(),
    )


def _blank() -> ExtractedField:
    return ExtractedField(value=None, confidence=Confidence.LOW, alternatives=())


__all__ = [
    "GoogleDocAiVisionExtractor",
    "build_documentai_client",
]
