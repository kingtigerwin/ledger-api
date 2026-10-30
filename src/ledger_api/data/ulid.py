"""ULIDs: 26 Crockford base32 characters; the first 10 encode milliseconds since the epoch, like src/data/ulid.ts."""

from datetime import UTC, datetime


def is_ulid(value: str) -> bool:
    return False


def ulid_time(ulid: str) -> datetime:
    return datetime.fromtimestamp(0, UTC)
