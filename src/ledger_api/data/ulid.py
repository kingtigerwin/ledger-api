"""ULIDs: 26 Crockford base32 characters; the first 10 encode milliseconds since the epoch."""

import re
import secrets
from datetime import UTC, datetime

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

# The first character is at most 7: anything higher overflows the 48-bit timestamp.
_ULID = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}")


def is_ulid(value: str) -> bool:
    return _ULID.fullmatch(value) is not None


def ulid_time(ulid: str) -> datetime:
    ms = 0
    for char in ulid[:10]:
        ms = ms * 32 + ALPHABET.index(char)
    return datetime.fromtimestamp(ms / 1000, UTC)


def new_ulid(at: datetime | None = None) -> str:
    """A ULID for `at` (now by default), as REST clients and the MCP server make them."""
    ms = int((at or datetime.now(UTC)).timestamp() * 1000)
    time = ""
    for _ in range(10):
        time = ALPHABET[ms % 32] + time
        ms //= 32
    return time + "".join(secrets.choice(ALPHABET) for _ in range(16))
