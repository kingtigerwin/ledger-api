from datetime import UTC, datetime


def iso_timestamp(at: datetime) -> str:
    """As JavaScript's toISOString() writes it (milliseconds, Z), so old and new rows read and sort the same."""
    return at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"
