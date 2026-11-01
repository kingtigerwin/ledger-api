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

# The Flybuys receipt: $30.50 of goods, of which $0.50 was money.
RECEIPT: dict[str, Any] = {
    "totalCents": 3050,
    "gstCents": 0,
    "savingsCents": 3100,
    "time": "15:06",
    "location": "The Glen",
    "receiptNumber": "6547",
    "abn": "45004189708",
    "lines": [
        {"name": "PI PERFECT BAKES 450", "product": "pasta bake", "amountCents": 850},
        {"name": "COLES BEEF MINCE 4ST", "product": "beef mince", "amountCents": 1550},
        {"name": "CLS CHICKEN MINCE", "product": "chicken mince", "amountCents": 650},
    ],
    "payments": [
        {"label": "Flybuys value redeemed", "kind": "points", "amountCents": 3000},
        {"label": "EFT", "kind": "money", "amountCents": 50},
    ],
}


@pytest.fixture
def handler(data_table: "Table") -> Handler:
    ledger = Ledger(TransactionsStore(data_table), cursor_secret="test-cursor-secret", now=lambda: datetime.now(UTC))
    return create_data_handler(ledger=ledger)


def scanned(**receipt: Any) -> dict[str, Any]:
    return expense(amountCents=50, receipt={**RECEIPT, **receipt})


def create(handler: Handler, user: str, body: Any) -> tuple[int, Any]:
    return call(handler, "POST /api/v1/transactions", body, auth=customer(user))


class TestGivenAScannedReceipt:
    def test_keeps_every_detail_and_reads_it_back_exactly(self, handler: Handler) -> None:
        body = scanned()

        status, created = create(handler, "rcpt-a", body)
        _, fetched = call(handler, "GET /api/v1/transactions/{id}", auth=customer("rcpt-a"), params={"id": body["id"]})

        assert status == 201
        assert created["receipt"] == RECEIPT
        assert fetched == created

    def test_lists_it_with_its_details(self, handler: Handler) -> None:
        create(handler, "rcpt-b", scanned())

        _, page = call(handler, "GET /api/v1/transactions", auth=customer("rcpt-b"))

        assert page["items"][0]["receipt"] == RECEIPT

    def test_a_receipt_needs_only_what_was_printed(self, handler: Handler) -> None:
        body = expense(receipt={"totalCents": 1774, "time": "14:19"})

        status, created = create(handler, "rcpt-c", body)

        assert (status, created["receipt"]) == (201, {"totalCents": 1774, "time": "14:19"})

    def test_a_discount_line_can_be_negative(self, handler: Handler) -> None:
        lines = [{"name": "MEMBER DISCOUNT", "amountCents": -200}]

        status, created = create(handler, "rcpt-d", scanned(lines=lines))

        assert (status, created["receipt"]["lines"]) == (201, lines)

    def test_keeps_the_details_through_an_edit_that_moves_the_date(self, handler: Handler) -> None:
        body = scanned()
        create(handler, "rcpt-e", body)

        status, edited = call(
            handler,
            "PATCH /api/v1/transactions/{id}",
            {"version": 1, "date": "2026-10-20"},
            auth=customer("rcpt-e"),
            params={"id": body["id"]},
        )

        assert (status, edited["receipt"]) == (200, RECEIPT)

    def test_the_summary_counts_what_was_paid_not_the_goods(self, handler: Handler) -> None:
        create(handler, "rcpt-f", scanned())

        _, summary = call(
            handler, "GET /api/v1/transactions/summary", auth=customer("rcpt-f"), query={"month": "2026-10"}
        )

        assert summary["totalCents"] == 50


class TestGivenAnExpenseWithNoReceipt:
    def test_has_no_receipt_field(self, handler: Handler) -> None:
        _, created = create(handler, "rcpt-g", expense())

        assert "receipt" not in created


class TestGivenBadReceiptDetails:
    @pytest.mark.parametrize(
        "receipt",
        [
            pytest.param({"abn": "4500"}, id="short-abn"),
            pytest.param({"time": "25:00"}, id="impossible-time"),
            pytest.param({"totalCents": 0}, id="zero-total"),
            pytest.param({"gstCents": -1}, id="negative-gst"),
            pytest.param({"lines": [{"amountCents": 100}]}, id="line-without-a-name"),
            pytest.param({"payments": [{"label": "EFT", "kind": "cheque", "amountCents": 100}]}, id="unknown-kind"),
            pytest.param({"lines": [{"name": "x", "amountCents": 1}] * 201}, id="too-many-lines"),
        ],
    )
    def test_refuses_them(self, handler: Handler, receipt: dict[str, Any]) -> None:
        status, body = create(handler, "rcpt-h", expense(receipt=receipt))

        assert (status, body["error"]["code"]) == (400, "validation_failed")
