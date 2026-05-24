"""Feature-flag endpoint — what's turned on for this deployment.

The frontend hits this once at boot (in parallel with `/auth/me` and
`/auth/config`) and stashes the result in a Zustand store. Components
branch on the resulting flags to conditionally render new capability
behind a switch the server controls.

Today this surface carries one flag (`live_captions_enabled`). New flags
slot in here as features land — no new endpoint per flag.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from captureshark.config import Settings, get_settings

router = APIRouter(tags=["features"])


class FeatureFlags(BaseModel):
    """Boolean switches the frontend reads at boot."""

    live_captions_enabled: bool


@router.get("/features", response_model=FeatureFlags, summary="Feature flags")
def features(settings: Annotated[Settings, Depends(get_settings)]) -> FeatureFlags:
    """Return the active feature flags for this deployment."""
    return FeatureFlags(
        live_captions_enabled=settings.live_captions_enabled,
    )
