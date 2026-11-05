from typing import Literal

from cryptography.fernet import Fernet
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """App settings, read from environment variables (see .env.example)."""

    model_config = SettingsConfigDict(extra="ignore")

    database_url: str
    # Fernet key used to encrypt saved connection passwords.
    vita_secret_key: str

    # The admin user, created on startup if it doesn't exist yet. An existing user's
    # password is never overwritten (use `python -m app.reset_password`).
    vita_admin_username: str | None = None
    vita_admin_password: str | None = None

    # Login sessions.
    vita_session_days: int = 7
    # "auto": Secure cookie unless the request is for localhost / 127.0.0.1.
    vita_cookie_secure: Literal["auto", "true", "false"] = "auto"

    @field_validator("vita_secret_key")
    @classmethod
    def _valid_fernet_key(cls, value: str) -> str:
        try:
            Fernet(value.encode())
        except ValueError as exc:
            raise ValueError(
                "VITA_SECRET_KEY is missing or not a valid Fernet key. "
                "See .env.example for how to generate one."
            ) from exc
        return value


settings = Settings()  # values come from the environment
