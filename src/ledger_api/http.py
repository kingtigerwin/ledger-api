"""Shared plumbing for the HTTP API's Lambdas."""

import base64
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import TypeAdapter, ValidationError

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


def issues(err: ValidationError) -> list[dict[str, Any]]:
    """Pydantic's errors in the shape zod gives the TypeScript routes: a code, the field's path and a message."""
    return [{"code": e["type"], "path": list(e["loc"]), "message": e["msg"]} for e in err.errors()]


def parse_body[T](event: Event, schema: TypeAdapter[T]) -> T:
    try:
        text = event.get("body") or ""
        raw = json.loads(base64.b64decode(text) if event.get("isBase64Encoded") else text)
    except ValueError:
        raise ApiError(400, "invalid_json", "Request body must be valid JSON") from None
    try:
        return schema.validate_python(raw)
    except ValidationError as err:
        raise ApiError(400, "validation_failed", "Request body is invalid", issues(err)) from None


def parse_query[T](event: Event, schema: TypeAdapter[T]) -> T:
    try:
        return schema.validate_python(event.get("queryStringParameters") or {})
    except ValidationError as err:
        raise ApiError(400, "validation_failed", "Query is invalid", issues(err)) from None


def json_response(status: int, body: Any, cookies: list[str] | None = None) -> Response:
    """`cookies` are Set-Cookie values; the HTTP API's payload v2 sends each as its own header."""
    res: Response = {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(body)}
    if cookies:
        res["cookies"] = cookies
    return res


def no_content(cookies: list[str] | None = None) -> Response:
    return {"statusCode": 204, "cookies": cookies} if cookies else {"statusCode": 204}


def redirect(location: str, cookies: list[str] | None = None) -> Response:
    """Sends the browser elsewhere; never stored, since each one is the answer to one sign-in."""
    res: Response = {"statusCode": 302, "headers": {"location": location, "cache-control": "no-store"}}
    if cookies:
        res["cookies"] = cookies
    return res


def read_cookie(event: Event, name: str) -> str | None:
    """A request cookie's value; the HTTP API's payload v2 gives each as `name=value`."""
    cookies: list[str] = event.get("cookies") or []
    for cookie in cookies:
        if cookie.startswith(f"{name}="):
            return cookie.removeprefix(f"{name}=")
    return None


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
