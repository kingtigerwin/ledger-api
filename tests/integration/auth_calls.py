"""Calls the auth Lambda's handler the way the HTTP API would, and reads its responses."""

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ledger_api.http import Handler

REGISTER = "POST /api/v1/auth/register"
LOGIN = "POST /api/v1/auth/login"
REFRESH = "POST /api/v1/auth/refresh"
LOGOUT = "POST /api/v1/auth/logout"
ME = "GET /api/v1/auth/me"

SECRET = "test-signing-secret-of-32-bytes!"


@dataclass
class Clock:
    """A `now` the test moves."""

    at: datetime

    def __call__(self) -> datetime:
        return self.at


@dataclass(frozen=True)
class Reply:
    status: int
    body: Any
    # Set-Cookie values, as the HTTP API's payload v2 returns them.
    cookies: list[str] = field(default_factory=list[str])


def call(
    handler: Handler,
    route_key: str,
    body: Any = None,
    *,
    cookies: list[str] | None = None,
    auth: dict[str, str] | None = None,
) -> Reply:
    event: dict[str, Any] = {
        "routeKey": route_key,
        "rawPath": route_key.split(" ")[1],
        "headers": {"content-type": "application/json"},
        "requestContext": {"authorizer": {"lambda": auth}} if auth else {},
        "isBase64Encoded": False,
    }
    if body is not None:
        event["body"] = json.dumps(body)
    if cookies is not None:
        event["cookies"] = cookies
    res = handler(event)
    return Reply(res["statusCode"], json.loads(res["body"]) if res.get("body") else {}, res.get("cookies", []))


def cookie_pair(set_cookie: str) -> str:
    """The `name=value` a browser would send back."""
    return set_cookie.split(";")[0]
