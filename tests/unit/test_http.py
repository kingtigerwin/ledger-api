import json
from typing import Any

import pytest

from ledger_api.http import ApiError, Event, Response, with_errors


def event(**overrides: Any) -> Event:
    return {"routeKey": "GET /api/v1/admin/users", "requestContext": {}, **overrides}


def body(res: Response) -> Any:
    return json.loads(res["body"])


class TestWithErrors:
    class TestGivenAHandlerThatRaisesAnApiError:
        def test_returns_its_status_and_code_as_the_apis_error_shape(self) -> None:
            def handler(_: Event) -> Response:
                raise ApiError(404, "user_not_found", "No such user")

            res = with_errors(handler)(event())

            assert res["statusCode"] == 404
            assert res["headers"] == {"content-type": "application/json"}
            assert body(res) == {"error": {"code": "user_not_found", "message": "No such user"}}

    class TestGivenAHandlerThatFailsUnexpectedly:
        def test_returns_500_internal_error_without_the_details(self, capsys: pytest.CaptureFixture[str]) -> None:
            def handler(_: Event) -> Response:
                raise RuntimeError("table users-x is missing")

            res = with_errors(handler)(event())

            assert res["statusCode"] == 500
            assert body(res) == {"error": {"code": "internal_error", "message": "Internal server error"}}

        def test_logs_it_as_unhandled_with_the_route(self, capsys: pytest.CaptureFixture[str]) -> None:
            def handler(_: Event) -> Response:
                raise RuntimeError("table users-x is missing")

            with_errors(handler)(event())

            line = json.loads(capsys.readouterr().err)
            assert line == {
                "event": "unhandled_error",
                "routeKey": "GET /api/v1/admin/users",
                "err": {"name": "RuntimeError", "message": "table users-x is missing"},
            }
