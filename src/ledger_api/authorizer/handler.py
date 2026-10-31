"""
The Lambda authorizer for every protected route. It imports only the token code, not pydantic or the
routes' modules: it runs before the first request to any route, so its cold start is everyone's. Its
results aren't cached, since a token outlives its user being disabled or deleted.
"""

from collections.abc import Callable
from datetime import datetime
from typing import Any

import jwt

from ledger_api.auth.tokens import verify_access_token

type AuthorizerResult = dict[str, Any]


def create_authorizer(
    *, signing_secret: str, now: Callable[[], datetime], is_active: Callable[[str], bool]
) -> Callable[[dict[str, Any]], AuthorizerResult]:
    """
    A simple-response authorizer: allows a valid bearer token whose user is still active, and passes its
    claims to the route as `requestContext.authorizer.lambda` (`userId`, `role`, `scope`). The user is only
    looked up once the token verifies, so junk tokens cost no read.
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
        if not is_active(claims.sub):
            return {"isAuthorized": False}
        return {"isAuthorized": True, "context": {"userId": claims.sub, "role": claims.role, "scope": claims.scope}}

    return authorize
