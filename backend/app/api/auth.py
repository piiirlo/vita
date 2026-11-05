"""Login, logout, current user and password change (/api/auth), plus `require_user`,
the dependency that protects every other /api router (see app/main.py)."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import auth
from app.config import settings
from app.db import get_db
from app.models import User, UserSession

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]

COOKIE_NAME = "vita_session"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}
WRONG_CREDENTIALS = "Wrong username or password."


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=auth.MAX_PASSWORD_LENGTH)


class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=auth.MAX_PASSWORD_LENGTH)
    new_password: str = Field(max_length=auth.MAX_PASSWORD_LENGTH)


class UserOut(BaseModel):
    username: str


def _unauthorized() -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, "Please log in.")


def current_session(request: Request, db: DbSession) -> UserSession:
    token = request.cookies.get(COOKIE_NAME)
    session = auth.session_for_token(db, token) if token else None
    if session is None:
        raise _unauthorized()
    return session


def require_user(session: Annotated[UserSession, Depends(current_session)]) -> User:
    """Dependency: the logged-in user, or 401."""
    return session.user


def _secure_cookie(request: Request) -> bool:
    if settings.vita_cookie_secure != "auto":
        return settings.vita_cookie_secure == "true"
    return (request.url.hostname or "") not in LOCAL_HOSTS


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/login", response_model=UserOut)
def login(payload: LoginIn, request: Request, response: Response, db: DbSession) -> UserOut:
    key = auth.failure_key(payload.username, _client(request))
    locked = auth.check_locked(db, key)
    if locked is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Too many failed attempts. Try again in {locked.retry_after} seconds.",
            headers={"Retry-After": str(locked.retry_after)},
        )
    user = auth.authenticate(db, payload.username, payload.password)
    if user is None:
        auth.record_failure(db, key)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, WRONG_CREDENTIALS)
    auth.clear_failures(db, key)
    token, _ = auth.create_session(db, user)
    db.commit()
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=int(auth.session_lifetime().total_seconds()),
        httponly=True,
        samesite="lax",
        secure=_secure_cookie(request),
        path="/",
    )
    return UserOut(username=user.username)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, db: DbSession) -> Response:
    """Ends the session (if any) and clears the cookie. Works when already logged out."""
    token = request.cookies.get(COOKIE_NAME)
    session = auth.session_for_token(db, token) if token else None
    if session is not None:
        db.delete(session)
        db.commit()
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="lax")
    return response


@router.get("/me", response_model=UserOut)
def me(user: Annotated[User, Depends(require_user)]) -> UserOut:
    return UserOut(username=user.username)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChangeIn,
    session: Annotated[UserSession, Depends(current_session)],
    db: DbSession,
) -> Response:
    """Change the password. Other sessions are logged out; this one stays."""
    user = session.user
    if not auth.verify_password(user.password_hash, payload.current_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The current password is wrong.")
    problem = auth.password_problem(payload.new_password)
    if problem:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, problem)
    auth.set_password(user, payload.new_password)
    auth.end_other_sessions(db, user.id, session.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
