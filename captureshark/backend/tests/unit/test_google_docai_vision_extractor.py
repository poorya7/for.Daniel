"""Adapter-level tests for `GoogleDocAiVisionExtractor`.

We exercise the boundary the adapter owns: Doc AI SDK exceptions →
domain errors, document → row conversion across both tables and
form_fields surfaces, per-cell confidence preservation (the bug-fix
regression test), row-level min-aggregation, and mojibake repair.

A small `SimpleNamespace`-built fake Doc AI client stands in for the
real SDK so we never hit the network here. The adapter uses
`getattr` defensively against the proto types, which means a fake
built from plain namespaces matches the contract.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from google.api_core.exceptions import (
    DeadlineExceeded,
    GoogleAPICallError,
    InvalidArgument,
    PermissionDenied,
    ResourceExhausted,
    ServiceUnavailable,
)

from captureshark.adapters.google_docai_vision_extractor import (
    GoogleDocAiVisionExtractor,
)
from captureshark.domain.extraction import (
    Confidence,
    ExtractionErrorKind,
)
from captureshark.domain.vision import (
    PhotoExtractionResult,
)

_PROCESSOR_NAME = "projects/test-project/locations/us/processors/abc123"


# ────────────────────────────────────────────────────────────────
# Fake Doc AI client + document builders
# ────────────────────────────────────────────────────────────────


class _FakeClient:
    """Stand-in for `DocumentProcessorServiceClient`.

    Holds a single `behaviour`: either a `_FakeResponse` (returned
    from `process_document`) or an exception (raised on call).
    Records every call for assertions about request shape.
    """

    def __init__(self, behaviour: Any) -> None:
        self._behaviour = behaviour
        self.calls: list[Any] = []

    def process_document(self, request: Any) -> Any:
        self.calls.append(request)
        if isinstance(self._behaviour, Exception):
            raise self._behaviour
        return self._behaviour


class _FakeResponse:
    def __init__(self, document: Any) -> None:
        self.document = document


def _layout(
    *,
    start: int,
    end: int,
    confidence: float | None = None,
    y_center: float | None = None,
) -> Any:
    """Build a fake Layout with a text anchor + optional confidence + y center."""
    text_anchor = SimpleNamespace(
        text_segments=[SimpleNamespace(start_index=start, end_index=end)]
    )
    bounding_poly: Any = None
    if y_center is not None:
        # Two-vertex poly centred on y_center; x doesn't matter.
        bounding_poly = SimpleNamespace(
            normalized_vertices=[
                SimpleNamespace(x=0.0, y=y_center - 0.005),
                SimpleNamespace(x=1.0, y=y_center + 0.005),
            ]
        )
    return SimpleNamespace(
        text_anchor=text_anchor,
        bounding_poly=bounding_poly,
        confidence=confidence,
    )


def _cell(text_pos: tuple[int, int], confidence: float | None = None) -> Any:
    start, end = text_pos
    return SimpleNamespace(layout=_layout(start=start, end=end, confidence=confidence))


def _row(cells: list[Any]) -> Any:
    return SimpleNamespace(cells=cells)


def _table(header: list[Any], body: list[Any]) -> Any:
    return SimpleNamespace(
        header_rows=[SimpleNamespace(cells=header)],
        body_rows=body,
    )


def _doc_with_table(text: str, tables: list[Any]) -> Any:
    """Wrap one or more tables into a Document on a single page."""
    page = SimpleNamespace(tables=tables, form_fields=[])
    return SimpleNamespace(text=text, pages=[page])


def _form_field(
    label_pos: tuple[int, int],
    value_pos: tuple[int, int],
    *,
    value_confidence: float | None = None,
    y_center: float = 0.0,
) -> Any:
    """Build a fake form_field with name + value layouts."""
    return SimpleNamespace(
        field_name=_layout(start=label_pos[0], end=label_pos[1]),
        field_value=_layout(
            start=value_pos[0],
            end=value_pos[1],
            confidence=value_confidence,
            y_center=y_center,
        ),
    )


def _doc_with_form_fields(text: str, form_fields: list[Any]) -> Any:
    page = SimpleNamespace(tables=[], form_fields=form_fields)
    return SimpleNamespace(text=text, pages=[page])


def _empty_doc() -> Any:
    return SimpleNamespace(text="", pages=[])


def _build(client: _FakeClient) -> GoogleDocAiVisionExtractor:
    return GoogleDocAiVisionExtractor(
        client=client,  # type: ignore[arg-type]
        processor_name=_PROCESSOR_NAME,
    )


# ────────────────────────────────────────────────────────────────
# Empty-input guard
# ────────────────────────────────────────────────────────────────


def test_empty_bytes_short_circuits_without_sdk_call() -> None:
    client = _FakeClient(_FakeResponse(_empty_doc()))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.IMAGE_DECODE_FAILED
    assert client.calls == []


# ────────────────────────────────────────────────────────────────
# Happy paths — tables surface
# ────────────────────────────────────────────────────────────────


def test_clean_3_column_table_parses_to_one_row_per_body_row() -> None:
    # Lay out a Document's `text` so each cell's start/end indices
    # point at the right slice. Header: "Name" "Phone" "Email"; one
    # body row: "Maria Lopez" "555-0192" "maria@example.com".
    text = "Name|Phone|Email|Maria Lopez|555-0192|maria@example.com|"
    header = [
        _cell((0, 4)),    # "Name"
        _cell((5, 10)),   # "Phone"
        _cell((11, 16)),  # "Email"
    ]
    body = [
        _row(
            [
                _cell((17, 28), confidence=0.95),  # "Maria Lopez"
                _cell((29, 37), confidence=0.88),  # "555-0192"
                _cell((38, 55), confidence=0.92),  # "maria@example.com"
            ]
        )
    ]
    doc = _doc_with_table(text, [_table(header, body)])
    client = _FakeClient(_FakeResponse(doc))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    result = outcome[1]
    assert isinstance(result, PhotoExtractionResult)
    assert len(result.rows) == 1
    row = result.rows[0]
    assert row.fields.name.value == "Maria Lopez"
    assert row.fields.phone.value == "555-0192"
    assert row.fields.email.value == "maria@example.com"
    assert result.image_summary is None
    assert result.warnings == ()


def test_multi_body_row_table_parses_to_multiple_rows_in_order() -> None:
    text = (
        "Name|Phone|"          # 0..10
        "Alpha|111-1111|"      # 11..25
        "Bravo|222-2222|"      # 26..40
    )
    header = [_cell((0, 4)), _cell((5, 10))]
    body = [
        _row([_cell((11, 16), confidence=0.95), _cell((17, 25), confidence=0.95)]),
        _row([_cell((26, 31), confidence=0.95), _cell((32, 40), confidence=0.95)]),
    ]
    doc = _doc_with_table(text, [_table(header, body)])
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    names = tuple(r.fields.name.value for r in outcome[1].rows)
    assert names == ("Alpha", "Bravo")
    assert tuple(r.row_index for r in outcome[1].rows) == (0, 1)


def test_table_without_header_or_body_rows_is_skipped() -> None:
    """Doc AI sometimes detects a table region but returns no header
    or no body — useless either way. Skip and fall through to
    form_fields (which is also empty here) → 0 rows, not an error."""
    text = "anything|"
    doc = _doc_with_table(text, [_table(header=[], body=[])])
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert outcome[1].rows == ()


def test_table_row_without_any_contact_triple_is_skipped() -> None:
    """A row whose only filled column is `Address` (no name/phone/email)
    is dropped — there's nothing to do with it on the review card."""
    text = "Name|Address|||123 Maple St|"
    header = [_cell((0, 4)), _cell((5, 12))]
    body = [
        _row([_cell((13, 13)), _cell((15, 27), confidence=0.95)]),  # Name blank
    ]
    doc = _doc_with_table(text, [_table(header, body)])
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert outcome[1].rows == ()


# ────────────────────────────────────────────────────────────────
# Per-cell confidence regression — the bug fix
# ────────────────────────────────────────────────────────────────


def test_per_cell_confidence_buckets_correctly_high_medium_low() -> None:
    """The bake-off candidate hardcoded every field to MEDIUM, which
    collapsed Slice B's low-confidence retake path. The production
    adapter MUST pull the real cell.layout.confidence and bucket
    individually.

    Map: HIGH ≥ 0.90, MEDIUM 0.70-0.90, LOW < 0.70.
    """
    text = "Name|Phone|Email|Mary|555-1234|m@x.co|"
    header = [_cell((0, 4)), _cell((5, 10)), _cell((11, 16))]
    body = [
        _row(
            [
                _cell((17, 21), confidence=0.95),  # name: HIGH
                _cell((22, 30), confidence=0.80),  # phone: MEDIUM
                _cell((31, 37), confidence=0.60),  # email: LOW
            ]
        )
    ]
    doc = _doc_with_table(text, [_table(header, body)])
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    row = outcome[1].rows[0]
    assert row.fields.name.confidence is Confidence.HIGH
    assert row.fields.phone.confidence is Confidence.MEDIUM
    assert row.fields.email.confidence is Confidence.LOW
    # Row-level confidence is the min — one LOW field → row is LOW.
    assert row.confidence is Confidence.LOW


def test_row_confidence_is_min_of_contact_triple_two_high_one_medium() -> None:
    """Two HIGH + one MEDIUM → row is MEDIUM. Verifies the
    aggregation rule isn't 'majority wins' or 'first field wins'."""
    text = "Name|Phone|Email|A|B|C|"
    header = [_cell((0, 4)), _cell((5, 10)), _cell((11, 16))]
    body = [
        _row(
            [
                _cell((17, 18), confidence=0.95),  # HIGH
                _cell((19, 20), confidence=0.95),  # HIGH
                _cell((21, 22), confidence=0.80),  # MEDIUM
            ]
        )
    ]
    doc = _doc_with_table(text, [_table(header, body)])
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert outcome[1].rows[0].confidence is Confidence.MEDIUM


def test_row_confidence_ignores_blank_fields_in_min() -> None:
    """A row with only name=HIGH and phone/email blank should be HIGH,
    not LOW — blank fields aren't 'low confidence', they're absent."""
    text = "Name|Phone|Email|Onlyname|||"
    header = [_cell((0, 4)), _cell((5, 10)), _cell((11, 16))]
    body = [
        _row(
            [
                _cell((17, 25), confidence=0.95),  # HIGH
                _cell((26, 26)),                   # blank phone
                _cell((27, 27)),                   # blank email
            ]
        )
    ]
    doc = _doc_with_table(text, [_table(header, body)])
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert outcome[1].rows[0].confidence is Confidence.HIGH


def test_missing_confidence_buckets_to_low() -> None:
    """Some Doc AI responses omit confidence on a cell. Treat as LOW
    so the row falls into the review path — better than silently
    assuming HIGH."""
    text = "Name|Phone|NoConfName|555-9999|"
    header = [_cell((0, 4)), _cell((5, 10))]
    body = [
        _row(
            [
                _cell((11, 21), confidence=None),  # no confidence
                _cell((22, 30), confidence=0.95),
            ]
        )
    ]
    doc = _doc_with_table(text, [_table(header, body)])
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert outcome[1].rows[0].fields.name.confidence is Confidence.LOW


# ────────────────────────────────────────────────────────────────
# Form_fields surface — labelled form fallback
# ────────────────────────────────────────────────────────────────


def test_form_fields_path_groups_by_y_coordinate() -> None:
    """Form_fields don't carry row structure — we cluster by y.
    Two name/phone pairs at distinct y values → 2 rows."""
    text = (
        "Name:|Alpha|Phone:|111-1111|"
        "Name:|Bravo|Phone:|222-2222|"
    )
    fields = [
        _form_field((0, 5), (6, 11), value_confidence=0.95, y_center=0.10),   # Name Alpha
        _form_field((12, 18), (19, 27), value_confidence=0.95, y_center=0.10),  # Phone 111
        _form_field((28, 33), (34, 39), value_confidence=0.95, y_center=0.30),  # Name Bravo
        _form_field((40, 46), (47, 55), value_confidence=0.95, y_center=0.30),  # Phone 222
    ]
    doc = _doc_with_form_fields(text, fields)
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert len(outcome[1].rows) == 2
    names = {r.fields.name.value for r in outcome[1].rows}
    assert names == {"Alpha", "Bravo"}


def test_form_fields_ignored_labels_dont_contaminate_clusters() -> None:
    """Labels like 'Address' / 'Signature' are dropped before clustering
    so they don't sneak into a row's merged map."""
    text = "Address:|123 Main St|Name:|Charlie|Phone:|555-3333|"
    fields = [
        _form_field((0, 8), (9, 20), value_confidence=0.95, y_center=0.20),
        _form_field((21, 26), (27, 34), value_confidence=0.95, y_center=0.20),
        _form_field((35, 41), (42, 50), value_confidence=0.95, y_center=0.20),
    ]
    doc = _doc_with_form_fields(text, fields)
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert len(outcome[1].rows) == 1
    assert outcome[1].rows[0].fields.name.value == "Charlie"


def test_form_fields_fallback_only_triggers_when_tables_empty() -> None:
    """If the document has BOTH tables (with rows) and form_fields,
    use the tables path and ignore form_fields. Belt + braces — the
    document.pages[].form_fields surface can carry stale duplicates."""
    table_text = "Name|Phone|Alpha|111-1111|"
    table_header = [_cell((0, 4)), _cell((5, 10))]
    table_body = [
        _row([_cell((11, 16), confidence=0.95), _cell((17, 25), confidence=0.95)])
    ]
    form_fields = [
        _form_field((0, 5), (0, 5), value_confidence=0.95, y_center=0.20),
    ]
    page = SimpleNamespace(
        tables=[_table(table_header, table_body)],
        form_fields=form_fields,
    )
    doc = SimpleNamespace(text=table_text, pages=[page])
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    # Only the table row should land — form_fields path is silent.
    assert len(outcome[1].rows) == 1
    assert outcome[1].rows[0].fields.name.value == "Alpha"


# ────────────────────────────────────────────────────────────────
# Mojibake repair (pitfall #29)
# ────────────────────────────────────────────────────────────────


def test_mojibake_in_extracted_value_is_repaired() -> None:
    """Some Doc AI outputs surface non-ASCII strings double-encoded.
    `Hans MÃ¼ller` should come out as `Hans Müller`, not as the
    mojibake."""
    text = "Name|Phone|Hans MÃ¼ller|555-7777|"
    header = [_cell((0, 4)), _cell((5, 10))]
    body = [
        _row([_cell((11, 23), confidence=0.95), _cell((24, 32), confidence=0.95)])
    ]
    doc = _doc_with_table(text, [_table(header, body)])
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert outcome[1].rows[0].fields.name.value == "Hans Müller"


def test_clean_ascii_value_is_passed_through_unchanged() -> None:
    """The repair is a no-op for pure ASCII — make sure we're not
    eating data by being too aggressive."""
    text = "Name|Phone|Alice Smith|555-8888|"
    header = [_cell((0, 4)), _cell((5, 10))]
    body = [
        _row([_cell((11, 22), confidence=0.95), _cell((23, 31), confidence=0.95)])
    ]
    doc = _doc_with_table(text, [_table(header, body)])
    extractor = _build(_FakeClient(_FakeResponse(doc)))

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert outcome[1].rows[0].fields.name.value == "Alice Smith"


# ────────────────────────────────────────────────────────────────
# Empty document
# ────────────────────────────────────────────────────────────────


def test_empty_document_returns_ok_with_zero_rows() -> None:
    """No tables and no form_fields → 0 rows. The route's signal gate
    (Slice B) maps this to the "retake?" surface."""
    client = _FakeClient(_FakeResponse(_empty_doc()))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "ok"
    assert outcome[1].rows == ()
    assert outcome[1].image_summary is None
    assert outcome[1].warnings == ()


# ────────────────────────────────────────────────────────────────
# Error translation — per the v1 plan §A.4 table
# ────────────────────────────────────────────────────────────────


def test_deadline_exceeded_maps_to_upstream_unavailable() -> None:
    client = _FakeClient(DeadlineExceeded("timed out"))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_UNAVAILABLE


def test_resource_exhausted_maps_to_upstream_rate_limited() -> None:
    client = _FakeClient(ResourceExhausted("over quota"))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_RATE_LIMITED


def test_service_unavailable_maps_to_upstream_unavailable() -> None:
    client = _FakeClient(ServiceUnavailable("Doc AI down"))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_UNAVAILABLE


def test_permission_denied_maps_to_upstream_unavailable() -> None:
    """Permission errors are operator misconfiguration. We log at
    error level (so it pages) but return UPSTREAM_UNAVAILABLE to the
    user — never expose 'your service account is misconfigured' in
    user-visible copy."""
    client = _FakeClient(PermissionDenied("no access to processor"))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_UNAVAILABLE


def test_invalid_argument_maps_to_image_decode_failed() -> None:
    """Doc AI raises InvalidArgument when it can't decode the image.
    Maps to IMAGE_DECODE_FAILED so the route surfaces the calm
    retake path."""
    client = _FakeClient(InvalidArgument("bad image"))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.IMAGE_DECODE_FAILED


def test_generic_google_api_call_error_maps_to_upstream_unavailable() -> None:
    """Anything else under GoogleAPICallError falls through to
    UPSTREAM_UNAVAILABLE — generic 'AI service had a problem' copy."""
    client = _FakeClient(GoogleAPICallError("kaboom"))
    extractor = _build(client)

    outcome = extractor.extract_from_image(b"\xff\xd8\xff\xe0", "image/jpeg")

    assert outcome[0] == "error"
    assert outcome[1].kind is ExtractionErrorKind.UPSTREAM_UNAVAILABLE


# ────────────────────────────────────────────────────────────────
# Request shape
# ────────────────────────────────────────────────────────────────


def test_process_document_called_with_image_bytes_and_mime_type() -> None:
    """The adapter forwards the image bytes + content-type to Doc AI
    on each call. Sanity-check the request shape."""
    doc = _empty_doc()
    client = _FakeClient(_FakeResponse(doc))
    extractor = _build(client)
    image = b"\xff\xd8\xff\xe0fake-jpeg-bytes"

    extractor.extract_from_image(image, "image/jpeg")

    assert len(client.calls) == 1
    request = client.calls[0]
    assert request.name == _PROCESSOR_NAME
    assert request.raw_document.content == image
    assert request.raw_document.mime_type == "image/jpeg"


def test_missing_content_type_falls_back_to_image_jpeg() -> None:
    """If content_type is empty string, default to image/jpeg —
    that's what the preprocessor outputs. Belt + braces."""
    doc = _empty_doc()
    client = _FakeClient(_FakeResponse(doc))
    extractor = _build(client)

    extractor.extract_from_image(b"\xff\xd8\xff\xe0", "")

    request = client.calls[0]
    assert request.raw_document.mime_type == "image/jpeg"
