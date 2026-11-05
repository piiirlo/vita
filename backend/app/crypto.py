"""Symmetric encryption for secrets stored in the metadata DB (connection passwords)."""

from cryptography.fernet import Fernet

from app.config import settings

_fernet = Fernet(settings.vita_secret_key.encode())


def encrypt_password(plain: str, fernet: Fernet | None = None) -> str:
    return (fernet or _fernet).encrypt(plain.encode()).decode()


def decrypt_password(token: str, fernet: Fernet | None = None) -> str:
    """Raises cryptography.fernet.InvalidToken if the key is wrong or the token was
    tampered with."""
    return (fernet or _fernet).decrypt(token.encode()).decode()
