from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated

from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import Inspector, inspect, select
from sqlalchemy.exc import IntegrityError, NoSuchTableError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.crypto import encrypt_password
from app.db import get_db
from app.db_errors import friendly_db_error
from app.engines import (
    ConnectionDetails,
    check_connection,
    create_engine_for,
    details_from_connection,
)
from app.models import Connection
from app.schemas.connections import (
    ColumnInfo,
    ConnectionCreate,
    ConnectionOut,
    ConnectionTestRequest,
    ConnectionUpdate,
    TableInfo,
    TestResult,
)

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]

# Schemas that only contain database internals; hidden in the browser.
SYSTEM_SCHEMAS = {
    "information_schema",
    "pg_catalog",
    "pg_toast",
    "mysql",
    "performance_schema",
    "sys",
}


# ---------- helpers ----------


def _get_or_404(db: Session, connection_id: int) -> Connection:
    conn = db.get(Connection, connection_id)
    if conn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
    return conn


def _saved_details(conn: Connection) -> ConnectionDetails:
    try:
        return details_from_connection(conn)
    except InvalidToken:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "The saved password can't be decrypted. Was VITA_SECRET_KEY changed? "
            "Edit the connection and enter the password again.",
        ) from None


def _commit_or_409(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "A connection with this name already exists"
        ) from None


def _run_test(details: ConnectionDetails) -> TestResult:
    try:
        check_connection(details)
    except Exception as exc:  # any driver/network error becomes a readable message
        return TestResult(ok=False, error=friendly_db_error(exc, details))
    return TestResult(ok=True)


@contextmanager
def _inspector(details: ConnectionDetails) -> Iterator[Inspector]:
    """Yield an inspector on the user's DB; connection errors become a 400 with a clear message."""
    engine = create_engine_for(details)
    try:
        with engine.connect() as db_conn:
            yield inspect(db_conn)
    except NoSuchTableError:
        raise
    except SQLAlchemyError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, friendly_db_error(exc, details)) from None
    finally:
        engine.dispose()


# ---------- CRUD ----------


@router.get("", response_model=list[ConnectionOut])
def list_connections(db: DbSession) -> list[Connection]:
    return list(db.scalars(select(Connection).order_by(Connection.name)))


@router.post("", response_model=ConnectionOut, status_code=status.HTTP_201_CREATED)
def create_connection(payload: ConnectionCreate, db: DbSession) -> Connection:
    conn = Connection(
        **payload.model_dump(exclude={"password"}),
        password_encrypted=encrypt_password(payload.password),
    )
    db.add(conn)
    _commit_or_409(db)
    db.refresh(conn)
    return conn


@router.post("/test", response_model=TestResult)
def test_unsaved_connection(payload: ConnectionTestRequest, db: DbSession) -> TestResult:
    password = payload.password
    if not password and payload.connection_id is not None:
        password = _saved_details(_get_or_404(db, payload.connection_id)).password
    details = ConnectionDetails(
        **payload.model_dump(exclude={"password", "connection_id"}),
        password=password,
    )
    return _run_test(details)


@router.get("/{connection_id}", response_model=ConnectionOut)
def get_connection(connection_id: int, db: DbSession) -> Connection:
    return _get_or_404(db, connection_id)


@router.put("/{connection_id}", response_model=ConnectionOut)
def update_connection(connection_id: int, payload: ConnectionUpdate, db: DbSession) -> Connection:
    conn = _get_or_404(db, connection_id)
    for field, value in payload.model_dump(exclude={"password"}).items():
        setattr(conn, field, value)
    if payload.password:
        conn.password_encrypted = encrypt_password(payload.password)
    _commit_or_409(db)
    db.refresh(conn)
    return conn


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_connection(connection_id: int, db: DbSession) -> Response:
    db.delete(_get_or_404(db, connection_id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{connection_id}/test", response_model=TestResult)
def test_saved_connection(connection_id: int, db: DbSession) -> TestResult:
    return _run_test(_saved_details(_get_or_404(db, connection_id)))


# ---------- browsing ----------


@router.get("/{connection_id}/schemas", response_model=list[str])
def list_schemas(connection_id: int, db: DbSession) -> list[str]:
    details = _saved_details(_get_or_404(db, connection_id))
    with _inspector(details) as insp:
        names = insp.get_schema_names()
    return sorted(n for n in names if n not in SYSTEM_SCHEMAS and not n.startswith("pg_temp"))


@router.get("/{connection_id}/schemas/{schema}/tables", response_model=list[TableInfo])
def list_tables(connection_id: int, schema: str, db: DbSession) -> list[TableInfo]:
    details = _saved_details(_get_or_404(db, connection_id))
    with _inspector(details) as insp:
        if not insp.has_schema(schema):
            raise HTTPException(status.HTTP_404_NOT_FOUND, f'Schema "{schema}" not found')
        tables = [TableInfo(name=n, type="table") for n in insp.get_table_names(schema=schema)]
        views = [TableInfo(name=n, type="view") for n in insp.get_view_names(schema=schema)]
    return sorted(tables + views, key=lambda t: t.name)


@router.get(
    "/{connection_id}/schemas/{schema}/tables/{table}/columns",
    response_model=list[ColumnInfo],
)
def list_columns(connection_id: int, schema: str, table: str, db: DbSession) -> list[ColumnInfo]:
    details = _saved_details(_get_or_404(db, connection_id))
    try:
        with _inspector(details) as insp:
            columns = insp.get_columns(table, schema=schema)
            pk_columns = set(insp.get_pk_constraint(table, schema=schema)["constrained_columns"])
            dialect = insp.dialect
    except NoSuchTableError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f'Table "{schema}.{table}" not found'
        ) from None

    result: list[ColumnInfo] = []
    for col in columns:
        try:
            type_name = col["type"].compile(dialect=dialect)
        except Exception:  # some exotic types can't be compiled; fall back to the class name
            type_name = type(col["type"]).__name__
        result.append(
            ColumnInfo(
                name=col["name"],
                type=type_name,
                nullable=bool(col["nullable"]),
                primary_key=col["name"] in pk_columns,
            )
        )
    return result
