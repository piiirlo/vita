import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from app.api import (
    auth,
    charts,
    connections,
    dashboards,
    datasets,
    health,
    query,
    saved_queries,
    uploads,
)
from app.auth import ensure_admin_user
from app.config import settings
from app.db import SessionLocal
from app.uploads.bootstrap import ensure_uploads

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    ensure_admin_user(SessionLocal)
    if settings.vita_uploads_on_startup:
        # The Uploads database, its roles and the built-in connection (idempotent).
        ensure_uploads(SessionLocal)
    yield


app = FastAPI(title="Vita", lifespan=lifespan)

# Open: health check and the auth router (login works without a session; /me, /password
# and logout check the session themselves).
app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])

# Everything else requires a logged-in user.
login_required = [Depends(auth.require_user)]
app.include_router(
    connections.router, prefix="/api/connections", tags=["connections"], dependencies=login_required
)
app.include_router(query.router, prefix="/api", tags=["query"], dependencies=login_required)
app.include_router(
    saved_queries.router,
    prefix="/api/saved-queries",
    tags=["saved queries"],
    dependencies=login_required,
)
app.include_router(
    datasets.router, prefix="/api/datasets", tags=["datasets"], dependencies=login_required
)
app.include_router(charts.router, prefix="/api", tags=["charts"], dependencies=login_required)
app.include_router(
    dashboards.router, prefix="/api/dashboards", tags=["dashboards"], dependencies=login_required
)
app.include_router(
    uploads.router, prefix="/api/uploads", tags=["uploads"], dependencies=login_required
)
