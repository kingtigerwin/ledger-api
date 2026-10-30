import json
from typing import Any

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
