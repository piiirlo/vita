import pytest
from cryptography.fernet import Fernet, InvalidToken

from app.crypto import decrypt_password, encrypt_password


def test_encryption_round_trip() -> None:
    token = encrypt_password("p@ss w0rd ✓")
    assert "p@ss" not in token
    assert decrypt_password(token) == "p@ss w0rd ✓"


def test_same_password_encrypts_differently_each_time() -> None:
    assert encrypt_password("same") != encrypt_password("same")


def test_wrong_key_cannot_decrypt() -> None:
    token = encrypt_password("secret")
    other_key = Fernet(Fernet.generate_key())
    with pytest.raises(InvalidToken):
        decrypt_password(token, fernet=other_key)
