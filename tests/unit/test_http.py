import json
from typing import Any, Literal

import pytest

from ledger_api.http import ApiError, AuthContext, Event, Response, require_admin, with_errors


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


ADMIN = {"userId": "admin-1", "role": "admin", "scope": "admin:read admin:write"}


def as_caller(lambda_context: dict[str, str]) -> Event:
    return event(requestContext={"authorizer": {"lambda": lambda_context}})


class TestRequireAdmin:
    class TestGivenNoCallerFromTheAuthorizer:
        def test_refuses_with_401_since_the_route_is_misconfigured(self) -> None:
            with pytest.raises(ApiError) as raised:
                require_admin(event(), "admin:read")

            assert (raised.value.status, raised.value.code) == (401, "unauthorized")

    class TestGivenACallerWithoutTheAdminRoleOrTheScope:
        @pytest.mark.parametrize(
            ("caller", "scope"),
            [
                pytest.param(
                    {"userId": "c-1", "role": "customer", "scope": "admin:read admin:write"},
                    "admin:read",
                    id="a customer",
                ),
                pytest.param({**ADMIN, "scope": "admin:read"}, "admin:write", id="an admin without the scope"),
            ],
        )
        def test_refuses_with_403_forbidden(
            self, caller: dict[str, str], scope: Literal["admin:read", "admin:write"]
        ) -> None:
            with pytest.raises(ApiError) as raised:
                require_admin(as_caller(caller), scope)

            assert (raised.value.status, raised.value.code) == (403, "forbidden")

    class TestGivenAnAdminWithTheScope:
        def test_returns_the_caller(self) -> None:
            assert require_admin(as_caller(ADMIN), "admin:write") == AuthContext(
                user_id="admin-1", role="admin", scope="admin:read admin:write"
            )
