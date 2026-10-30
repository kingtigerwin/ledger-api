"""Shared plumbing for the HTTP API's Lambdas, like src/http.ts."""

from collections.abc import Callable
from typing import Any

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


def json_response(status: int, body: Any) -> Response:
    raise NotImplementedError


def with_errors(handler: Handler) -> Handler:
    return handler
