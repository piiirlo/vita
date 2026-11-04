from cryptography.fernet import Fernet
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """App settings, read from environment variables (see .env.example)."""

    model_config = SettingsConfigDict(extra="ignore")

    database_url: str
    # Fernet key used to encrypt saved connection passwords.
    vita_secret_key: str

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


settings = Settings()  # type: ignore[call-arg]  # values come from the environment
