"""Signed list cursors, byte for byte as src/data/cursor.ts makes them, so REST and MCP cursors stay interchangeable."""

import base64
import binascii
import hashlib
import hmac
import json
from typing import Any, cast


class InvalidCursorError(Exception):
    pass


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _sign(payload: str, secret: str) -> str:
    return _b64url(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def cursor_secret_from(signing_secret: str) -> str:
    """
    Cursors get their own key, derived from the JWT secret, so no second secret is needed and a
    cursor can never be mistaken for a token.
    """
    return _sign("ledger-api cursor key", signing_secret)


def encode_cursor(key: dict[str, Any], secret: str) -> str:
    """
    DynamoDB's LastEvaluatedKey, encoded and signed. Without the signature, a client could edit the
    key to start a page inside another customer's partition. JSON as JavaScript writes it: compact, unescaped.
    """
    payload = _b64url(json.dumps(key, separators=(",", ":"), ensure_ascii=False).encode())
    return f"{payload}.{_sign(payload, secret)}"


def decode_cursor(cursor: str, secret: str) -> dict[str, Any]:
    payload, _, signature = cursor.partition(".")
    if not payload or not signature or "." in signature:
        raise InvalidCursorError
    if not hmac.compare_digest(signature.encode(), _sign(payload, secret).encode()):
        raise InvalidCursorError
    try:
        key = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (binascii.Error, ValueError):
        raise InvalidCursorError from None
    if not isinstance(key, dict):
        raise InvalidCursorError
    return cast(dict[str, Any], key)
