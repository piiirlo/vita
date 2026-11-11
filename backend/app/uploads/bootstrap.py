"""The built-in Uploads database: created on the metadata Postgres server at startup.

- database `vita_uploads` (VITA_UPLOADS_DB), tables in its schema `uploads`
- role `<db>_reader`: CONNECT + SELECT only, read-only by default. The built-in "Uploads"
  connection uses it, so SQL Lab / charts read uploaded tables through run_query like any
  other database.
- role `<db>_writer`: CONNECT + CREATE in schema `uploads` only (it owns the tables it
  creates, so it can replace them and insert into them). Only the upload service uses it,
  never run_query.
- neither role can connect to the metadata database (PUBLIC loses CONNECT on it).

Passwords are derived from VITA_SECRET_KEY (HMAC) and set again on every start: nothing new
to configure, and changing the key rotates them. Idempotent, and serialized with an
advisory lock so several workers can start at once.
"""

import hashlib
import hmac
import logging
from dataclasses import dataclass

import psycopg
from psycopg import sql
from sqlalchemy import select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.crypto import encrypt_password
from app.models import Connection

log = logging.getLogger(__name__)

SCHEMA = "uploads"
CONNECTION_NAME = "Uploads"
BUILTIN = "uploads"
_LOCK_ID = 7_301_012


@dataclass(frozen=True)
class UploadsServer:
    host: str
    port: int
    database: str
    reader: str
    writer: str

    def password(self, role: str) -> str:
        return derived_password(role)


def derived_password(role: str) -> str:
    key = settings.vita_secret_key.encode()
    return hmac.new(key, f"vita-uploads:{role}".encode(), hashlib.sha256).hexdigest()


def server() -> UploadsServer:
    url = make_url(settings.database_url)
    db = settings.vita_uploads_db
    return UploadsServer(
        host=url.host or "localhost",
        port=url.port or 5432,
        database=db,
        reader=f"{db}_reader",
        writer=f"{db}_writer",
    )


def _admin_conninfo(database: str) -> str:
    url = make_url(settings.database_url)
    return psycopg.conninfo.make_conninfo(
        host=url.host or "localhost",
        port=url.port or 5432,
        dbname=database,
        user=url.username or "",
        password=url.password or "",
        connect_timeout=5,
    )


def ensure_database() -> UploadsServer:
    """Create (or fix up) the Uploads database, schema and roles. Raises on failure."""
    s = server()
    meta_db = make_url(settings.database_url).database or "postgres"
    with psycopg.connect(_admin_conninfo(meta_db), autocommit=True) as admin:
        admin.execute("SELECT pg_advisory_lock(%s)", (_LOCK_ID,))
        try:
            exists = admin.execute(
                "SELECT 1 FROM pg_database WHERE datname = %s", (s.database,)
            ).fetchone()
            if not exists:
                admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(s.database)))
            for role in (s.reader, s.writer):
                if not admin.execute(
                    "SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)
                ).fetchone():
                    admin.execute(sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(role)))
                admin.execute(
                    sql.SQL(
                        "ALTER ROLE {} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
                        "NOREPLICATION NOBYPASSRLS PASSWORD {}"
                    ).format(sql.Identifier(role), sql.Literal(s.password(role)))
                )
            # The reader is read-only by default, on top of SELECT-only grants and
            # run_query's read-only transaction.
            admin.execute(
                sql.SQL("ALTER ROLE {} SET default_transaction_read_only = on").format(
                    sql.Identifier(s.reader)
                )
            )
            uploads_db = sql.Identifier(s.database)
            admin.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(uploads_db))
            admin.execute(
                sql.SQL("GRANT CONNECT ON DATABASE {} TO {}, {}").format(
                    uploads_db, sql.Identifier(s.reader), sql.Identifier(s.writer)
                )
            )
            # Neither upload role can open the metadata database.
            admin.execute(
                sql.SQL("REVOKE CONNECT, TEMPORARY ON DATABASE {} FROM PUBLIC").format(
                    sql.Identifier(meta_db)
                )
            )
        finally:
            admin.execute("SELECT pg_advisory_unlock(%s)", (_LOCK_ID,))

    with psycopg.connect(_admin_conninfo(s.database), autocommit=True) as admin:
        schema, reader, writer = (
            sql.Identifier(SCHEMA),
            sql.Identifier(s.reader),
            sql.Identifier(s.writer),
        )
        admin.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(schema))
        admin.execute(sql.SQL("REVOKE ALL ON SCHEMA public FROM PUBLIC"))
        admin.execute(sql.SQL("REVOKE ALL ON SCHEMA {} FROM PUBLIC").format(schema))
        admin.execute(sql.SQL("GRANT USAGE, CREATE ON SCHEMA {} TO {}").format(schema, writer))
        admin.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(schema, reader))
        admin.execute(
            sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(schema, reader)
        )
        admin.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA {} GRANT SELECT ON TABLES TO {}"
            ).format(writer, schema, reader)
        )
        # Tables restored from a backup (pg_restore --no-owner) belong to the admin: give them
        # back to the writer (replace / append / delete need it) and let the reader read them.
        for (table,) in admin.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = %s AND tableowner <> %s",
            (SCHEMA, s.writer),
        ).fetchall():
            admin.execute(
                sql.SQL("ALTER TABLE {} OWNER TO {}").format(sql.Identifier(SCHEMA, table), writer)
            )
        admin.execute(
            sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(schema, reader)
        )
        # The writer's search path is the uploads schema; it can't create anywhere else.
        admin.execute(sql.SQL("ALTER ROLE {} SET search_path = {}").format(writer, schema))
    return s


def ensure_connection(session: Session, s: UploadsServer) -> Connection:
    """The built-in "Uploads" connection (reader role); created or brought up to date."""
    conn = session.scalar(select(Connection).where(Connection.builtin == BUILTIN))
    if conn is None:
        taken = session.scalar(select(Connection).where(Connection.name == CONNECTION_NAME))
        conn = Connection(
            name=CONNECTION_NAME if taken is None else f"{CONNECTION_NAME} (built-in)",
            db_type="postgresql",
            builtin=BUILTIN,
        )
        session.add(conn)
    conn.host = s.host
    conn.port = s.port
    conn.database = s.database
    conn.username = s.reader
    conn.password_encrypted = encrypt_password(s.password(s.reader))
    conn.extra = None
    session.commit()
    session.refresh(conn)
    return conn


def ensure_uploads(session_factory: sessionmaker[Session]) -> Connection | None:
    """Startup: the database, roles and connection. Logged, not raised: Vita still starts
    (uploads then answer with the reason)."""
    try:
        s = ensure_database()
        with session_factory() as session:
            return ensure_connection(session, s)
    except Exception:
        log.exception("Couldn't set up the Uploads database; file uploads won't work")
        return None


def writer_conninfo(s: UploadsServer | None = None) -> str:
    s = s or server()
    return psycopg.conninfo.make_conninfo(
        host=s.host,
        port=s.port,
        dbname=s.database,
        user=s.writer,
        password=s.password(s.writer),
        connect_timeout=5,
    )
