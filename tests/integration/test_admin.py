import json
from typing import TYPE_CHECKING, Any

import pytest

from ledger_api.admin.handler import create_admin_handler
from ledger_api.auth.users_store import UsersStore
from ledger_api.http import Handler
from tests.integration.users import seed_user

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

ADMIN = {"userId": "admin-1", "role": "admin", "scope": "admin:read admin:write"}
CUSTOMER = {"userId": "customer-1", "role": "customer", "scope": "transactions:read transactions:write"}


@pytest.fixture
def handler(table: "Table") -> Handler:
    return create_admin_handler(users=UsersStore(table))


def call(
    handler: Handler,
    route_key: str,
    *,
    auth: dict[str, str] = ADMIN,
    params: dict[str, str] | None = None,
    query: dict[str, str] | None = None,
) -> tuple[int, Any]:
    """Calls the handler the way the HTTP API would, behind the authorizer; returns the status and JSON body."""
    res = handler(
        {
            "routeKey": route_key,
            "pathParameters": params,
            "queryStringParameters": query,
            "requestContext": {"authorizer": {"lambda": auth}},
        }
    )
    return res["statusCode"], json.loads(res["body"])


class TestListUsersByStatus:
    class TestGivenAnAdmin:
        def test_lists_users_with_that_status_only_oldest_first_without_password_hashes(
            self, handler: Handler, table: "Table"
        ) -> None:
            pat = seed_user(table, "pat", "pending", email="pat@example.com")
            seed_user(table, "act", "active")
            older = seed_user(table, "al", "pending")

            status, body = call(handler, "GET /api/v1/admin/users", query={"status": "pending"})

            assert status == 200
            assert body == {
                "items": [
                    {
                        "id": older["id"],
                        "username": "al",
                        "role": "customer",
                        "status": "pending",
                        "createdAt": older["createdAt"],
                    },
                    {
                        "id": pat["id"],
                        "username": "pat",
                        "email": "pat@example.com",
                        "role": "customer",
                        "status": "pending",
                        "createdAt": pat["createdAt"],
                    },
                ],
                "nextCursor": None,
            }

    class TestGivenACustomer:
        def test_refuses_with_403_forbidden(self, handler: Handler) -> None:
            status, body = call(handler, "GET /api/v1/admin/users", auth=CUSTOMER, query={"status": "pending"})

            assert (status, body["error"]["code"]) == (403, "forbidden")

    class TestGivenAMissingOrUnknownStatus:
        @pytest.mark.parametrize(
            "query", [pytest.param({}, id="missing"), pytest.param({"status": "gone"}, id="unknown")]
        )
        def test_refuses_with_400_validation_failed_naming_the_field(
            self, handler: Handler, query: dict[str, str]
        ) -> None:
            status, body = call(handler, "GET /api/v1/admin/users", query=query)

            assert (status, body["error"]["code"]) == (400, "validation_failed")
            assert body["error"]["message"] == "Query is invalid"
            assert [issue["path"] for issue in body["error"]["details"]] == [["status"]]
