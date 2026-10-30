from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pytest

from ledger_api.data.handler import create_data_handler
from ledger_api.data.ledger import Ledger
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.data.ulid import new_ulid
from ledger_api.http import Handler
from tests.integration.data import call, customer

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

HOUSE = "list-house"

# amountCents doubles as a label: 1000 is the oldest, 6000 the newest.
ROWS = [
    ("2026-09-15", "groceries", 1000),
    ("2026-10-01", "transport", 2000),
    ("2026-10-05", "dining", 3000),
    ("2026-10-20", "groceries", 4000),
    ("2026-10-31", "groceries", 5000),
    ("2026-11-02", "groceries", 6000),
]


@pytest.fixture
def handler(data_table: "Table") -> Handler:
    ledger = Ledger(TransactionsStore(data_table), cursor_secret="test-cursor-secret", now=lambda: datetime.now(UTC))
    handler = create_data_handler(ledger=ledger)

    def record(house: str, date: str, category: str, amount: int) -> None:
        body = {
            "id": new_ulid(),
            "date": date,
            "category": category,
            "item": "x",
            "amountCents": amount,
            "currency": "AUD",
        }
        assert call(handler, "POST /api/v1/transactions", body, auth=customer(house))[0] == 201

    for date, category, amount in ROWS:
        record(HOUSE, date, category, amount)
    # Another customer's spending must never show up.
    record("other", "2026-10-10", "groceries", 9999)
    return handler


def list_transactions(handler: Handler, query: dict[str, str]) -> tuple[int, Any]:
    return call(handler, "GET /api/v1/transactions", auth=customer(HOUSE), query=query)


def all_pages(handler: Handler, query: dict[str, str]) -> list[list[int]]:
    """Follows nextCursor to the end; each page's amounts."""
    pages: list[list[int]] = []
    cursor = None
    while True:
        status, body = list_transactions(handler, query | ({"cursor": cursor} if cursor else {}))
        assert status == 200
        pages.append([t["amountCents"] for t in body["items"]])
        cursor = body["nextCursor"]
        if not cursor:
            return pages


class TestListTransactions:
    class TestGivenAPageSize:
        def test_pages_through_everything_newest_first(self, handler: Handler) -> None:
            pages = all_pages(handler, {"limit": "2"})

            assert all(len(page) <= 2 for page in pages)
            assert [amount for page in pages for amount in page] == [6000, 5000, 4000, 3000, 2000, 1000]

    @pytest.mark.parametrize(
        ("query", "expected"),
        [
            pytest.param({"from": "2026-10-01", "to": "2026-10-31"}, [5000, 4000, 3000, 2000], id="a date range"),
            pytest.param({"category": "groceries"}, [6000, 5000, 4000, 1000], id="a category"),
            pytest.param(
                {"category": "groceries", "from": "2026-10-01", "to": "2026-10-31"},
                [5000, 4000],
                id="category and dates together",
            ),
        ],
    )
    def test_filters_by(self, handler: Handler, query: dict[str, str], expected: list[int]) -> None:
        pages = all_pages(handler, query | {"limit": "2"})

        assert [amount for page in pages for amount in page] == expected

    class TestGivenALimitOver100:
        def test_rejects_it(self, handler: Handler) -> None:
            assert list_transactions(handler, {"limit": "101"})[0] == 400

    class TestGivenACursorThatWasTamperedWith:
        def test_rejects_it_with_400_invalid_cursor(self, handler: Handler) -> None:
            _, first = list_transactions(handler, {"limit": "2"})
            payload, signature = first["nextCursor"].split(".")

            status, res = list_transactions(handler, {"cursor": f"{payload}x.{signature}"})

            assert (status, res["error"]["code"]) == (400, "invalid_cursor")

    class TestGivenAGenuineCursorFromADifferentFilter:
        def test_rejects_it_with_400_invalid_cursor_rather_than_failing(self, handler: Handler) -> None:
            _, first = list_transactions(handler, {"limit": "2"})

            status, res = list_transactions(handler, {"category": "groceries", "cursor": first["nextCursor"]})

            assert (status, res["error"]["code"]) == (400, "invalid_cursor")
