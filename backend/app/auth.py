"""Users, password hashing, login sessions and failed-login throttling (no FastAPI imports).

- Passwords are hashed with argon2id; plain passwords are never stored or logged.
- A session token is random; the cookie holds the token, the DB only its SHA-256 hash.
- After MAX_FAILURES failed logins for the same username + client address within
  FAILURE_WINDOW, logins are refused for LOCK_BASE (doubling per further failure, up to
  LOCK_MAX).
"""

import hashlib
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import LoginFailure, User, UserSession

log = logging.getLogger(__name__)

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 200

MAX_FAILURES = 5
FAILURE_WINDOW = timedelta(minutes=15)
LOCK_BASE = timedelta(seconds=30)
LOCK_MAX = timedelta(minutes=15)

_hasher = PasswordHasher()
# Verified against when the username doesn't exist, so both cases take the same time.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def now() -> datetime:
    return datetime.now(UTC)


# ---------- passwords ----------


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_problem(password: str) -> str | None:
    """Why a new password is not acceptable, or None."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"The password must be at least {MIN_PASSWORD_LENGTH} characters long."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"The password can be at most {MAX_PASSWORD_LENGTH} characters long."
    return None


def set_password(user: User, password: str) -> None:
    user.password_hash = hash_password(password)


def authenticate(db: Session, username: str, password: str) -> User | None:
    user = db.scalar(select(User).where(User.username == username.strip()))
    if user is None:
        verify_password(_DUMMY_HASH, password)
        return None
    if not verify_password(user.password_hash, password):
        return None
    if _hasher.check_needs_rehash(user.password_hash):
        set_password(user, password)
    return user


# ---------- sessions ----------


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def session_lifetime() -> timedelta:
    return timedelta(days=settings.vita_session_days)


def create_session(db: Session, user: User) -> tuple[str, UserSession]:
    """Start a session; returns the token for the cookie. Also drops expired sessions."""
    db.execute(delete(UserSession).where(UserSession.expires_at <= now()))
    token = secrets.token_urlsafe(32)
    session = UserSession(
        token_hash=_token_hash(token), user_id=user.id, expires_at=now() + session_lifetime()
    )
    db.add(session)
    return token, session


def session_for_token(db: Session, token: str) -> UserSession | None:
    """The live (not expired) session for a cookie token, with its user."""
    return db.scalar(
        select(UserSession).where(
            UserSession.token_hash == _token_hash(token), UserSession.expires_at > now()
        )
    )


def end_other_sessions(db: Session, user_id: int, keep_session_id: int) -> None:
    db.execute(
        delete(UserSession).where(UserSession.user_id == user_id, UserSession.id != keep_session_id)
    )


# ---------- failed-login throttling ----------


def failure_key(username: str, client: str) -> str:
    return f"{username.strip().lower()[:200]}|{client[:190]}"


@dataclass
class Locked:
    retry_after: int  # seconds


def check_locked(db: Session, key: str) -> Locked | None:
    row = db.get(LoginFailure, key)
    if row is not None and row.locked_until is not None and row.locked_until > now():
        return Locked(retry_after=max(1, int((row.locked_until - now()).total_seconds() + 0.999)))
    return None


def record_failure(db: Session, key: str) -> None:
    current = now()
    row = db.get(LoginFailure, key)
    if row is None:
        db.add(LoginFailure(key=key, count=1, first_failed_at=current))
        return
    if row.first_failed_at < current - FAILURE_WINDOW and (
        row.locked_until is None or row.locked_until <= current
    ):
        row.count, row.first_failed_at, row.locked_until = 1, current, None
        return
    row.count += 1
    if row.count >= MAX_FAILURES:
        lock = min(LOCK_BASE * 2 ** (row.count - MAX_FAILURES), LOCK_MAX)
        row.locked_until = current + lock


def clear_failures(db: Session, key: str) -> None:
    db.execute(delete(LoginFailure).where(LoginFailure.key == key))


# ---------- admin user ----------


def ensure_admin_user(session_factory: sessionmaker[Session]) -> None:
    """Create the admin user from VITA_ADMIN_USERNAME / VITA_ADMIN_PASSWORD if it doesn't
    exist. An existing user's password is left alone (it may have been changed in the UI)."""
    username = (settings.vita_admin_username or "").strip()
    password = settings.vita_admin_password or ""
    with session_factory() as db:
        if username and db.scalar(select(User.id).where(User.username == username)):
            return
        if not username or not password:
            if db.scalar(select(User.id).limit(1)) is None:
                log.error(
                    "No Vita user exists and VITA_ADMIN_USERNAME / VITA_ADMIN_PASSWORD are not "
                    "set, so nobody can log in. Set them in .env and restart the backend."
                )
            return
        problem = password_problem(password)
        if problem:
            log.error(
                "VITA_ADMIN_PASSWORD is not acceptable: %s The admin was not created.", problem
            )
            return
        db.add(User(username=username, password_hash=hash_password(password)))
        try:
            db.commit()
        except IntegrityError:
            # Another worker process created it at the same moment.
            db.rollback()
            return
        log.info('Created the admin user "%s".', username)
