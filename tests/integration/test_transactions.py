import re
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


@pytest.fixture
def handler(data_table: "Table") -> Handler:
    ledger = Ledger(TransactionsStore(data_table), cursor_secret="test-cursor-secret", now=lambda: datetime.now(UTC))
    return create_data_handler(ledger=ledger)


def create(handler: Handler, house: str, body: Any) -> tuple[int, Any]:
    return call(handler, "POST /api/v1/transactions", body, auth=customer(house))


def get(handler: Handler, house: str, id: str) -> tuple[int, Any]:
    return call(handler, "GET /api/v1/transactions/{id}", auth=customer(house), params={"id": id})


class TestRecordAndReadBack:
    class TestGivenAValidExpense:
        def test_records_it_against_the_signed_in_customer_and_it_reads_back_the_same(self, handler: Handler) -> None:
            body = expense()

            created = create(handler, "tx-house-a", body)
            fetched = get(handler, "tx-house-a", body["id"])

            assert created[0] == 201
            assert created[1] == {
                **body,
                "version": 1,
                "createdAt": created[1]["createdAt"],
                "updatedAt": created[1]["createdAt"],
            }
            # As JavaScript's toISOString() writes it, so rows from before the port sort and read the same.
            assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", created[1]["createdAt"])
            assert fetched == (200, created[1])
