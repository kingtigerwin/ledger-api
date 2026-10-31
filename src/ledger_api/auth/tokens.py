"""Access tokens: HS256 JWTs, as the TypeScript auth Lambda (jose) signed them, so tokens it issued still verify."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any

import jwt

ACCESS_TOKEN_TTL_SECONDS = 15 * 60


@dataclass(frozen=True)
class AccessClaims:
    sub: str
    role: str
    # Space-separated, as in OAuth.
    scope: str


def sign_access_token(claims: AccessClaims, secret: str, now: datetime) -> str:
    issued_at = int(now.timestamp())
    payload = {
        "role": claims.role,
        "scope": claims.scope,
        "sub": claims.sub,
        "iat": issued_at,
        "exp": issued_at + ACCESS_TOKEN_TTL_SECONDS,
    }
    return jwt.encode(payload, secret, algorithm="HS256", headers={"typ": "JWT"})


def verify_access_token(token: str, secret: str, now: datetime) -> AccessClaims:
    """
    Raises jwt.InvalidTokenError if the token is malformed, not HS256, wrongly signed or expired at `now`.
    PyJWT only checks expiry against the system clock, so it checks the signature and claims are there, and
    expiry is checked here against `now`, as jose did (expired from the second of `exp`).
    """
    payload: dict[str, Any] = jwt.decode(
        token,
        secret,
        algorithms=["HS256"],
        options={"require": ["sub", "exp"], "verify_exp": False, "verify_iat": False, "verify_nbf": False},
    )
    exp = payload["exp"]
    if not isinstance(exp, int) or exp <= now.timestamp():
        raise jwt.ExpiredSignatureError("Signature has expired")
    return AccessClaims(sub=str(payload["sub"]), role=str(payload.get("role")), scope=str(payload.get("scope")))
