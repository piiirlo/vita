"""File uploads (/api/uploads): a CSV / TSV / Excel file becomes a table in the Uploads
database and a dataset on it, or replaces / adds to the data of an uploaded dataset.

POST /api/uploads[?dataset_id=&mode=replace|append]   the file as the raw request body
                             (X-File-Name header); stored, detected, previewed
POST /api/uploads/{id}/preview   re-read with other options
POST /api/uploads/{id}/import    start the import (a background task); poll GET /{id}
GET  /api/uploads/{id}       status and progress
DELETE /api/uploads/{id}     cancel a pending upload (its file is deleted)

The upload endpoint is async only to stream the body to disk (and stop at the size limit
without reading the rest); everything else runs in the threadpool.
"""

import os
from typing import Annotated, Literal
from urllib.parse import unquote

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.api.auth import require_user
from app.config import settings
from app.db import get_db
from app.models import Connection, Dataset, Upload, User
from app.schemas.uploads import ImportIn, ReadOptionsIn, TargetDataset, UploadOut, UploadPreview
from app.uploads import bootstrap, files
from app.uploads.excel import is_xlsx, sheet_names
from app.uploads.importer import run_import, table_columns
from app.uploads.names import dataset_name_for
from app.uploads.preview import FileKind, Target, build_preview, detect_options
from app.uploads.reading import ReadError, looks_binary

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(require_user)]
Mode = Literal["create", "replace", "append"]

ZIP_MAGIC = b"PK\x03\x04"
OLE_MAGIC = b"\xd0\xcf\x11\xe0"  # old .xls


def _max_bytes() -> int:
    return settings.vita_upload_max_mb * 1024 * 1024


def _too_big() -> HTTPException:
    return HTTPException(
        status.HTTP_413_CONTENT_TOO_LARGE,
        f"The file is larger than {settings.vita_upload_max_mb} MB, the most an upload can be.",
    )


def _uploads_connection(db: Session) -> Connection:
    conn = db.scalar(select(Connection).where(Connection.builtin == bootstrap.BUILTIN))
    if conn is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "File uploads aren't set up: the Uploads database couldn't be created at startup "
            "(see the server log).",
        )
    return conn


def uploaded_table_dataset(db: Session, dataset_id: int) -> Dataset:
    """A dataset whose data comes from an uploaded file (a table of the Uploads database)."""
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    conn = _uploads_connection(db)
    if (
        dataset.connection_id != conn.id
        or dataset.kind != "table"
        or dataset.schema != bootstrap.SCHEMA
    ):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Only datasets made from an uploaded file can get their data from a file.",
        )
    return dataset


def _get_upload(db: Session, upload_id: int) -> Upload:
    upload = db.get(Upload, upload_id)
    if upload is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Upload not found")
    return upload


def _pending(db: Session, upload_id: int) -> Upload:
    upload = _get_upload(db, upload_id)
    if upload.status != "pending" or not files.path_for(upload.token).exists():
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This upload isn't waiting for import anymore (files are kept for an hour). "
            "Upload the file again.",
        )
    return upload


def _free_dataset_name(db: Session, wanted: str) -> str:
    taken = {n.lower() for n in db.scalars(select(Dataset.name))}
    name, n = wanted, 2
    while name.lower() in taken:
        name = f"{wanted} ({n})"
        n += 1
    return name


def _kind(upload: Upload) -> FileKind:
    return "xlsx" if upload.file_kind == "xlsx" else "csv"


def _target(db: Session, upload: Upload) -> tuple[TargetDataset | None, Target | None]:
    if upload.mode == "create" or upload.dataset_id is None:
        return None, None
    dataset = db.get(Dataset, upload.dataset_id)
    if dataset is None or dataset.table_name is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "The dataset was deleted.")
    columns = table_columns(dataset.table_name)
    if not columns:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f'The table "{dataset.table_name}" no longer exists.'
        )
    return TargetDataset(id=dataset.id, name=dataset.name, table_name=dataset.table_name), columns


def _preview_out(
    db: Session, upload: Upload, options: ReadOptionsIn, detected: ReadOptionsIn, name: str
) -> UploadPreview:
    target_info, target = _target(db, upload)
    path = files.path_for(upload.token)
    kind = _kind(upload)
    try:
        preview = build_preview(path, options, kind, target, upload.mode)  # type: ignore[arg-type]
        sheets = sheet_names(path) if kind == "xlsx" else []
    except ReadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    if detected.columns is None:
        detected = detected.model_copy(update={"columns": preview.options.columns})
    return UploadPreview(
        upload_id=upload.id,
        file_name=upload.file_name,
        file_size=upload.file_size,
        file_kind=kind,
        sheets=sheets,
        mode=upload.mode,
        target=target_info,
        missing_columns=preview.missing_columns,
        dataset_name=target_info.name if target_info else name,
        options=preview.options,
        detected=detected,
        columns=preview.columns,
        rows=preview.rows,
        bad_cells=preview.bad_cells,
        problems=preview.problems,
        sampled_rows=preview.sampled_rows,
        more_rows=preview.more_rows,
    )


def _file_kind(token: str) -> FileKind:
    path = files.path_for(token)
    with path.open("rb") as f:
        head = f.read(8192)
    if head.startswith(OLE_MAGIC):
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Old Excel files (.xls) can't be read. Save the workbook as .xlsx (or CSV) and "
            "upload that.",
        )
    if head.startswith(ZIP_MAGIC):
        if is_xlsx(path):
            return "xlsx"
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "This is a zip file, not an Excel workbook or a CSV file.",
        )
    if looks_binary(head):
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "This doesn't look like a CSV, TSV, TXT or Excel (.xlsx) file.",
        )
    return "csv"


def _after_upload(
    token: str,
    file_name: str,
    size: int,
    db: Session,
    user: User,
    dataset_id: int | None,
    mode: Mode,
) -> UploadPreview:
    if size == 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The file is empty.")
    kind = _file_kind(token)
    try:
        detected = detect_options(files.path_for(token), kind)
    except ReadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    upload = Upload(
        token=token,
        file_name=file_name,
        file_size=size,
        file_kind=kind,
        status="pending",
        mode=mode,
        dataset_id=dataset_id,
        user_id=user.id,
        bad_values=[],
        warnings=[],
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)
    name = _free_dataset_name(db, dataset_name_for(file_name))
    out = _preview_out(db, upload, detected, detected, name)
    # What was detected (shown next to the user's changes in later previews).
    upload.options = out.detected.model_dump()
    db.commit()
    return out


@router.post("", response_model=UploadPreview, status_code=status.HTTP_201_CREATED)
async def upload_file(
    request: Request,
    db: DbSession,
    user: CurrentUser,
    dataset_id: int | None = None,
    mode: Mode = "create",
) -> UploadPreview:
    """The raw file as the body; its name (URL-encoded) in X-File-Name. With `dataset_id`
    and mode replace / append, the file is for that (uploaded) dataset."""
    await run_in_threadpool(_uploads_connection, db)
    if (mode == "create") != (dataset_id is None):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Replace and append need a dataset; a new upload doesn't take one.",
        )
    if dataset_id is not None:
        await run_in_threadpool(uploaded_table_dataset, db, dataset_id)
    file_name = os.path.basename(unquote(request.headers.get("x-file-name", "")).replace("\\", "/"))
    file_name = file_name.strip()[:255] or "upload.csv"
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > _max_bytes():
        raise _too_big()
    await run_in_threadpool(files.expire_stale, db)

    token = files.new_token()
    path = files.path_for(token)
    size = 0
    try:
        with path.open("wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if size > _max_bytes():
                    raise _too_big()
                out.write(chunk)
        return await run_in_threadpool(
            _after_upload, token, file_name, size, db, user, dataset_id, mode
        )
    except BaseException:
        files.delete_file(token)
        raise


@router.post("/{upload_id}/preview", response_model=UploadPreview)
def preview_upload(upload_id: int, options: ReadOptionsIn, db: DbSession) -> UploadPreview:
    upload = _pending(db, upload_id)
    detected = ReadOptionsIn.model_validate(upload.options) if upload.options else options
    name = _free_dataset_name(db, dataset_name_for(upload.file_name))
    return _preview_out(db, upload, options, detected, name)


@router.post("/{upload_id}/import", response_model=UploadOut, status_code=status.HTTP_202_ACCEPTED)
def import_upload(
    upload_id: int, payload: ImportIn, background: BackgroundTasks, db: DbSession
) -> Upload:
    _uploads_connection(db)
    upload = _pending(db, upload_id)
    if upload.mode == "create":
        name = payload.dataset_name.strip()
        if db.scalar(select(Dataset.id).where(Dataset.name == name)) is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, f'A dataset named "{name}" already exists.'
            )
    _, target = _target(db, upload)
    try:
        preview = build_preview(
            files.path_for(upload.token),
            payload.options,
            _kind(upload),
            target,
            upload.mode,  # type: ignore[arg-type]
        )
    except ReadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    blocking = [p.message for p in preview.problems if p.blocking]
    if blocking:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, " ".join(blocking))
    payload = payload.model_copy(update={"options": preview.options})
    upload.status = "importing"
    upload.options = preview.options.model_dump()
    db.commit()
    db.refresh(upload)
    # The job uses the same database as this request (tests use their own).
    factory: sessionmaker[Session] = sessionmaker(
        bind=db.get_bind(), autoflush=False, expire_on_commit=False
    )
    background.add_task(run_import, upload.id, payload, factory)
    return upload


@router.get("/{upload_id}", response_model=UploadOut)
def get_upload(upload_id: int, db: DbSession) -> Upload:
    return _get_upload(db, upload_id)


@router.delete("/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_upload(upload_id: int, db: DbSession) -> Response:
    upload = _get_upload(db, upload_id)
    if upload.status == "pending":
        files.delete_file(upload.token)
        upload.status = "cancelled"
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
