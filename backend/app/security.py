"""Symmetric encryption for secrets at rest.

Media-server tokens and the ThePosterDB password are encrypted with a Fernet
key before being written to SQLite, so the database file never contains
plaintext credentials. The key is generated once and stored alongside the
database with owner-only permissions where the OS supports it.
"""

from __future__ import annotations

import os
import stat

from cryptography.fernet import Fernet, InvalidToken

from .config import SECRET_KEY_PATH


def _load_or_create_key() -> bytes:
    if SECRET_KEY_PATH.exists():
        return SECRET_KEY_PATH.read_bytes()

    key = Fernet.generate_key()
    SECRET_KEY_PATH.write_bytes(key)
    # Best-effort lock-down of the key file (no-op / limited effect on Windows).
    try:
        os.chmod(SECRET_KEY_PATH, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    return key


_fernet = Fernet(_load_or_create_key())


def encrypt(plaintext: str) -> str:
    """Encrypt a string, returning URL-safe base64 ciphertext."""
    if plaintext is None:
        plaintext = ""
    return _fernet.encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(ciphertext: str | None) -> str:
    """Decrypt a ciphertext produced by :func:`encrypt`.

    Returns an empty string for empty/invalid input so callers don't have to
    special-case unconfigured fields.
    """
    if not ciphertext:
        return ""
    try:
        return _fernet.decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""
