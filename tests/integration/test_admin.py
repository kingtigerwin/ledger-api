import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, cast

import pytest
from boto3.dynamodb.conditions import Key

from ledger_api.admin.handler import create_admin_handler
from ledger_api.auth.tokens import AccessClaims, sign_access_token
from ledger_api.auth.users_store import UsersStore
from ledger_api.authorizer.handler import create_authorizer
from ledger_api.data.schemas import NewTransaction
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.http import Handler
from ledger_api.log import Level, LogEntry
from tests.integration.data import expense
from tests.integration.users import seed_refresh_token, seed_user

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

ADMIN = {"userId": "admin-1", "role": "admin", "scope": "admin:read admin:write"}
CUSTOMER = {"userId": "customer-1", "role": "customer", "scope": "transactions:read transactions:write"}


NOW = datetime(2026, 11, 1, tzinfo=UTC)


@pytest.fixture
def logged() -> list[LogEntry]:
    return []


@pytest.fixture
def handler(table: "Table", data_table: "Table", logged: list[LogEntry]) -> Handler:
    def log(entry: LogEntry, level: Level = "info") -> None:
        logged.append(entry)

    return create_admin_handler(users=UsersStore(table), transactions=TransactionsStore(data_table), log=log)


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
    return res["statusCode"], json.loads(res["body"]) if res.get("body") else None


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


DELETE_USER = "DELETE /api/v1/admin/users/{id}"


def seed_sisi(table: "Table") -> dict[str, str]:
    """The root admin, and the authorizer context of a request from them."""
    sisi = seed_user(table, "sisi", "active", role="admin")
    return {"userId": sisi["id"], "role": "admin", "scope": "admin:read admin:write"}


def seed_transaction(data_table: "Table", user_id: str) -> None:
    TransactionsStore(data_table).create(user_id, cast(NewTransaction, expense()), NOW)


def partition(table: "Table", user_id: str) -> list[dict[str, Any]]:
    return table.query(KeyConditionExpression=Key("pk").eq(f"USER#{user_id}"))["Items"]


class TestDeleteUser:
    class TestGivenSisiDeletingACustomer:
        def test_removes_everything_of_theirs_and_nothing_of_anyone_elses(
            self, handler: Handler, table: "Table", data_table: "Table"
        ) -> None:
            sisi = seed_sisi(table)
            rita = seed_user(table, "rita", "active")
            other = seed_user(table, "other", "active")
            for user_id in [rita["id"], other["id"]]:
                seed_refresh_token(table, user_id, "hash-1")
                seed_transaction(data_table, user_id)
                seed_transaction(data_table, user_id)

            status, body = call(handler, DELETE_USER, auth=sisi, params={"id": rita["id"]})

            assert (status, body) == (204, None)
            assert partition(table, rita["id"]) == []
            assert "Item" not in table.get_item(Key={"pk": "USERNAME#rita", "sk": "USERNAME"})
            assert partition(data_table, rita["id"]) == []
            assert len(partition(table, other["id"])) == 2
            assert len(partition(data_table, other["id"])) == 4

        def test_frees_their_username_for_someone_new(self, handler: Handler, table: "Table") -> None:
            sisi = seed_sisi(table)
            rita = seed_user(table, "rita", "active")

            call(handler, DELETE_USER, auth=sisi, params={"id": rita["id"]})

            assert UsersStore(table).find_by_username("rita") is None

        def test_records_who_deleted_whom_and_how_much_went(
            self, handler: Handler, table: "Table", data_table: "Table", logged: list[LogEntry]
        ) -> None:
            sisi = seed_sisi(table)
            rita = seed_user(table, "rita", "active")
            seed_transaction(data_table, rita["id"])

            call(handler, DELETE_USER, auth=sisi, params={"id": rita["id"]})

            entry = {"event": "user_deleted", "userId": rita["id"], "by": sisi["userId"], "dataItemsDeleted": 2}
            assert entry in logged

    class TestGivenACustomerWhoSignedInWithGoogle:
        def test_removes_the_google_claim_so_they_can_come_back_as_someone_new(
            self, handler: Handler, table: "Table"
        ) -> None:
            sisi = seed_sisi(table)
            store = UsersStore(table)
            gone = store.create_google_user(sub="42", username="sam-g1", email="sam@example.com", now=NOW)

            status, _ = call(handler, DELETE_USER, auth=sisi, params={"id": gone.id})

            assert status == 204
            assert store.find_by_google_sub("42") is None
            back = store.create_google_user(sub="42", username="sam-g1", email="sam@example.com", now=NOW)
            assert back.id != gone.id
            assert back.status == "active"

        def test_leaves_another_google_users_claim_alone(self, handler: Handler, table: "Table") -> None:
            sisi = seed_sisi(table)
            store = UsersStore(table)
            gone = store.create_google_user(sub="42", username="sam-g1", email="sam@example.com", now=NOW)
            kept = store.create_google_user(sub="43", username="pat-g1", email="pat@example.com", now=NOW)

            call(handler, DELETE_USER, auth=sisi, params={"id": gone.id})

            found = store.find_by_google_sub("43")
            assert found is not None and found.id == kept.id

    class TestGivenSisiDeletingThemselves:
        def test_refuses_with_409(self, handler: Handler, table: "Table") -> None:
            sisi = seed_sisi(table)

            status, body = call(handler, DELETE_USER, auth=sisi, params={"id": sisi["userId"]})

            assert (status, body["error"]["code"]) == (409, "cannot_delete_admin")
            assert profile(table, sisi["userId"])["status"] == "active"

    class TestGivenACustomer:
        def test_refuses_with_403_and_deletes_nothing(self, handler: Handler, table: "Table") -> None:
            rita = seed_user(table, "rita", "active")

            status, body = call(handler, DELETE_USER, auth=CUSTOMER, params={"id": rita["id"]})

            assert (status, body["error"]["code"]) == (403, "forbidden")
            assert profile(table, rita["id"])["status"] == "active"

    class TestGivenAnAdminTokenWithoutTheWriteScope:
        def test_refuses_with_403(self, handler: Handler, table: "Table") -> None:
            sisi = seed_sisi(table) | {"scope": "admin:read"}

            status, _ = call(handler, DELETE_USER, auth=sisi, params={"id": "anyone"})

            assert status == 403

    class TestGivenAnUnknownUserId:
        def test_returns_404_user_not_found(self, handler: Handler, table: "Table") -> None:
            sisi = seed_sisi(table)

            status, body = call(handler, DELETE_USER, auth=sisi, params={"id": "no-such-user"})

            assert (status, body["error"]["code"]) == (404, "user_not_found")

    class TestGivenADeleteThatFailsPartWay:
        def test_they_stay_disabled_and_trying_again_finishes_the_job(
            self, table: "Table", data_table: "Table", monkeypatch: pytest.MonkeyPatch
        ) -> None:
            sisi = seed_sisi(table)
            rita = seed_user(table, "rita", "active")
            seed_refresh_token(table, rita["id"], "hash-1")
            seed_transaction(data_table, rita["id"])
            transactions = TransactionsStore(data_table)
            handler = create_admin_handler(users=UsersStore(table), transactions=transactions)

            def fail(user_id: str) -> int:
                raise RuntimeError("DynamoDB is having a moment")

            with monkeypatch.context() as patch:
                patch.setattr(transactions, "delete_all", fail)
                status, _ = call(handler, DELETE_USER, auth=sisi, params={"id": rita["id"]})

            assert status == 500
            assert profile(table, rita["id"])["status"] == "disabled"

            status, _ = call(handler, DELETE_USER, auth=sisi, params={"id": rita["id"]})

            assert status == 204
            assert partition(table, rita["id"]) == []
            assert partition(data_table, rita["id"]) == []


class TestGivenAUserStillHoldingAValidAccessToken:
    """What the Lambda authorizer sees: the token is good until it expires, so the user's state has to decide."""

    def authorize(self, table: "Table", user: dict[str, Any], role: str = "customer") -> bool:
        token = sign_access_token(AccessClaims(sub=user["id"], role=role, scope="transactions:write"), "s" * 32, NOW)
        authorizer = create_authorizer(signing_secret="s" * 32, now=lambda: NOW, is_active=UsersStore(table).is_active)
        return authorizer({"headers": {"authorization": f"Bearer {token}"}})["isAuthorized"]

    def test_it_works_while_they_are_active(self, table: "Table") -> None:
        assert self.authorize(table, seed_user(table, "rita", "active"))

    def test_it_stops_working_the_moment_they_are_deleted(self, handler: Handler, table: "Table") -> None:
        sisi = seed_sisi(table)
        rita = seed_user(table, "rita", "active")

        call(handler, DELETE_USER, auth=sisi, params={"id": rita["id"]})

        assert not self.authorize(table, rita)

    def test_it_stops_when_they_are_disabled_and_works_again_when_enabled(
        self, handler: Handler, table: "Table"
    ) -> None:
        rita = seed_user(table, "rita", "active")

        call(handler, "POST /api/v1/admin/users/{id}/disable", params={"id": rita["id"]})
        assert not self.authorize(table, rita)

        call(handler, "POST /api/v1/admin/users/{id}/enable", params={"id": rita["id"]})
        assert self.authorize(table, rita)


class TestAnyOtherRoute:
    def test_returns_404_route_not_found(self, handler: Handler) -> None:
        status, body = call(handler, "PATCH /api/v1/admin/users/{id}", params={"id": "u-1"})

        assert (status, body["error"]["code"]) == (404, "route_not_found")
