"""
RecapShark BigQuery analytics dashboard subpackage.

Owns the FastAPI router shared by every endpoint module in this package.
Every endpoint module (feed, overview, users, sessions_list, session_detail,
dashboard) imports `router` from here and decorates its handlers with
@router.get/.post — keeps the route prefix + tags consistent across the
subpackage without each file re-declaring an APIRouter.

Public surface (imported by pipeline/routes.py for the FastAPI mount and by
sibling pipeline modules like owner_routes.py):
    - router (FastAPI APIRouter for /analytics/bq/*)
    - invalidate_response_cache (called by owner write endpoints)

See README.md for the full data flow + per-file responsibilities.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/analytics/bq", tags=["analytics-bq"])

# Re-export so legacy callers (`from analytics import invalidate_response_cache`)
# don't have to reach into the response_cache submodule.
from .response_cache import invalidate_response_cache  # noqa: E402, F401

# Endpoint modules — importing them here triggers their @router.get(...)
# decorators so the routes register on the shared `router` instance above.
# Order matters only where modules import from each other: users imports
# sessions_list, so sessions_list must be loadable first (Python handles this
# automatically, but listing them in dependency order keeps the intent clear).
from . import feed  # noqa: E402, F401
from . import overview  # noqa: E402, F401
from . import sessions_list  # noqa: E402, F401
from . import users  # noqa: E402, F401  (depends on sessions_list)
from . import session_detail  # noqa: E402, F401
from . import dashboard  # noqa: E402, F401  (depends on feed/overview/sessions_list/users)
