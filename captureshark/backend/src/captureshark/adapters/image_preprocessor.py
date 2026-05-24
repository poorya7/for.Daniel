"""Mandatory image normalization for the photo capture path.

This module normalises every incoming photo to a clean, model-ready
JPEG before the vision adapter sees it. The pipeline:

  1. Sniff actual magic-number bytes — never trust the multipart
     content-type hint (bad clients mislabel; iOS labels canvas
     blobs `application/octet-stream`).
  2. Decode via Pillow (HEIC handled via the registered
     `pillow-heif` opener so iOS uploads work without a separate
     client conversion step).
  3. Apply EXIF orientation via `ImageOps.exif_transpose()`
     **before** any further processing. Strip-without-rotate is the
     well-known trap that ships upside-down photos with no recovery
     clue — handled defensively here.
  4. Convert to RGB JPEG (sign-in sheets don't need transparency;
     JPEG is smaller and universally accepted by every vision API).
  5. Strip all metadata (EXIF, IPTC, XMP) — privacy + smaller bytes.
  6. Resize to a bounded max long edge so per-call vision cost is
     deterministic (vision-API pricing scales with image dimensions).
  7. Reject obviously-bad inputs cleanly via error-as-data: empty,
     too-small, megapixel-cap exceeded, decode-failed, unsupported
     format. Each returns a typed `ExtractionError` the service +
     route layer already know how to surface as SSE / JSON.

Design notes:

- **Module, not Port.** Single implementation, no swap need yet.
  Promote to a Port (`ImagePreprocessorPort` Protocol + adapter)
  when a second implementation materialises (e.g. native Rust
  image-processing service). YAGNI for step 7b.
- **Pure function, no I/O outside Pillow's bytes-in / bytes-out.**
  Easy to unit-test by feeding canned bytes.
- **HEIC handler registered once at import time** via
  `pillow_heif.register_heif_opener()`. Re-registering is a no-op
  in pillow-heif, so re-imports during tests are safe.
- **Defaults pinned at function-signature level.** Long-edge and
  megapixel caps are kwargs so the bakeoff (7e) can sweep them
  without touching call sites.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from typing import Final, Literal

from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener  # type: ignore[import-untyped]

from captureshark.domain.extraction import ExtractionError, ExtractionErrorKind

# Register HEIC support with Pillow. Idempotent — safe to call on
# every import (and pytest re-imports the module a lot).
register_heif_opener()

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class PreprocessedImage:
    """Output of `normalize()` — guaranteed JPEG, EXIF-corrected,
    dimension-bounded.

    `content_type` is always `"image/jpeg"`. Callers can forward this
    straight to a vision adapter without re-sniffing — the bytes have
    been through the full normalisation pipeline.
    """

    bytes: bytes
    content_type: str
    width: int
    height: int


PreprocessOutcome = (
    tuple[Literal["ok"], PreprocessedImage]
    | tuple[Literal["error"], ExtractionError]
)


# Supported source formats — anything else is rejected before decode.
# Magic-number signatures are checked against the leading bytes; HEIC
# uses an `ftyp` box brand at offset 4 (any of several heic / heif
# variants). WEBP has a four-byte `RIFF` prefix and a `WEBP` brand at
# offset 8.
_JPEG_MAGIC: Final = b"\xff\xd8\xff"
_PNG_MAGIC: Final = b"\x89PNG\r\n\x1a\n"
_HEIC_BRANDS: Final = frozenset(
    {b"heic", b"heix", b"hevc", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1"}
)

# Default caps — both can be overridden per-call. The 1500 px long-edge
# is the winner from the session-09 downsampling sweep (98% accuracy,
# 2.4 s p50 latency, 6-15x less bandwidth than full-size iPhone photos).
# Lower than 1500 (we tried 1024) lost 2.3 pp accuracy on the structural
# test corpus; higher (2000 / no shrink) gave no accuracy win for more
# bandwidth + latency. See `docs/_tables/01_photo_extraction/05_image_downsample.md`.
#
# The 25 MP ceiling covers standard iPhone (12.19 MP at 4032×3024) and
# most flagship Android sensors while still guarding against
# decompression bombs (a 100 KB compressed file can blow up to gigabytes
# of RAM when decoded; 25 MP × 3 bytes/px = ~75 MB peak, comfortable
# for one uvicorn worker).
_DEFAULT_MAX_LONG_EDGE: Final[int] = 1500
_DEFAULT_MAX_MEGAPIXELS: Final[int] = 25

# Floor for "too small to read" — anything smaller is almost certainly
# a thumbnail picked by accident. 200px matches the frontend's
# client-side mechanical sanity check.
_DEFAULT_MIN_DIMENSION: Final[int] = 200

# JPEG quality on output. 90 is the sweet spot for the bakeoff —
# preserves handwriting readability while keeping file size small.
# Could shift in 7e if the bakeoff finds the model prefers different
# quality.
_OUTPUT_QUALITY: Final[int] = 90


def normalize(
    image: bytes,
    content_type_hint: str,
    *,
    max_long_edge: int = _DEFAULT_MAX_LONG_EDGE,
    max_megapixels: int = _DEFAULT_MAX_MEGAPIXELS,
    min_dimension: int = _DEFAULT_MIN_DIMENSION,
) -> PreprocessOutcome:
    """Normalise an incoming image to a clean, model-ready JPEG.

    Returns `("ok", PreprocessedImage)` on success, or
    `("error", ExtractionError)` on any failure. Never raises on
    bad-input cases — those are error-as-data. Genuinely unexpected
    crashes (e.g. a Pillow internal assertion) become
    `IMAGE_PREPROCESS_FAILED` and bubble through as a clean SSE
    error frame downstream.

    `content_type_hint` is logged but not trusted; the actual format
    comes from magic-number sniffing on the bytes.
    """
    if not image:
        # The route layer's 0-byte check normally catches this, but
        # the preprocessor is also called from unit tests directly;
        # keep the gate here so the function is honest about its
        # contract (image bytes required).
        return _error(
            ExtractionErrorKind.IMAGE_DECODE_FAILED,
            "No image bytes were supplied.",
        )

    detected = _sniff_format(image)
    if detected is None:
        logger.warning(
            "preprocess.unsupported_format",
            extra={
                "content_type_hint": content_type_hint,
                "image_bytes": len(image),
                "leading_hex": image[:12].hex(),
            },
        )
        return _error(
            ExtractionErrorKind.UNSUPPORTED_IMAGE,
            f"Image format not recognised (content-type hint: {content_type_hint!r}).",
        )

    try:
        # Annotate as the base `Image.Image` from the open: Pillow's
        # `Image.open()` returns an `ImageFile` subtype, but subsequent
        # calls like `exif_transpose()` and `convert()` return base
        # `Image` instances. Stating the base type up front lets mypy
        # accept the later reassignments without per-line casts.
        img: Image.Image = Image.open(io.BytesIO(image))
        # Force decode now so any errors surface here rather than
        # later in the pipeline (Pillow's `open` is lazy by design).
        img.load()
    except UnidentifiedImageError as exc:
        logger.warning(
            "preprocess.decode_failed_unidentified",
            extra={"detected_format": detected, "exc_class": exc.__class__.__name__},
        )
        return _error(
            ExtractionErrorKind.IMAGE_DECODE_FAILED,
            "Image bytes could not be decoded.",
        )
    except OSError as exc:
        # Pillow raises OSError for truncated / corrupted images
        # mid-decode. Same user-facing outcome as Unidentified —
        # the bytes were image-shaped but unreadable.
        logger.warning(
            "preprocess.decode_failed_oserror",
            extra={"detected_format": detected, "exc_class": exc.__class__.__name__},
        )
        return _error(
            ExtractionErrorKind.IMAGE_DECODE_FAILED,
            "Image bytes could not be decoded.",
        )
    except Exception as exc:  # noqa: BLE001 — last-resort wrap
        # Unknown Pillow crash. Log loudly + return a clean error so
        # the SSE stream stays well-formed for the user.
        logger.error(
            "preprocess.decode_failed_unexpected",
            extra={"detected_format": detected, "exc_class": exc.__class__.__name__},
        )
        return _error(
            ExtractionErrorKind.IMAGE_PREPROCESS_FAILED,
            "Image preprocessing failed unexpectedly.",
        )

    # Defensive megapixel cap BEFORE further operations. A compressed
    # 100 KB image can decode to gigabytes of RAM — Pillow's default
    # `MAX_IMAGE_PIXELS` is ~89 MP, way too permissive for our use.
    megapixels = (img.width * img.height) / 1_000_000
    if megapixels > max_megapixels:
        logger.warning(
            "preprocess.too_many_megapixels",
            extra={
                "detected_format": detected,
                "width": img.width,
                "height": img.height,
                "megapixels": round(megapixels, 2),
                "cap_mp": max_megapixels,
            },
        )
        return _error(
            ExtractionErrorKind.IMAGE_TOO_LARGE,
            f"Image dimensions ({img.width}×{img.height}) exceed the {max_megapixels} MP cap.",
        )

    # EXIF transpose BEFORE anything else touches the pixel buffer.
    # Strip-then-rotate would silently ship upside-down photos.
    try:
        img = ImageOps.exif_transpose(img) or img
    except Exception as exc:  # noqa: BLE001
        # Malformed EXIF shouldn't kill the request — log and
        # fall through to the un-transposed image. The user gets
        # an upside-down photo's worth of extraction; better than
        # a 500.
        logger.warning(
            "preprocess.exif_transpose_failed",
            extra={"exc_class": exc.__class__.__name__},
        )

    # Floor check on the transposed dimensions (EXIF rotation can
    # swap width/height, so checking after transpose is correct).
    if img.width < min_dimension or img.height < min_dimension:
        logger.info(
            "preprocess.too_small",
            extra={"width": img.width, "height": img.height, "floor": min_dimension},
        )
        return _error(
            ExtractionErrorKind.IMAGE_TOO_SMALL,
            f"Image dimensions ({img.width}×{img.height}) below the {min_dimension}px floor.",
        )

    # Sign-in sheets don't need transparency. Convert RGBA (PNG /
    # HEIC w/ alpha) to RGB by flattening on white — keeps JPEG
    # output legitimate (JPEG doesn't support alpha; saving an
    # RGBA buffer as JPEG raises).
    if img.mode != "RGB":
        try:
            img = img.convert("RGB")
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "preprocess.rgb_convert_failed",
                extra={"src_mode": img.mode, "exc_class": exc.__class__.__name__},
            )
            return _error(
                ExtractionErrorKind.IMAGE_PREPROCESS_FAILED,
                "Image preprocessing failed unexpectedly.",
            )

    # Resize to the long-edge cap if necessary. `thumbnail()` keeps
    # aspect ratio and only shrinks (never enlarges), which is the
    # behaviour we want — small images flow through unchanged.
    if max(img.width, img.height) > max_long_edge:
        img.thumbnail(
            (max_long_edge, max_long_edge),
            Image.Resampling.LANCZOS,
        )

    # Serialise to JPEG WITHOUT EXIF/IPTC/XMP. `save()` doesn't
    # preserve metadata by default unless you pass it explicitly,
    # so this is mostly defensive against future code changes
    # silently re-adding it.
    out = io.BytesIO()
    try:
        img.save(
            out,
            format="JPEG",
            quality=_OUTPUT_QUALITY,
            optimize=True,
            exif=b"",
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "preprocess.encode_failed",
            extra={"exc_class": exc.__class__.__name__},
        )
        return _error(
            ExtractionErrorKind.IMAGE_PREPROCESS_FAILED,
            "Image preprocessing failed unexpectedly.",
        )

    final_bytes = out.getvalue()
    logger.info(
        "preprocess.ok",
        extra={
            "detected_format": detected,
            "src_bytes": len(image),
            "out_bytes": len(final_bytes),
            "width": img.width,
            "height": img.height,
        },
    )
    return (
        "ok",
        PreprocessedImage(
            bytes=final_bytes,
            content_type="image/jpeg",
            width=img.width,
            height=img.height,
        ),
    )


def _sniff_format(image: bytes) -> str | None:
    """Detect image format from magic-number bytes.

    Returns one of `"jpeg"`, `"png"`, `"heic"`, `"webp"`, or `None`
    if the leading bytes don't match any supported format. Faster
    than Pillow's full identify, and runs BEFORE decode so we don't
    burn CPU on obviously-bad bytes.

    HEIC detection is structural: the ISO base media format places
    a `ftyp` box at offset 4, followed by a 4-byte brand. We accept
    any of the brands pillow-heif decodes.
    """
    if len(image) < 12:
        return None
    if image.startswith(_JPEG_MAGIC):
        return "jpeg"
    if image.startswith(_PNG_MAGIC):
        return "png"
    if image[4:8] == b"ftyp" and image[8:12] in _HEIC_BRANDS:
        return "heic"
    if image[:4] == b"RIFF" and image[8:12] == b"WEBP":
        return "webp"
    return None


def _error(kind: ExtractionErrorKind, detail: str) -> PreprocessOutcome:
    """Build a typed error outcome. Helper for readability."""
    return ("error", ExtractionError(kind=kind, detail=detail))
