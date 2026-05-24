"""Shared date helpers for the services layer.

Private (leading `_` in the filename) because nothing outside `services/`
should call these directly — the route layer and adapters don't reason
about wall-clock localisation, only the orchestrating services do.

Lives at the services layer (not in `domain/`) because it logs on the
fallback path. Domain code is meant to be I/O-free; logging is I/O.
The pure tz-resolution primitive (`resolve_zone`) lives in
`domain/column_mapping.py`; the layer-aware wrapper that adds the
warning lives here.
"""

from __future__ import annotations

import logging
from datetime import datetime

from captureshark.domain.column_mapping import resolve_zone

logger = logging.getLogger(__name__)


def localise_captured_at(
    captured_at: datetime,
    client_tz: str | None,
) -> datetime:
    """Return `captured_at` in the user's IANA zone, falling back to
    its existing tz (UTC, from the injected service clock) if
    `client_tz` is missing or unrecognised.

    Logs a warning on the unrecognised-but-present path so a persistent
    stream of bad zone strings stays visible without leaking PII (zone
    names are public-ish, never user-identifying).
    """
    zone = resolve_zone(client_tz)
    if zone is not None:
        return captured_at.astimezone(zone)
    if client_tz:
        logger.warning(
            "Unrecognised client_tz, falling back to UTC",
            extra={"client_tz": client_tz},
        )
    return captured_at
