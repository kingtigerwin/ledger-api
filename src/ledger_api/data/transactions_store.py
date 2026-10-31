"""The Data table's transactions, keyed as src/data/data-table.ts defines (and the stack builds the table)."""

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, cast

from boto3.dynamodb.conditions import Attr, Key

from ledger_api.data.schemas import NewTransaction, Transaction, TransactionEdit
from ledger_api.timestamps import iso_timestamp

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table


class TransactionNotFoundError(Exception):
    pass


class VersionConflictError(Exception):
    """Someone else changed the transaction since the client read it."""


class TransactionExistsError(Exception):
    """The ID was already used: the request is a retry (or a client bug), not a new transaction."""


# Sort keys are `<date>#<id>`, so a date range is a key range: from the start of `from` to the end
# of `to` (the high character sorts after any ID).
EARLIEST = "0000-01-01"
LATEST = "9999-12-31"


def _range_end(date: str) -> str:
    return f"{date}#\uffff"


type Page[T] = tuple[list[T], dict[str, Any] | None]


@dataclass(frozen=True)
class ListRange:
    """Which transactions a list asks for, and how many per page."""

    date_from: str | None
    date_to: str | None
    category: str | None
    limit: int


class OwnedTransaction(Transaction):
    """A transaction in the admin's all-customers list, with whose it is."""

    userId: str


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

    def update(self, user_id: str, id: str, edit: TransactionEdit, now: datetime) -> Transaction:
        """
        Applies an edit if its `version` is still current. A new date changes the sort key, so the item
        is moved: old item deleted, new one written and the pointer updated, atomically.
        """
        current = self.get(user_id, id)
        if not current:
            raise TransactionNotFoundError(id)
        if current["version"] != edit["version"]:
            raise VersionConflictError(id)
        changes = {k: v for k, v in edit.items() if k != "version"}
        next = cast(
            Transaction, {**current, **changes, "version": current["version"] + 1, "updatedAt": iso_timestamp(now)}
        )
        try:
            if next["date"] == current["date"]:
                self._table.put_item(
                    Item=_to_item(user_id, next), ConditionExpression=Attr("version").eq(edit["version"])
                )
            else:
                self._move(user_id, current, next)
        except (
            self._client.exceptions.ConditionalCheckFailedException,
            self._client.exceptions.TransactionCanceledException,
        ):
            # Changed between our read and this write.
            raise VersionConflictError(id) from None
        return next

    def _move(self, user_id: str, current: Transaction, next: Transaction) -> None:
        name = self._table.name
        self._client.transact_write_items(
            TransactItems=[
                {
                    "Delete": {
                        "TableName": name,
                        "Key": _main_key(user_id, current["date"], current["id"]),
                        "ConditionExpression": "version = :expected",
                        "ExpressionAttributeValues": {":expected": current["version"]},
                    }
                },
                {"Put": {"TableName": name, "Item": _to_item(user_id, next)}},
                {
                    "Update": {
                        "TableName": name,
                        "Key": _ref_key(user_id, current["id"]),
                        "UpdateExpression": "SET #date = :date",
                        "ExpressionAttributeNames": {"#date": "date"},
                        "ExpressionAttributeValues": {":date": next["date"]},
                    }
                },
            ]
        )

    def delete(self, user_id: str, id: str) -> None:
        current = self.get(user_id, id)
        if not current:
            raise TransactionNotFoundError(id)
        name = self._table.name
        self._client.transact_write_items(
            TransactItems=[
                {"Delete": {"TableName": name, "Key": _main_key(user_id, current["date"], id)}},
                {"Delete": {"TableName": name, "Key": _ref_key(user_id, id)}},
            ]
        )

    def list(self, user_id: str, span: ListRange, start_key: dict[str, Any] | None) -> Page[Transaction]:
        """Newest first: the by-category index if a category is given, otherwise the main key. Dates are a key range."""
        lower, upper = span.date_from or EARLIEST, _range_end(span.date_to or LATEST)
        query: dict[str, Any] = {"ScanIndexForward": False, "Limit": span.limit}
        if span.category:
            query["IndexName"] = "byCategory"
            query["KeyConditionExpression"] = Key("gsi2pk").eq(f"{_user_pk(user_id)}#CATEGORY#{span.category}") & Key(
                "gsi2sk"
            ).between(lower, upper)
        else:
            query["KeyConditionExpression"] = Key("pk").eq(_user_pk(user_id)) & Key("sk").between(
                f"TXN#{lower}", f"TXN#{upper}"
            )
        if start_key:
            query["ExclusiveStartKey"] = start_key
        res = self._table.query(**query)
        return [_from_item(item) for item in res.get("Items", [])], res.get("LastEvaluatedKey")

    def list_all(self, span: ListRange, start_key: dict[str, Any] | None) -> Page[OwnedTransaction]:
        """Every customer's transactions, newest first, each with its owner's userId (for the admin)."""
        query: dict[str, Any] = {
            "IndexName": "allByDate",
            "KeyConditionExpression": Key("gsi3pk").eq("TXN")
            & Key("gsi3sk").between(span.date_from or EARLIEST, _range_end(span.date_to or LATEST)),
            "ScanIndexForward": False,
            "Limit": span.limit,
        }
        if span.category:
            query["FilterExpression"] = Attr("category").eq(span.category)
        if start_key:
            query["ExclusiveStartKey"] = start_key
        res = self._table.query(**query)
        owner = len(_user_pk(""))
        items = [OwnedTransaction(**_from_item(item), userId=str(item["pk"])[owner:]) for item in res.get("Items", [])]
        return items, res.get("LastEvaluatedKey")
