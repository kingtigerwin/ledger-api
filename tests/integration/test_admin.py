import json
from typing import TYPE_CHECKING, Any

import pytest
from boto3.dynamodb.conditions import Key

from ledger_api.admin.handler import create_admin_handler
from ledger_api.auth.users_store import UsersStore
from ledger_api.http import Handler
from tests.integration.users import seed_refresh_token, seed_user

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


def profile(table: "Table", user_id: str) -> dict[str, Any]:
    return table.get_item(Key={"pk": f"USER#{user_id}", "sk": "PROFILE"}, ConsistentRead=True).get("Item", {})


class TestEnableUser:
    class TestGivenAPendingUser:
        def test_activates_them_so_they_can_sign_in(self, handler: Handler, table: "Table") -> None:
            user = seed_user(table, "quentin", "pending", email="q@example.com")

            status, body = call(handler, "POST /api/v1/admin/users/{id}/enable", params={"id": user["id"]})

            assert status == 200
            assert body == {**user, "status": "active"}
            assert profile(table, user["id"])["status"] == "active"

    class TestGivenAnUnknownUserId:
        def test_returns_404_user_not_found_without_creating_a_profile(self, handler: Handler, table: "Table") -> None:
            status, body = call(handler, "POST /api/v1/admin/users/{id}/enable", params={"id": "no-such-user"})

            assert (status, body["error"]["code"]) == (404, "user_not_found")
            assert profile(table, "no-such-user") == {}


def refresh_tokens(table: "Table", user_id: str) -> list[dict[str, Any]]:
    return table.query(
        KeyConditionExpression=Key("pk").eq(f"USER#{user_id}") & Key("sk").begins_with("REFRESH#"),
        ConsistentRead=True,
    ).get("Items", [])


class TestDisableUser:
    class TestGivenAnActiveSignedInCustomer:
        def test_disables_them_and_deletes_every_refresh_token_so_refreshing_ends_now(
            self, handler: Handler, table: "Table"
        ) -> None:
            rita = seed_user(table, "rita", "active")
            other = seed_user(table, "other", "active")
            for token_hash in ["laptop", "phone"]:
                seed_refresh_token(table, rita["id"], token_hash)
            seed_refresh_token(table, other["id"], "tablet")

            status, body = call(handler, "POST /api/v1/admin/users/{id}/disable", params={"id": rita["id"]})

            assert status == 200
            assert body == {**rita, "status": "disabled"}
            assert profile(table, rita["id"])["status"] == "disabled"
            assert refresh_tokens(table, rita["id"]) == []
            assert len(refresh_tokens(table, other["id"])) == 1

    class TestGivenAnAdmin:
        def test_refuses_with_409_so_the_last_admin_cant_be_locked_out(self, handler: Handler, table: "Table") -> None:
            root = seed_user(table, "root", "active", role="admin")

            status, body = call(handler, "POST /api/v1/admin/users/{id}/disable", params={"id": root["id"]})

            assert (status, body["error"]["code"]) == (409, "cannot_disable_admin")
            assert profile(table, root["id"])["status"] == "active"

    class TestGivenAnUnknownUserId:
        def test_returns_404_user_not_found_without_creating_a_profile(self, handler: Handler, table: "Table") -> None:
            status, body = call(handler, "POST /api/v1/admin/users/{id}/disable", params={"id": "no-such-user"})

            assert (status, body["error"]["code"]) == (404, "user_not_found")
            assert profile(table, "no-such-user") == {}


class TestAnyOtherRoute:
    def test_returns_404_route_not_found(self, handler: Handler) -> None:
        status, body = call(handler, "DELETE /api/v1/admin/users/{id}", params={"id": "u-1"})

        assert (status, body["error"]["code"]) == (404, "route_not_found")
