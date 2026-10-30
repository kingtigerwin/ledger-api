"""Shared plumbing for the HTTP API's Lambdas, like src/http.ts."""

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from ledger_api.log import log

type Event = dict[str, Any]
type Response = dict[str, Any]
type Handler = Callable[[Event], Response]


class ApiError(Exception):
    """Raised anywhere in a request; `with_errors` turns it into `{ error: { code, message, details? } }`."""

    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


@dataclass(frozen=True)
class AuthContext:
    """The caller, as the Lambda authorizer passed it in `requestContext.authorizer.lambda`."""

    user_id: str
    role: str
    scope: str


def auth_context(event: Event) -> AuthContext:
    """
    Every protected route is behind the authorizer, so a missing caller means a misconfigured
    route; refuse rather than serve anonymously.
    """
    request_context: dict[str, Any] = event.get("requestContext") or {}
    authorizer: dict[str, Any] = request_context.get("authorizer") or {}
    ctx: dict[str, Any] = authorizer.get("lambda") or {}
    if not ctx.get("userId"):
        raise ApiError(401, "unauthorized", "Sign in first")
    return AuthContext(user_id=str(ctx["userId"]), role=str(ctx.get("role", "")), scope=str(ctx.get("scope", "")))


def require_admin(event: Event, scope: Literal["admin:read", "admin:write"]) -> AuthContext:
    """Admin routes need both the admin role and the scope for the kind of access."""
    ctx = auth_context(event)
    if ctx.role != "admin" or scope not in ctx.scope.split(" "):
        raise ApiError(403, "forbidden", "Admins only")
    return ctx


def json_response(status: int, body: Any) -> Response:
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(body)}


def with_errors(handler: Handler) -> Handler:
    def wrapped(event: Event) -> Response:
        try:
            return handler(event)
        except ApiError as err:
            error: dict[str, Any] = {"code": err.code, "message": err.message}
            if err.details is not None:
                error["details"] = err.details
            return json_response(err.status, {"error": error})
        except Exception as err:
            log({"event": "unhandled_error", "routeKey": event.get("routeKey"), "err": err}, "error")
            return json_response(500, {"error": {"code": "internal_error", "message": "Internal server error"}})

    return wrapped
