import pytest

from app.db_errors import friendly_db_error
from app.engines import ConnectionDetails, build_url


def _details(**overrides: object) -> ConnectionDetails:
    values: dict[str, object] = {
        "db_type": "mysql",
        "host": "mysql.example.com",
        "port": 3306,
        "database": "shop",
        "username": "reader",
        "password": "p@ss:word/1",
    }
    values.update(overrides)
    return ConnectionDetails(**values)  # type: ignore[arg-type]


def test_build_url_mysql_escapes_password() -> None:
    url = build_url(_details())
    assert url.drivername == "mysql+pymysql"
    assert url.password == "p@ss:word/1"
    assert url.render_as_string(hide_password=False) == (
        "mysql+pymysql://reader:p%40ss%3Aword%2F1@mysql.example.com:3306/shop"
    )


def test_build_url_postgresql() -> None:
    url = build_url(_details(db_type="postgresql", port=5432))
    assert url.drivername == "postgresql+psycopg"


def test_build_url_without_password() -> None:
    url = build_url(_details(password=None))
    assert url.password is None
    assert (
        url.render_as_string(hide_password=False)
        == "mysql+pymysql://reader@mysql.example.com:3306/shop"
    )


def test_mysql_extra_option_examples_are_real_pymysql_arguments() -> None:
    """The UI suggests these for MySQL; make sure PyMySQL actually accepts them."""
    import inspect

    import pymysql

    params = inspect.signature(pymysql.connections.Connection.__init__).parameters
    for name in ("ssl_ca", "ssl", "charset", "connect_timeout"):
        assert name in params


def test_mysql_ssl_ca_reaches_driver() -> None:
    """A missing CA file fails inside PyMySQL (so the option was passed), with a clear message."""
    from app.engines import check_connection

    details = _details(host="sampledb", extra={"ssl_ca": "/nonexistent/ca.pem"})
    with pytest.raises(FileNotFoundError) as exc_info:
        check_connection(details)
    assert "inside the backend container" in friendly_db_error(exc_info.value, details)


def test_build_url_rejects_unknown_type() -> None:
    with pytest.raises(ValueError, match="Unsupported database type"):
        build_url(_details(db_type="oracle"))


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "(1045, \"Access denied for user 'reader'@'10.0.0.1' (using password: YES)\")",
            "Wrong username or password",
        ),
        ("(1049, \"Unknown database 'shop'\")", 'Database "shop" does not exist'),
        (
            "(2003, \"Can't connect to MySQL server on 'x' ([Errno -2] Name or service not known)\")",
            "could not be found",
        ),
        ("(2003, \"Can't connect to MySQL server on 'x' (timed out)\")", "Timed out"),
        (
            "(2003, \"Can't connect to MySQL server on 'x' ([Errno 111] Connection refused)\")",
            "connection refused",
        ),
    ],
)
def test_friendly_mysql_errors(raw: str, expected: str) -> None:
    assert expected in friendly_db_error(Exception(raw), _details())


def test_localhost_refused_suggests_host_docker_internal() -> None:
    exc = Exception('connection to server at "127.0.0.1", port 5432 failed: Connection refused')
    message = friendly_db_error(exc, _details(db_type="postgresql", host="localhost"))
    assert "connection refused" in message
    assert "host.docker.internal" in message


def test_unknown_error_falls_back_to_first_line() -> None:
    message = friendly_db_error(Exception("something odd\nmore detail"), _details())
    assert message == "something odd"
