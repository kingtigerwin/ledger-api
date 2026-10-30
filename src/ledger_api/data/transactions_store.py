"""The Data table's transactions, as src/data/transactions-store.ts reads and writes them (src/data/data-table.ts)."""

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from ledger_api.data.schemas import NewTransaction, Transaction

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table


class TransactionExistsError(Exception):
    """The ID was already used: the request is a retry (or a client bug), not a new transaction."""


def iso_timestamp(at: datetime) -> str:
    """As JavaScript's toISOString() writes it (milliseconds, Z), so old and new rows read and sort the same."""
    return at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"


def _user_pk(user_id: str) -> str:
    return f"USER#{user_id}"


def _sort_key(date: str, id: str) -> str:
    return f"{date}#{id}"


def _ref_key(user_id: str, id: str) -> dict[str, str]:
    """The transaction sorts by date; this pointer finds it by ID alone."""
    return {"pk": _user_pk(user_id), "sk": f"TXNREF#{id}"}


def _main_key(user_id: str, date: str, id: str) -> dict[str, str]:
    return {"pk": _user_pk(user_id), "sk": f"TXN#{_sort_key(date, id)}"}


def _to_item(user_id: str, t: Transaction) -> dict[str, Any]:
    """The stored item: the transaction plus its keys in the table and both indexes."""
    return {
        **_main_key(user_id, t["date"], t["id"]),
        "gsi2pk": f"{_user_pk(user_id)}#CATEGORY#{t['category']}",
        "gsi2sk": _sort_key(t["date"], t["id"]),
        "gsi3pk": "TXN",
        "gsi3sk": _sort_key(t["date"], t["id"]),
        **t,
    }


def _from_item(item: dict[str, Any]) -> Transaction:
    """Picks known fields only, so attributes from older versions (memberId, gsi1*) never leak out."""
    t: dict[str, Any] = {
        "id": item["id"],
        "date": item["date"],
        "category": item["category"],
        "item": item["item"],
        "amountCents": int(item["amountCents"]),
        "currency": item["currency"],
        "version": int(item["version"]),
        "createdAt": item["createdAt"],
        "updatedAt": item["updatedAt"],
    }
    for optional in ("merchant", "note"):
        if optional in item:
            t[optional] = item[optional]
    return Transaction(**t)


class TransactionsStore:
    def __init__(self, table: "Table") -> None:
        self._table = table
        self._client = table.meta.client

    def get(self, user_id: str, id: str) -> Transaction | None:
        ref = self._table.get_item(Key=_ref_key(user_id, id), ConsistentRead=True).get("Item")
        if not ref:
            return None
        item = self._table.get_item(Key=_main_key(user_id, str(ref["date"]), id), ConsistentRead=True).get("Item")
        return _from_item(item) if item else None

    def create(self, user_id: str, new: NewTransaction, now: datetime) -> Transaction:
        stamp = iso_timestamp(now)
        transaction = Transaction(**new, version=1, createdAt=stamp, updatedAt=stamp)
        try:
            self._client.transact_write_items(
                TransactItems=[
                    {
                        "Put": {
                            "TableName": self._table.name,
                            "Item": {**_ref_key(user_id, new["id"]), "date": new["date"]},
                            # Condition builders put their placeholders at the request's top level, which
                            # TransactWriteItems refuses, so expressions inside a transaction are strings.
                            "ConditionExpression": "attribute_not_exists(pk)",
                        }
                    },
                    {"Put": {"TableName": self._table.name, "Item": _to_item(user_id, transaction)}},
                ]
            )
        except self._client.exceptions.TransactionCanceledException:
            raise TransactionExistsError(new["id"]) from None
        return transaction

    def create_once(self, user_id: str, new: NewTransaction, now: datetime) -> tuple[Transaction, bool]:
        """Creates the transaction, or, if its id was already used, returns what was stored: retries are safe."""
        existing = self.get(user_id, new["id"])
        if existing:
            return existing, False
        try:
            return self.create(user_id, new, now), True
        except TransactionExistsError:
            # A retry that raced the first request: answer with what was stored.
            stored = self.get(user_id, new["id"])
            if not stored:
                raise
            return stored, False
