"""Liveness / readiness endpoint.

Used by the frontend skeleton to verify the stack is wired end-to-end, and
later by deployment tooling for liveness probes.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from captureshark.config import Settings, get_settings

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    """Shape of the health-check response."""

    status: str
    service: str
    version: str
    environment: str


@router.get("/health", response_model=HealthResponse, summary="Health check")
def health_check(settings: Annotated[Settings, Depends(get_settings)]) -> HealthResponse:
    """Return service identity. Cheap, no I/O, safe to poll."""
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        version=settings.app_version,
        environment=settings.environment,
    )
