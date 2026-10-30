from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pytest

from ledger_api.data.handler import create_data_handler
from ledger_api.data.ledger import Ledger
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.http import Handler
from tests.integration.data import ADMIN, call, customer, expense

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table


@pytest.fixture
def handler(data_table: "Table") -> Handler:
    ledger = Ledger(TransactionsStore(data_table), cursor_secret="test-cursor-secret", now=lambda: datetime.now(UTC))
    return create_data_handler(ledger=ledger)


def create(handler: Handler, auth: dict[str, str], body: Any) -> tuple[int, Any]:
    return call(handler, "POST /api/v1/transactions", body, auth=auth)


def get_own(handler: Handler, auth: dict[str, str], id: str) -> tuple[int, Any]:
    return call(handler, "GET /api/v1/transactions/{id}", auth=auth, params={"id": id})


def list_all(handler: Handler, query: dict[str, str], auth: dict[str, str] = ADMIN) -> tuple[int, Any]:
    return call(handler, "GET /api/v1/admin/transactions", auth=auth, query=query)


class TestTheAdminsOwnTransactions:
    class TestGivenAnAdminToken:
        def test_records_and_reads_back_a_transaction_like_any_customer(self, handler: Handler) -> None:
            body = expense()

            assert create(handler, ADMIN, body)[0] == 201
            status, fetched = get_own(handler, ADMIN, body["id"])
            assert (status, fetched["amountCents"]) == (200, 10000)


class TestListEveryonesTransactions:
    class TestGivenTransactionsFromSeveralCustomersAndTheAdmin:
        def test_lists_all_of_them_newest_first_each_with_its_owners_user_id(self, handler: Handler) -> None:
            a = expense(date="2025-01-03", amountCents=1)
            b = expense(date="2025-01-02", amountCents=2)
            c = expense(date="2025-01-01", amountCents=3)
            create(handler, customer("all-alice"), a)
            create(handler, customer("all-bob"), b)
            create(handler, ADMIN, c)

            status, body = list_all(handler, {"from": "2025-01-01", "to": "2025-01-31"})

            assert status == 200
            assert [(t["id"], t["userId"]) for t in body["items"]] == [
                (a["id"], "all-alice"),
                (b["id"], "all-bob"),
                (c["id"], "admin-1"),
            ]
            assert body["nextCursor"] is None

    class TestGivenACategoryAndASmallPageSize:
        def test_filters_by_category_and_pages_with_a_cursor(self, handler: Handler) -> None:
            for who, category, amount in [
                ("cat-alice", "dining", 1),
                ("cat-bob", "dining", 2),
                ("cat-alice", "transport", 3),
                ("cat-carol", "dining", 4),
            ]:
                create(
                    handler, customer(who), expense(date=f"2025-02-0{amount}", category=category, amountCents=amount)
                )

            seen: list[int] = []
            cursor = None
            while True:
                query = {"from": "2025-02-01", "to": "2025-02-28", "category": "dining", "limit": "2"}
                status, body = list_all(handler, query | ({"cursor": cursor} if cursor else {}))
                assert status == 200
                seen += [t["amountCents"] for t in body["items"]]
                cursor = body["nextCursor"]
                if not cursor:
                    break

            assert seen == [4, 2, 1]

    class TestGivenACustomer:
        def test_refuses_with_403_forbidden(self, handler: Handler) -> None:
            status, body = list_all(handler, {}, customer("snoop"))

            assert (status, body["error"]["code"]) == (403, "forbidden")


def admin_patch(handler: Handler, user_id: str, id: str, body: Any, auth: dict[str, str] = ADMIN) -> tuple[int, Any]:
    route = "PATCH /api/v1/admin/users/{id}/transactions/{transactionId}"
    return call(handler, route, body, auth=auth, params={"id": user_id, "transactionId": id})


class TestAdminEditsACustomersTransaction:
    class TestGivenTheCurrentVersion:
        def test_applies_the_change_and_the_customer_sees_it(self, handler: Handler) -> None:
            body = expense()
            create(handler, customer("edit-alice"), body)

            status, res = admin_patch(
                handler, "edit-alice", body["id"], {"version": 1, "amountCents": 4200, "note": "fixed by sisi"}
            )

            assert status == 200
            assert (res["amountCents"], res["note"], res["version"]) == (4200, "fixed by sisi", 2)
            seen = get_own(handler, customer("edit-alice"), body["id"])[1]
            assert (seen["amountCents"], seen["version"]) == (4200, 2)

    class TestGivenAStaleVersion:
        def test_refuses_with_409_version_conflict(self, handler: Handler) -> None:
            body = expense()
            create(handler, customer("edit-bob"), body)
            admin_patch(handler, "edit-bob", body["id"], {"version": 1, "amountCents": 1})

            status, res = admin_patch(handler, "edit-bob", body["id"], {"version": 1, "amountCents": 2})

            assert (status, res["error"]["code"]) == (409, "version_conflict")

    class TestGivenTheWrongOwnerForTheTransaction:
        def test_returns_404(self, handler: Handler) -> None:
            body = expense()
            create(handler, customer("edit-carol"), body)

            status, res = admin_patch(handler, "edit-dave", body["id"], {"version": 1, "amountCents": 1})

            assert (status, res["error"]["code"]) == (404, "transaction_not_found")

    class TestGivenACustomer:
        def test_refuses_with_403_even_for_their_own_transaction(self, handler: Handler) -> None:
            body = expense()
            create(handler, customer("edit-erin"), body)

            status, _ = admin_patch(
                handler, "edit-erin", body["id"], {"version": 1, "amountCents": 1}, customer("edit-erin")
            )

            assert status == 403
