"""Unit tests for the image preprocessor.

Tests the standalone module in isolation BEFORE it gets wired into
the service — the user's preferred build cadence ("test each module
separately, lock it down, then move it to the main app"). Pillow
generates fixtures at test time so we don't commit binary blobs to
the repo (and so EXIF orientations stay reproducible).

HEIC is exercised via pillow-heif decoding a runtime-generated HEIC
buffer; a real-device HEIC sample is deferred to 7e per the open
question in PHOTO_PLAN.md §12.
"""

from __future__ import annotations

import io
from typing import Final

import pytest
from PIL import Image

from captureshark.adapters.image_preprocessor import (
    PreprocessOutcome,
    PreprocessedImage,
    normalize,
)
from captureshark.domain.extraction import ExtractionError, ExtractionErrorKind

# Reasonable defaults for fixture generation. Keep small enough that
# tests run fast but big enough to be above the 200px floor.
_FIXTURE_W: Final[int] = 800
_FIXTURE_H: Final[int] = 600


def _jpeg_bytes(
    width: int = _FIXTURE_W,
    height: int = _FIXTURE_H,
    *,
    color: tuple[int, int, int] = (200, 100, 50),
    exif: bytes | None = None,
) -> bytes:
    """Generate a minimal JPEG of the given dimensions.

    `color` is the solid fill (handy for verifying the resize path
    preserves intent — a solid-color resize stays a solid color).
    `exif` is an optional raw EXIF buffer for rotation tests.
    """
    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    save_kwargs: dict[str, object] = {"format": "JPEG", "quality": 90}
    if exif is not None:
        save_kwargs["exif"] = exif
    img.save(buf, **save_kwargs)
    return buf.getvalue()


def _png_bytes(
    width: int = _FIXTURE_W,
    height: int = _FIXTURE_H,
    *,
    mode: str = "RGB",
) -> bytes:
    """Generate a minimal PNG. `mode='RGBA'` exercises the alpha-flatten
    branch in the preprocessor."""
    img = Image.new(mode, (width, height), color=(0, 200, 100, 255) if mode == "RGBA" else (0, 200, 100))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _heic_bytes(
    width: int = _FIXTURE_W, height: int = _FIXTURE_H
) -> bytes:
    """Generate a real HEIC blob via pillow-heif.

    Uses Pillow's `save(format="HEIF")` after pillow-heif registers
    the encoder; the bytes are then decodable by the same registered
    handler. Sufficient for round-tripping the HEIC code path in CI
    without committing a binary fixture.
    """
    img = Image.new("RGB", (width, height), color=(50, 50, 200))
    buf = io.BytesIO()
    img.save(buf, format="HEIF")
    return buf.getvalue()


def _exif_with_orientation(orientation: int) -> bytes:
    """Build a minimal EXIF buffer with just the Orientation tag set.

    Orientation tag is 0x0112; uses TIFF byte ordering (`MM` =
    big-endian). The byte layout follows the standard EXIF structure:
    8-byte TIFF header → IFD0 with one entry (Orientation) → padding.
    """
    img = Image.new("RGB", (10, 10), color=(0, 0, 0))
    exif = img.getexif()
    exif[0x0112] = orientation  # 0x0112 is the Orientation tag.
    return exif.tobytes()


def _expect_ok(outcome: PreprocessOutcome) -> PreprocessedImage:
    """Assert the outcome is success and return the inner image."""
    assert outcome[0] == "ok", f"expected ok, got {outcome!r}"
    return outcome[1]


def _expect_error(outcome: PreprocessOutcome) -> ExtractionError:
    """Assert the outcome is error and return the inner error."""
    assert outcome[0] == "error", f"expected error, got {outcome!r}"
    return outcome[1]


# ---- Format detection / sniffing ---------------------------------------


def test_jpeg_bytes_decode_to_normalised_jpeg() -> None:
    """Happy path: a JPEG in → a JPEG out, dimensions preserved
    (since the fixture is under the 1600px long-edge cap)."""
    result = _expect_ok(normalize(_jpeg_bytes(), "image/jpeg"))
    assert result.content_type == "image/jpeg"
    assert result.width == _FIXTURE_W
    assert result.height == _FIXTURE_H
    # Re-decode the output to confirm it's a valid JPEG.
    assert Image.open(io.BytesIO(result.bytes)).format == "JPEG"


def test_png_bytes_convert_to_jpeg_output() -> None:
    """A PNG in → a JPEG out. Content-type post-normalize is always
    image/jpeg regardless of source format."""
    result = _expect_ok(normalize(_png_bytes(), "image/png"))
    assert result.content_type == "image/jpeg"
    assert Image.open(io.BytesIO(result.bytes)).format == "JPEG"


def test_rgba_png_flattens_to_rgb_jpeg() -> None:
    """PNG with an alpha channel → JPEG (no alpha). Without the
    `convert("RGB")` step this raises during save."""
    result = _expect_ok(normalize(_png_bytes(mode="RGBA"), "image/png"))
    decoded = Image.open(io.BytesIO(result.bytes))
    assert decoded.format == "JPEG"
    assert decoded.mode == "RGB"


def test_heic_bytes_decode_via_pillow_heif() -> None:
    """HEIC end-to-end: pillow-heif registers the opener at module
    import; the same blob decodes back to RGB and re-encodes as JPEG.
    """
    result = _expect_ok(normalize(_heic_bytes(), "image/heic"))
    assert result.content_type == "image/jpeg"
    assert Image.open(io.BytesIO(result.bytes)).format == "JPEG"


def test_webp_bytes_decode_to_jpeg() -> None:
    """WEBP in → JPEG out. Pillow supports WEBP natively on the wheels
    we ship."""
    img = Image.new("RGB", (_FIXTURE_W, _FIXTURE_H), color=(0, 100, 200))
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=90)
    result = _expect_ok(normalize(buf.getvalue(), "image/webp"))
    assert result.content_type == "image/jpeg"


def test_content_type_hint_is_not_trusted() -> None:
    """A PNG mislabelled as `image/jpeg` still gets through — the
    sniffer reads the bytes, not the hint. Captures the "bad client
    mislabels blob" case the route layer guards against."""
    result = _expect_ok(normalize(_png_bytes(), "image/jpeg"))
    assert result.content_type == "image/jpeg"


# ---- EXIF orientation --------------------------------------------------


@pytest.mark.parametrize("orientation", [1, 3, 6, 8])
def test_exif_orientation_is_applied(orientation: int) -> None:
    """Orientations 1 (normal), 3 (180°), 6 (90° CW), 8 (90° CCW)
    cover the rotations that ship from real phones. The output bytes
    are EXIF-stripped, so re-reading shouldn't surface the original
    orientation tag."""
    exif = _exif_with_orientation(orientation)
    # Use a non-square fixture so transposition is observable —
    # orientations 6 and 8 swap width/height.
    src_w, src_h = 800, 400
    result = _expect_ok(
        normalize(
            _jpeg_bytes(src_w, src_h, exif=exif),
            "image/jpeg",
        )
    )
    decoded = Image.open(io.BytesIO(result.bytes))
    if orientation in (6, 8):
        # 90° rotation swaps the dimensions.
        assert (decoded.width, decoded.height) == (src_h, src_w)
    else:
        assert (decoded.width, decoded.height) == (src_w, src_h)
    # Output is EXIF-stripped — no Orientation tag should survive.
    assert not decoded.getexif().get(0x0112)


def test_malformed_exif_does_not_kill_the_request() -> None:
    """A garbled EXIF buffer logs and falls through to the
    un-transposed image rather than raising. The user gets a
    correctly-decoded photo; only the rotation hint is lost."""
    result = _expect_ok(
        normalize(
            _jpeg_bytes(exif=b"Exif\x00\x00garbage_garbage_garbage"),
            "image/jpeg",
        )
    )
    assert result.content_type == "image/jpeg"


# ---- Dimension + megapixel caps ----------------------------------------


def test_oversized_long_edge_is_resized() -> None:
    """An image larger than the long-edge cap is downscaled with
    aspect ratio preserved."""
    big_w, big_h = 4000, 2000
    result = _expect_ok(
        normalize(_jpeg_bytes(big_w, big_h), "image/jpeg", max_long_edge=1600)
    )
    # Long edge clamped to 1600; aspect ratio preserved.
    assert max(result.width, result.height) == 1600
    assert result.width / result.height == pytest.approx(big_w / big_h, abs=0.01)


def test_under_long_edge_is_not_upscaled() -> None:
    """Small images flow through at their original size (thumbnail()
    only shrinks, never enlarges)."""
    result = _expect_ok(
        normalize(_jpeg_bytes(400, 300), "image/jpeg", max_long_edge=1600)
    )
    assert (result.width, result.height) == (400, 300)


def test_megapixel_cap_rejects_huge_decodes() -> None:
    """An image whose megapixel count exceeds the cap is rejected
    BEFORE the resize step — prevents Pillow from allocating
    gigabytes of RAM on a decompression-bomb input."""
    # 5000×5000 = 25 MP, well over the 12 MP default.
    err = _expect_error(
        normalize(_jpeg_bytes(5000, 5000), "image/jpeg", max_megapixels=12)
    )
    assert err.kind is ExtractionErrorKind.IMAGE_TOO_LARGE


def test_below_min_dimension_is_rejected() -> None:
    """Images smaller than the 200px floor are rejected as
    `IMAGE_TOO_SMALL`. Almost certainly a thumbnail picked by accident."""
    err = _expect_error(
        normalize(_jpeg_bytes(100, 100), "image/jpeg", min_dimension=200)
    )
    assert err.kind is ExtractionErrorKind.IMAGE_TOO_SMALL


# ---- Rejection paths ---------------------------------------------------


def test_empty_bytes_rejected() -> None:
    """Empty input is rejected as DECODE_FAILED.

    The route layer's 0-byte check normally catches this first;
    keeping the gate here makes the module honest about its
    contract.
    """
    err = _expect_error(normalize(b"", "image/jpeg"))
    assert err.kind is ExtractionErrorKind.IMAGE_DECODE_FAILED


def test_random_bytes_rejected_as_unsupported() -> None:
    """Bytes that don't match any supported magic number are
    rejected before decode even runs."""
    err = _expect_error(normalize(b"not an image at all" + b"\x00" * 32, "image/jpeg"))
    assert err.kind is ExtractionErrorKind.UNSUPPORTED_IMAGE


def test_truncated_jpeg_decodes_as_failed() -> None:
    """A JPEG that LOOKS valid (starts with the magic number) but is
    cut off mid-decode surfaces as DECODE_FAILED, not as
    UNSUPPORTED_IMAGE.

    Distinguishing these matters for the user-facing copy: 'this
    photo format didn't work' vs. 'couldn't open that photo'.
    """
    truncated = _jpeg_bytes()[:200]  # JPEG header but not enough data
    err = _expect_error(normalize(truncated, "image/jpeg"))
    assert err.kind is ExtractionErrorKind.IMAGE_DECODE_FAILED


def test_output_strips_metadata() -> None:
    """EXIF / IPTC / XMP are not preserved in the output bytes."""
    # Source has a benign EXIF block — orientation=1 with the rest
    # default. The output should have NO EXIF at all.
    result = _expect_ok(
        normalize(
            _jpeg_bytes(exif=_exif_with_orientation(1)),
            "image/jpeg",
        )
    )
    decoded = Image.open(io.BytesIO(result.bytes))
    # `getexif()` on a metadata-free JPEG returns an empty mapping.
    assert dict(decoded.getexif()) == {}
