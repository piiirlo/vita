"""Set a user's password from the command line (e.g. when it's forgotten), and log that
user out everywhere. Creates the user if it doesn't exist.

    docker compose exec backend python -m app.reset_password [username]

Without a username, VITA_ADMIN_USERNAME is used. The password is asked twice (not echoed).
"""

import sys
from getpass import getpass

from sqlalchemy import delete, select

from app import auth
from app.config import settings
from app.db import SessionLocal
from app.models import User, UserSession


def main(argv: list[str]) -> int:
    username = (argv[1] if len(argv) > 1 else settings.vita_admin_username or "").strip()
    if not username:
        print("Usage: python -m app.reset_password <username>", file=sys.stderr)
        return 2
    password = getpass(f'New password for "{username}": ')
    problem = auth.password_problem(password)
    if problem:
        print(problem, file=sys.stderr)
        return 1
    if getpass("Repeat the new password: ") != password:
        print("The passwords don't match.", file=sys.stderr)
        return 1
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == username))
        if user is None:
            user = User(username=username)
            db.add(user)
        auth.set_password(user, password)
        db.flush()
        db.execute(delete(UserSession).where(UserSession.user_id == user.id))
        db.commit()
    print(f'Password set for "{username}". All of its sessions were logged out.')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
