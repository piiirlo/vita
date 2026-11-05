"""Turn raw driver errors (psycopg, PyMySQL) into short, human-readable messages.

Inspired by the error regexes in Superset's db_engine_specs/postgres.py and mysql.py,
but much simpler: a few substring checks, most specific first.
"""

from app.engines import ConnectionDetails

MAX_MESSAGE_LENGTH = 300

# Inside Docker these point at the backend container, not the user's machine.
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _raw_message(exc: BaseException) -> str:
    # SQLAlchemy wraps driver errors; the driver's own message is on `.orig`.
    orig = getattr(exc, "orig", None)
    return str(orig if orig is not None else exc)


def friendly_db_error(exc: BaseException, details: ConnectionDetails | None = None) -> str:
    raw = _raw_message(exc)
    low = raw.lower()

    host = f"{details.host}:{details.port}" if details else "the host"
    database = f'"{details.database}"' if details else "The database"
    user = f'"{details.username}"' if details else "this user"

    # Unknown key in "extra options": PyMySQL raises TypeError, libpq "invalid connection option".
    if isinstance(exc, TypeError) and "unexpected keyword argument" in low:
        option = raw.split("unexpected keyword argument", 1)[1].strip(" '\"")
        return f'Unknown extra option "{option}" for this database type. Check "Extra options".'
    if "invalid connection option" in low:
        option = raw.split("invalid connection option", 1)[1].strip().split()[0].strip("'\"")
        return f'Unknown extra option "{option}" for this database type. Check "Extra options".'

    # e.g. {"ssl_ca": "/path/to/ca.pem"} pointing at a file that doesn't exist.
    if isinstance(exc, FileNotFoundError):
        name = f' "{exc.filename}"' if exc.filename else ""
        return (
            f"File{name} not found. File paths in Extra options are paths inside the "
            "backend container, not on your computer."
        )

    if (
        "password authentication failed" in low
        or "access denied for user" in low
        or ("role" in low and "does not exist" in low)
        or "no password supplied" in low
    ):
        return f"Wrong username or password for user {user}."

    if ("database" in low and "does not exist" in low) or "unknown database" in low:
        return f"Database {database} does not exist on the server."

    if (
        "failed to resolve host" in low
        or "could not translate host name" in low
        or "name or service not known" in low
        or "nodename nor servname" in low
        or "temporary failure in name resolution" in low
        or "unknown mysql server host" in low
    ):
        host_name = details.host if details else "the host"
        return (
            f'Host "{host_name}" could not be found. Check the host name. '
            "(From inside Docker, use host.docker.internal for a database on your own machine.)"
        )

    if "timeout" in low or "timed out" in low:
        return (
            f"Timed out connecting to {host}. "
            "The host is not reachable, or a firewall is blocking the port."
        )

    if "connection refused" in low or "can't connect to mysql server" in low:
        message = (
            f"Could not connect to {host}: connection refused. "
            "Is the database running on that port?"
        )
        if details and details.host in LOCAL_HOSTS:
            message += (
                f' Note: "{details.host}" is the Vita backend container itself. '
                "For a database on your own machine, use host.docker.internal."
            )
        return message

    if "no route to host" in low or "network is unreachable" in low:
        return f"Host {host} is not reachable from the Vita backend."

    first_line = next((line.strip() for line in raw.splitlines() if line.strip()), raw)
    return first_line[:MAX_MESSAGE_LENGTH]
