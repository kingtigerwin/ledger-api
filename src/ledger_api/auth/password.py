"""Password hashes in the format the TypeScript auth Lambda wrote, so every stored hash still verifies."""

import base64
import hashlib
import hmac
import secrets
import unicodedata

# OWASP's recommended scrypt settings. Each hash uses about 128 MB of memory,
# so the Lambda functions that hash passwords need at least 512 MB.
N = 2**17
R = 8
P = 1
KEY_LENGTH = 32
MAX_MEMORY = 256 * 1024 * 1024


def _derive(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    normalized = unicodedata.normalize("NFC", password).encode()
    return hashlib.scrypt(normalized, salt=salt, n=n, r=r, p=p, maxmem=MAX_MEMORY, dklen=KEY_LENGTH)


def hash_password(password: str) -> str:
    """`scrypt$N$r$p$salt$hash`, so the settings can be raised later without breaking old hashes."""
    salt = secrets.token_bytes(16)
    key = _derive(password, salt, N, R, P)
    return "$".join(["scrypt", str(N), str(R), str(P), base64.b64encode(salt).decode(), base64.b64encode(key).decode()])


def verify_password(password: str, stored: str) -> bool:
    """False for anything that isn't a well-formed scrypt hash, rather than an error."""
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return False
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt, expected = base64.b64decode(parts[4], validate=True), base64.b64decode(parts[5], validate=True)
    except ValueError:
        return False
    if not salt or not expected:
        return False
    return hmac.compare_digest(_derive(password, salt, n, r, p), expected)
