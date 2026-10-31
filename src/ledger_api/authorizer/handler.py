"""
The Lambda authorizer for every protected route. It imports only the token code, not pydantic or the
routes' modules: it runs before the first request to any route, so its cold start is everyone's.
"""

from collections.abc import Callable
from datetime import datetime
from typing import Any

import jwt

from ledger_api.auth.tokens import verify_access_token

type AuthorizerResult = dict[str, Any]


def create_authorizer(
    *, signing_secret: str, now: Callable[[], datetime]
) -> Callable[[dict[str, Any]], AuthorizerResult]:
    """
    A simple-response authorizer: allows a valid bearer token and passes its claims to the route as
    `requestContext.authorizer.lambda` (`userId`, `role`, `scope`).
    """

    def authorize(event: dict[str, Any]) -> AuthorizerResult:
        headers: dict[str, str] = event.get("headers") or {}
        scheme, _, token = headers.get("authorization", "").partition(" ")
        if scheme != "Bearer" or not token:
            return {"isAuthorized": False}
        try:
            claims = verify_access_token(token, signing_secret, now())
        except jwt.InvalidTokenError:
            return {"isAuthorized": False}
        return {"isAuthorized": True, "context": {"userId": claims.sub, "role": claims.role, "scope": claims.scope}}

    return authorize
