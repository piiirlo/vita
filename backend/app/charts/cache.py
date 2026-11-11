"""Chart-data cache in the metadata Postgres (no extra service). No FastAPI imports.

Only chart data goes through here; SQL Lab never does. The key is a hash of the connection
(id and when it last changed), the final generated SQL and the row limit, so changing the
chart, its dataset or the connection simply gives a different key: no stale results.
Entries expire after their TTL; writes clean up expired entries and keep the cache under a
size cap (oldest entries go first). Big results aren't cached at all.
"""

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models import ChartCacheEntry

DEFAULT_TTL_SECONDS = 600
# Caps (env overridable): all entries together, and one result.
MAX_TOTAL_BYTES = int(os.environ.get("VITA_CACHE_MAX_MB", "100")) * 1024 * 1024
MAX_ENTRY_BYTES = 5 * 1024 * 1024
MAX_ENTRIES = 2000
# pg advisory lock id: one cleanup at a time (parallel DELETEs of the same rows deadlock).
CLEANUP_LOCK_ID = 7_301_010


def now() -> datetime:
    """The current time (tests replace this)."""
    return datetime.now(UTC)


def cache_key(connection_id: int, connection_changed: datetime | None, sql: str, limit: int) -> str:
    raw = json.dumps(
        [connection_id, connection_changed.isoformat() if connection_changed else None, sql, limit]
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def effective_ttl(ttl: int | None) -> int:
    return DEFAULT_TTL_SECONDS if ttl is None else ttl


@dataclass(frozen=True)
class CacheHit:
    result: dict[str, Any]
    created_at: datetime


def get(db: Session, key: str) -> CacheHit | None:
    entry = db.scalar(
        select(ChartCacheEntry).where(
            ChartCacheEntry.key == key, ChartCacheEntry.expires_at > now()
        )
    )
    return CacheHit(entry.result, entry.created_at) if entry else None


def put(db: Session, key: str, connection_id: int, result: dict[str, Any], ttl: int) -> bool:
    """Store a result for `ttl` seconds (replacing an older one). Returns False when it isn't
    cached (TTL 0 or too big). Commits."""
    if ttl <= 0:
        return False
    size = len(json.dumps(result, default=str).encode())
    if size > MAX_ENTRY_BYTES:
        return False
    created = now()
    values = {
        "key": key,
        "connection_id": connection_id,
        "result": result,
        "size_bytes": size,
        "created_at": created,
        "expires_at": created + timedelta(seconds=ttl),
    }
    stmt = insert(ChartCacheEntry).values(**values)
    db.execute(stmt.on_conflict_do_update(index_elements=["key"], set_=values))
    db.commit()
    cleanup(db)
    db.commit()
    return True


def cleanup(db: Session) -> None:
    """Drop expired entries, then the oldest ones while over the size / count cap.
    Runs in the caller's transaction, at most one at a time: a writer that finds another
    cleanup running skips it (the next write cleans up)."""
    if not db.scalar(text("SELECT pg_try_advisory_xact_lock(:id)"), {"id": CLEANUP_LOCK_ID}):
        return
    db.execute(delete(ChartCacheEntry).where(ChartCacheEntry.expires_at <= now()))
    total, count = db.execute(
        select(func.coalesce(func.sum(ChartCacheEntry.size_bytes), 0), func.count())
    ).one()
    if total <= MAX_TOTAL_BYTES and count <= MAX_ENTRIES:
        return
    rows = db.execute(
        select(ChartCacheEntry.id, ChartCacheEntry.size_bytes).order_by(
            ChartCacheEntry.created_at.desc()
        )
    ).all()
    keep_bytes = 0
    drop: list[int] = []
    for index, (entry_id, size) in enumerate(rows):
        keep_bytes += size
        if keep_bytes > MAX_TOTAL_BYTES or index >= MAX_ENTRIES:
            drop.append(entry_id)
    if drop:
        db.execute(delete(ChartCacheEntry).where(ChartCacheEntry.id.in_(drop)))
