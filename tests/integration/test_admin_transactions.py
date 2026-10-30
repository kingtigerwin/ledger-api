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
