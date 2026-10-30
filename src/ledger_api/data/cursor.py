"""Signed list cursors, byte for byte as src/data/cursor.ts makes them, so REST and MCP cursors stay interchangeable."""

from typing import Any


class InvalidCursorError(Exception):
    pass


def cursor_secret_from(signing_secret: str) -> str:
    return ""


def encode_cursor(key: dict[str, Any], secret: str) -> str:
    return ""


def decode_cursor(cursor: str, secret: str) -> dict[str, Any]:
    return {}
