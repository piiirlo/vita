"""Datasets made from uploaded files: where their data came from, and who else uses their
table (deleting a dataset can drop its table only when nothing else reads it)."""

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Dataset, Upload, User
from app.schemas.datasets import UploadEvent, UploadSource
from app.uploads import bootstrap

HISTORY = 10


def is_upload_dataset(dataset: Dataset) -> bool:
    """A table dataset on a table of the Uploads database."""
    return (
        dataset.connection.builtin == bootstrap.BUILTIN
        and dataset.kind == "table"
        and dataset.schema == bootstrap.SCHEMA
        and dataset.table_name is not None
    )


def upload_source(db: Session, dataset: Dataset) -> UploadSource | None:
    """The imports into this dataset's table, newest first. Rows = the last create /
    replace plus the appends after it (what the table holds, without counting it)."""
    if not is_upload_dataset(dataset):
        return None
    done = db.execute(
        select(Upload, User.username)
        .outerjoin(User, User.id == Upload.user_id)
        .where(Upload.dataset_id == dataset.id, Upload.status == "done")
        .order_by(Upload.finished_at.desc(), Upload.id.desc())
    ).all()
    if not done:
        return None
    events = [
        UploadEvent(
            mode=u.mode,
            file_name=u.file_name,
            rows=u.row_count or 0,
            uploaded_at=u.finished_at or u.created_at,
            uploaded_by=username,
        )
        for u, username in done
    ]
    total = 0
    for event in events:
        total += event.rows
        if event.mode != "append":
            break
    latest = events[0]
    return UploadSource(
        file_name=latest.file_name,
        uploaded_at=latest.uploaded_at,
        uploaded_by=latest.uploaded_by,
        row_count=total,
        history=events[:HISTORY],
    )


def table_users(db: Session, dataset: Dataset) -> list[str]:
    """Other datasets that read this dataset's uploaded table: table datasets on it, and SQL
    datasets on the Uploads connection that mention its name."""
    table = dataset.table_name or ""
    others = db.scalars(
        select(Dataset).where(
            Dataset.connection_id == dataset.connection_id, Dataset.id != dataset.id
        )
    )
    word = re.compile(rf"(?<![\w$]){re.escape(table)}(?![\w$])", re.IGNORECASE)
    names = []
    for other in others:
        if other.kind == "table":
            if other.schema == dataset.schema and other.table_name == table:
                names.append(other.name)
        elif other.sql and word.search(other.sql):
            names.append(other.name)
    return sorted(names)
