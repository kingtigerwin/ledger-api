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

TODAY = "2026-10-27"
READ_ONLY = {"userId": "ins-reader", "role": "customer", "scope": "transactions:read"}
WRITE_ONLY = {"userId": "ins-writer", "role": "customer", "scope": "transactions:write"}


@pytest.fixture
def handler(data_table: "Table") -> Handler:
    ledger = Ledger(TransactionsStore(data_table), cursor_secret="test-cursor-secret", now=lambda: datetime.now(UTC))
    return create_data_handler(ledger=ledger)


def record_twice(handler: Handler, user: str) -> None:
    for _ in range(2):
        call(handler, "POST /api/v1/transactions", expense(), auth=customer(user))


def insights(handler: Handler, user: str) -> tuple[int, Any]:
    return call(handler, "GET /api/v1/insights", auth=customer(user), query={"today": TODAY})


def dismiss(handler: Handler, user: str, id: str) -> tuple[int, Any]:
    return call(handler, "POST /api/v1/insights/{id}/dismiss", auth=customer(user), params={"id": id})


class TestInsights:
    class TestGivenTheSameExpenseRecordedTwice:
        def test_returns_a_card_holding_both_transactions(self, handler: Handler) -> None:
            record_twice(handler, "ins-a")

            status, body = insights(handler, "ins-a")

            assert status == 200
            [card] = body["items"]
            assert card["type"] == "possible_duplicate"
            assert card["transactions"][0]["item"] == "菜"

    class TestGivenAnotherCustomersDuplicates:
        def test_returns_nothing(self, handler: Handler) -> None:
            record_twice(handler, "ins-b")

            assert insights(handler, "ins-c") == (200, {"items": []})

    class TestGivenMoreThanOnePageOfTransactions:
        def test_reads_every_page(self, handler: Handler) -> None:
            for cents in range(1, 102):
                body = expense(amountCents=cents, date="2026-10-20")
                call(handler, "POST /api/v1/transactions", body, auth=customer("ins-many"))
            record_twice(handler, "ins-many")
            # Sorted by date then id, the oldest entries are on the last page; this pair is dated earlier.
            for _ in range(2):
                call(handler, "POST /api/v1/transactions", expense(date="2026-10-01"), auth=customer("ins-many"))

            _, body = insights(handler, "ins-many")

            assert len(body["items"]) == 2

    class TestGivenTransactionsDatedAfterToday:
        def test_ignores_them(self, handler: Handler) -> None:
            for _ in range(2):
                call(handler, "POST /api/v1/transactions", expense(date="2026-10-28"), auth=customer("ins-future"))

            assert insights(handler, "ins-future") == (200, {"items": []})

    @pytest.mark.parametrize(
        "query",
        [
            pytest.param(None, id="missing"),
            pytest.param({"today": "27-10-2026"}, id="wrong-format"),
            pytest.param({"today": "2026-02-30"}, id="not-a-real-date"),
        ],
    )
    def test_rejects_a_bad_today(self, handler: Handler, query: dict[str, str] | None) -> None:
        status, body = call(handler, "GET /api/v1/insights", auth=customer("ins-d"), query=query)

        assert (status, body["error"]["code"]) == (400, "validation_failed")

    class TestGivenATokenWithoutTheReadScope:
        def test_refuses_it(self, handler: Handler) -> None:
            status, body = call(handler, "GET /api/v1/insights", auth=WRITE_ONLY, query={"today": TODAY})

            assert (status, body["error"]["code"]) == (403, "forbidden")


class TestDismiss:
    class TestGivenACard:
        def test_it_stops_coming_back(self, handler: Handler) -> None:
            record_twice(handler, "ins-e")
            _, body = insights(handler, "ins-e")

            assert dismiss(handler, "ins-e", str(body["items"][0]["id"])) == (204, None)
            assert insights(handler, "ins-e") == (200, {"items": []})

        def test_dismissing_it_again_is_safe(self, handler: Handler) -> None:
            record_twice(handler, "ins-f")
            _, body = insights(handler, "ins-f")
            id = str(body["items"][0]["id"])

            assert dismiss(handler, "ins-f", id) == (204, None)
            assert dismiss(handler, "ins-f", id) == (204, None)

        def test_another_customers_dismissal_changes_nothing(self, handler: Handler) -> None:
            record_twice(handler, "ins-g")
            _, body = insights(handler, "ins-g")

            dismiss(handler, "ins-h", str(body["items"][0]["id"]))

            assert len(insights(handler, "ins-g")[1]["items"]) == 1

    class TestGivenAnIdThatIsNotAnInsightId:
        def test_refuses_it(self, handler: Handler) -> None:
            status, body = dismiss(handler, "ins-i", "NOT-AN-ID")

            assert (status, body["error"]["code"]) == (400, "invalid_insight_id")

    class TestGivenATokenWithoutTheWriteScope:
        def test_refuses_it(self, handler: Handler) -> None:
            status, body = call(
                handler, "POST /api/v1/insights/{id}/dismiss", auth=READ_ONLY, params={"id": "0123456789abcdef"}
            )

            assert (status, body["error"]["code"]) == (403, "forbidden")


class TestStorage:
    class TestGivenADismissal:
        def test_it_never_appears_as_a_transaction(self, handler: Handler) -> None:
            call(handler, "POST /api/v1/transactions", expense(), auth=customer("ins-j"))
            dismiss(handler, "ins-j", "0123456789abcdef")

            _, body = call(handler, "GET /api/v1/transactions", auth=customer("ins-j"))

            assert len(body["items"]) == 1

        def test_deleting_the_customer_removes_it(self, handler: Handler, data_table: "Table") -> None:
            dismiss(handler, "ins-k", "0123456789abcdef")
            store = TransactionsStore(data_table)

            assert store.dismissed_insights("ins-k") == {"0123456789abcdef"}
            assert store.delete_all("ins-k") == 1
            assert store.dismissed_insights("ins-k") == set()
