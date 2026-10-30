import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import pytest

from ledger_api.data.handler import create_data_handler
from ledger_api.data.ledger import Ledger
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.data.ulid import new_ulid
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

    class TestGivenAnotherCustomersTransactionId:
        def test_returns_404(self, handler: Handler) -> None:
            body = expense()
            create(handler, "tx-house-b", body)

            status, res = get(handler, "tx-house-c", body["id"])

            assert (status, res["error"]["code"]) == (404, "transaction_not_found")

    class TestGivenTheSameIdSentTwiceAsARetryWould:
        def test_returns_the_original_record_with_200_and_keeps_a_single_transaction(self, handler: Handler) -> None:
            body = expense()
            _, first = create(handler, "tx-house-d", body)

            retry = create(handler, "tx-house-d", {**body, "amountCents": 99999})

            assert retry == (200, first)
            assert get(handler, "tx-house-d", body["id"])[1]["amountCents"] == 10000

    class TestGivenInvalidInput:
        @pytest.mark.parametrize(
            "overrides",
            [
                pytest.param({"id": "not-a-ulid"}, id="an id that isn't a ULID"),
                pytest.param({"currency": "USD"}, id="a currency other than AUD"),
                pytest.param({"amountCents": 0}, id="a zero amount"),
                pytest.param({"amountCents": 10.5}, id="a fractional amount"),
                pytest.param({"amountCents": "100"}, id="an amount as a string"),
                pytest.param({"category": "gambling"}, id="an unknown category"),
                pytest.param({"date": "2026-02-30"}, id="an impossible date"),
                pytest.param({"date": "20261026"}, id="a date without dashes"),
                pytest.param({"item": "   "}, id="a blank item"),
                pytest.param({"merchant": None}, id="a null merchant"),
            ],
        )
        def test_rejects_it_with_400_validation_failed(self, handler: Handler, overrides: dict[str, Any]) -> None:
            status, res = create(handler, "tx-house-e", expense(**overrides))

            assert (status, res["error"]["code"]) == (400, "validation_failed")

        def test_rejects_an_id_dated_more_than_5_minutes_in_the_future(self, handler: Handler) -> None:
            tomorrow = datetime.now(UTC) + timedelta(days=1)

            status, res = create(handler, "tx-house-e", expense(id=new_ulid(tomorrow)))

            assert (status, res["error"]["code"]) == (400, "invalid_id")

        def test_ignores_a_member_id_which_transactions_no_longer_have(self, handler: Handler) -> None:
            status, res = create(handler, "tx-house-e", {**expense(), "memberId": "mom"})

            assert status == 201
            assert "memberId" not in res


def patch(handler: Handler, house: str, id: str, body: Any) -> tuple[int, Any]:
    return call(handler, "PATCH /api/v1/transactions/{id}", body, auth=customer(house), params={"id": id})


class TestEditATransaction:
    class TestGivenTheCurrentVersion:
        def test_applies_the_change_and_bumps_the_version(self, handler: Handler) -> None:
            body = expense()
            create(handler, "tx-house-f", body)

            status, res = patch(
                handler, "tx-house-f", body["id"], {"version": 1, "amountCents": 12000, "note": "plus fruit"}
            )

            assert status == 200
            assert res | {"amountCents": 12000, "note": "plus fruit", "item": "菜", "version": 2} == res
            assert get(handler, "tx-house-f", body["id"]) == (200, res)

    class TestGivenAVersionSomeoneElseAlreadyChanged:
        def test_refuses_with_409_version_conflict_and_keeps_their_change(self, handler: Handler) -> None:
            body = expense()
            create(handler, "tx-house-g", body)
            patch(handler, "tx-house-g", body["id"], {"version": 1, "amountCents": 5000})

            status, res = patch(handler, "tx-house-g", body["id"], {"version": 1, "amountCents": 7000})

            assert (status, res["error"]["code"]) == (409, "version_conflict")
            assert get(handler, "tx-house-g", body["id"])[1]["amountCents"] == 5000
