"""Refresh tokens, as the TypeScript auth Lambda made them, so the ones already stored keep refreshing."""

import base64
import hashlib
import secrets

REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
_COOKIE = "HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth"


def generate_refresh_token(user_id: str) -> str:
    """`<userId>.<random>`: the user ID finds the token's record without a separate index."""
    return f"{user_id}.{secrets.token_urlsafe(32)}"


def refresh_cookie(token: str) -> str:
    return f"refreshToken={token}; {_COOKIE}; Max-Age={REFRESH_TOKEN_TTL_SECONDS}"


def clear_refresh_cookie() -> str:
    return f"refreshToken=; {_COOKIE}; Max-Age=0"


def hash_refresh_token(token: str) -> str:
    """Only this hash is stored, so a leaked table can't be used to refresh. Base64url without padding, as Node's."""
    return base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode().rstrip("=")
