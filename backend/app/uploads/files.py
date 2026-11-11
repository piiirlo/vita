"""Uploaded files on disk while they wait for import (named by a random token, never by the
user's file name). Deleted after the import, on cancel, and after an hour."""

import logging
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Upload

log = logging.getLogger(__name__)

PENDING_FOR = timedelta(hours=1)


def upload_dir() -> Path:
    path = Path(settings.vita_upload_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def new_token() -> str:
    return secrets.token_hex(16)


def path_for(token: str) -> Path:
    if not token.isalnum():  # tokens are hex; never a path from outside
        raise ValueError("bad upload token")
    return upload_dir() / f"{token}.upload"


def delete_file(token: str) -> None:
    try:
        path_for(token).unlink(missing_ok=True)
    except OSError:
        log.warning("Couldn't delete upload file %s", token, exc_info=True)


def expire_stale(db: Session, now: datetime | None = None) -> int:
    """Pending uploads older than an hour: delete their files, mark them expired."""
    cutoff = (now or datetime.now(UTC)) - PENDING_FOR
    stale = list(
        db.scalars(select(Upload).where(Upload.status == "pending", Upload.created_at < cutoff))
    )
    for upload in stale:
        delete_file(upload.token)
        upload.status = "expired"
    if stale:
        db.commit()
    return len(stale)
