from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pytest

from ledger_api.data.handler import create_data_handler
from ledger_api.data.ledger import Ledger
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.http import Handler
from tests.integration.data import call, customer, expense

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

ROUTE = "GET /api/v1/transactions/purchases"
WRITE_ONLY = {"userId": "pur-writer", "role": "customer", "scope": "transactions:write"}
NOW = datetime(2026, 11, 1, 3, tzinfo=UTC)
BANANAS = {"name": "BANANAS PERKG", "product": "bananas", "amountCents": 284}


def data_handler(data_table: "Table", now: datetime) -> Handler:
    return create_data_handler(ledger=Ledger(TransactionsStore(data_table), cursor_secret="s", now=lambda: now))


@pytest.fixture
def handler(data_table: "Table") -> Handler:
    return data_handler(data_table, datetime.now(UTC))


@pytest.fixture
def stopped_clock(data_table: "Table") -> Handler:
    """For what depends on today. New IDs carry the real time, so nothing can be recorded through this one."""
    return data_handler(data_table, NOW)


def record(handler: Handler, user: str, **fields: Any) -> None:
    call(handler, "POST /api/v1/transactions", expense(**fields), auth=customer(user))


def shop(handler: Handler, user: str, date: str) -> None:
    receipt = {"totalCents": 1000, "lines": [BANANAS, {"name": "BREAD", "amountCents": 716}]}
    record(handler, user, date=date, item="2 items", receipt=receipt)


def search(handler: Handler, user: str, **query: str) -> tuple[int, Any]:
    """Over the whole of 2026 unless told otherwise, so the real date doesn't matter."""
    return call(handler, ROUTE, auth=customer(user), query={"from": "2026-01-01", "to": "2026-12-31", **query})


class TestSearch:
    class TestGivenReceiptsAndTypedExpenses:
        def test_finds_both_and_adds_them_up(self, handler: Handler) -> None:
            shop(handler, "pur-a", "2026-10-20")
            record(handler, "pur-a", date="2026-10-21", item="bananas", amountCents=300)

            status, body = search(handler, "pur-a", q="banana")

            assert status == 200
            assert (body["count"], body["totalCents"]) == (2, 584)
            assert [match["date"] for match in body["matches"]] == ["2026-10-21", "2026-10-20"]

    class TestGivenSeveralTerms:
        def test_takes_them_separated_by_commas(self, handler: Handler) -> None:
            record(handler, "pur-b", date="2026-10-20", item="新鲜香蕉", amountCents=300)

            _, body = search(handler, "pur-b", q="banana, 香蕉")

            assert body["count"] == 1

    class TestGivenAnotherCustomersPurchases:
        def test_finds_nothing(self, handler: Handler) -> None:
            shop(handler, "pur-c", "2026-10-20")

            assert search(handler, "pur-d", q="banana")[1]["count"] == 0

    class TestGivenADateRange:
        def test_searches_only_inside_it_and_says_what_it_covered(self, handler: Handler) -> None:
            shop(handler, "pur-e", "2026-09-30")
            shop(handler, "pur-e", "2026-10-01")
            shop(handler, "pur-e", "2026-10-31")
            shop(handler, "pur-e", "2026-11-01")

            _, body = search(handler, "pur-e", q="banana", **{"from": "2026-10-01", "to": "2026-10-31"})

            assert body["count"] == 2
            assert (body["from"], body["to"]) == ("2026-10-01", "2026-10-31")

    class TestGivenNoDates:
        def test_covers_the_400_days_up_to_today(self, stopped_clock: Handler) -> None:
            _, body = call(stopped_clock, ROUTE, auth=customer("pur-f"), query={"q": "banana"})

            assert (body["from"], body["to"]) == ("2025-09-27", "2026-11-01")

        def test_counts_back_from_a_given_end(self, stopped_clock: Handler) -> None:
            query = {"q": "banana", "to": "2026-01-31"}

            _, body = call(stopped_clock, ROUTE, auth=customer("pur-f"), query=query)

            assert body["from"] == "2024-12-27"

    class TestGivenMoreThanOnePageOfTransactions:
        def test_reads_them_all(self, handler: Handler) -> None:
            for cents in range(1, 104):
                record(handler, "pur-g", date="2026-10-20", item="bananas", amountCents=cents)

            assert search(handler, "pur-g", q="banana")[1]["count"] == 103

    @pytest.mark.parametrize(
        ("query", "code"),
        [
            pytest.param({}, "validation_failed", id="no-terms"),
            pytest.param({"q": " , "}, "validation_failed", id="only-commas"),
            pytest.param({"q": ",".join("abcdefghijk")}, "validation_failed", id="too-many-terms"),
            pytest.param({"q": "a", "from": "soon"}, "validation_failed", id="bad-date"),
            pytest.param({"q": "a", "from": "2026-10-02", "to": "2026-10-01"}, "invalid_date_range", id="backwards"),
            pytest.param({"q": "a", "from": "2020-01-01", "to": "2026-10-01"}, "invalid_date_range", id="too-long"),
        ],
    )
    def test_refuses_a_bad_search(self, handler: Handler, query: dict[str, str], code: str) -> None:
        status, body = call(handler, ROUTE, auth=customer("pur-h"), query=query)

        assert (status, body["error"]["code"]) == (400, code)

    class TestGivenATokenWithoutTheReadScope:
        def test_refuses_it(self, handler: Handler) -> None:
            status, body = call(handler, ROUTE, auth=WRITE_ONLY, query={"q": "banana"})

            assert (status, body["error"]["code"]) == (403, "forbidden")
