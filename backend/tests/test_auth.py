"""Login, logout, protected endpoints, session expiry, password change, throttling."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from app import auth
from app.auth import ensure_admin_user
from app.config import settings
from app.main import app
from app.models import LoginFailure, User, UserSession
from tests.conftest import TEST_PASSWORD, TEST_USERNAME


def login(client: TestClient, username: str = TEST_USERNAME, password: str = TEST_PASSWORD):  # type: ignore[no-untyped-def]
    return client.post("/api/auth/login", json={"username": username, "password": password})


PROTECTED = [
    ("GET", "/api/connections"),
    ("POST", "/api/connections/test"),
    ("POST", "/api/query"),
    ("GET", "/api/query-history"),
    ("GET", "/api/saved-queries"),
    ("GET", "/api/datasets"),
    ("GET", "/api/datasets/1"),
    ("GET", "/api/charts"),
    ("POST", "/api/chart-data"),
    ("GET", "/api/dashboards"),
    ("DELETE", "/api/dashboards/1"),
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/password"),
]


@pytest.mark.parametrize(("method", "path"), PROTECTED)
def test_endpoints_require_login(anon_client: TestClient, method: str, path: str) -> None:
    response = anon_client.request(method, path, json={})
    assert response.status_code == 401, response.text
    assert response.json() == {"detail": "Please log in."}


def test_every_api_route_is_protected_except_health_and_login(anon_client: TestClient) -> None:
    open_paths = {"/api/health", "/api/auth/login", "/api/auth/logout"}
    for route in app.routes:
        path = getattr(route, "path", "")
        if not path.startswith("/api/") or path in open_paths:
            continue
        method = sorted(getattr(route, "methods", {"GET"}))[0]
        concrete = path.replace("{", "").replace("}", "")  # e.g. /api/charts/chart_id
        response = anon_client.request(method, concrete, json={})
        assert response.status_code in (401, 404, 405), (method, path, response.status_code)
        if response.status_code != 401:
            # Path parameters may fail to parse first; use a numeric id instead.
            numeric = "/".join("1" if p.endswith("_id") else p for p in concrete.split("/"))
            assert anon_client.request(method, numeric, json={}).status_code == 401, (method, path)


def test_health_is_open(anon_client: TestClient) -> None:
    assert anon_client.get("/api/health").status_code == 200


def test_login_me_logout(anon_client: TestClient) -> None:
    response = login(anon_client)
    assert response.status_code == 200
    assert response.json() == {"username": TEST_USERNAME}
    cookie = response.headers["set-cookie"]
    assert "vita_session=" in cookie
    assert "HttpOnly" in cookie
    assert "SameSite=lax" in cookie
    assert f"Max-Age={settings.vita_session_days * 86400}" in cookie
    assert "Secure" not in cookie  # localhost

    assert anon_client.get("/api/auth/me").json() == {"username": TEST_USERNAME}
    assert anon_client.get("/api/charts").status_code == 200

    assert anon_client.post("/api/auth/logout").status_code == 204
    assert anon_client.get("/api/auth/me").status_code == 401
    assert anon_client.get("/api/charts").status_code == 401
    # Logging out again is harmless.
    assert anon_client.post("/api/auth/logout").status_code == 204


def test_logout_ends_the_session_on_the_server(anon_client: TestClient) -> None:
    login(anon_client)
    token = anon_client.cookies["vita_session"]
    anon_client.post("/api/auth/logout")
    anon_client.cookies.set("vita_session", token)  # replaying the old cookie doesn't work
    assert anon_client.get("/api/auth/me").status_code == 401


def test_cookie_is_secure_when_not_on_localhost(anon_client: TestClient) -> None:
    response = anon_client.post(
        "https://vita.example.com/api/auth/login",
        json={"username": TEST_USERNAME, "password": TEST_PASSWORD},
    )
    assert response.status_code == 200
    assert "Secure" in response.headers["set-cookie"]


@pytest.mark.parametrize(
    ("username", "password"),
    [(TEST_USERNAME, "wrong password"), ("nobody", TEST_PASSWORD), ("TESTER", TEST_PASSWORD)],
)
def test_wrong_credentials(anon_client: TestClient, username: str, password: str) -> None:
    response = login(anon_client, username, password)
    assert response.status_code == 401
    assert response.json() == {"detail": "Wrong username or password."}
    assert "set-cookie" not in response.headers
    assert anon_client.get("/api/auth/me").status_code == 401


def test_random_cookie_is_rejected(anon_client: TestClient) -> None:
    anon_client.cookies.set("vita_session", "not-a-real-token")
    assert anon_client.get("/api/charts").status_code == 401


def test_expired_session_is_rejected(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    assert client.get("/api/auth/me").status_code == 200
    with session_factory() as db:
        db.execute(update(UserSession).values(expires_at=auth.now() - timedelta(seconds=1)))
        db.commit()
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/charts").status_code == 401
    # The next login cleans up expired sessions.
    login(client)
    with session_factory() as db:
        sessions = db.scalars(select(UserSession)).all()
        assert len(sessions) == 1 and sessions[0].expires_at > auth.now()


def test_password_change(client: TestClient, session_factory: sessionmaker[Session]) -> None:
    other = TestClient(app, base_url="http://localhost")
    assert login(other).status_code == 200

    wrong = client.post(
        "/api/auth/password", json={"current_password": "nope", "new_password": "a new password"}
    )
    assert wrong.status_code == 400
    assert wrong.json()["detail"] == "The current password is wrong."

    short = client.post(
        "/api/auth/password", json={"current_password": TEST_PASSWORD, "new_password": "short"}
    )
    assert short.status_code == 400
    assert "at least 8 characters" in short.json()["detail"]

    changed = client.post(
        "/api/auth/password",
        json={"current_password": TEST_PASSWORD, "new_password": "a new password"},
    )
    assert changed.status_code == 204
    # This session stays; the other one is logged out.
    assert client.get("/api/auth/me").status_code == 200
    assert other.get("/api/auth/me").status_code == 401

    assert login(other).status_code == 401
    assert login(other, password="a new password").status_code == 200
    with session_factory() as db:
        user = db.scalars(select(User).where(User.username == TEST_USERNAME)).one()
        assert "a new password" not in user.password_hash
        assert user.password_hash.startswith("$argon2id$")


def test_repeated_failures_are_throttled(
    anon_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    for _ in range(auth.MAX_FAILURES):
        assert login(anon_client, password="wrong").status_code == 401

    locked = login(anon_client)  # even the right password is refused while locked
    assert locked.status_code == 429
    assert locked.json()["detail"].startswith("Too many failed attempts. Try again in ")
    assert 1 <= int(locked.headers["Retry-After"]) <= 30

    # Another username from the same client is not affected.
    with session_factory() as db:
        db.add(User(username="other", password_hash=auth.hash_password(TEST_PASSWORD)))
        db.commit()
    assert login(anon_client, "other").status_code == 200

    # When the lock has passed, the right password works and resets the counter.
    with session_factory() as db:
        db.execute(update(LoginFailure).values(locked_until=auth.now() - timedelta(seconds=1)))
        db.commit()
    assert login(anon_client).status_code == 200
    with session_factory() as db:
        assert db.scalars(select(LoginFailure)).all() == []


def test_lock_grows_with_further_failures(
    anon_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    for _ in range(auth.MAX_FAILURES):
        login(anon_client, password="wrong")
    with session_factory() as db:
        db.execute(update(LoginFailure).values(locked_until=auth.now() - timedelta(seconds=1)))
        db.commit()
    assert login(anon_client, password="wrong").status_code == 401
    retry = int(login(anon_client).headers["Retry-After"])
    assert 30 < retry <= 60


def test_admin_user_is_created_from_settings(
    session_factory: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "vita_admin_username", "boss")
    monkeypatch.setattr(settings, "vita_admin_password", "first password")
    ensure_admin_user(session_factory)
    with session_factory() as db:
        user = db.scalars(select(User).where(User.username == "boss")).one()
        first_hash = user.password_hash
    assert auth.verify_password(first_hash, "first password")

    # An existing user's password is not overwritten on the next start.
    monkeypatch.setattr(settings, "vita_admin_password", "changed in env")
    ensure_admin_user(session_factory)
    with session_factory() as db:
        assert (
            db.scalars(select(User).where(User.username == "boss")).one().password_hash
            == first_hash
        )
