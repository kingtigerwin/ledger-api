"""The transaction request schemas, matching src/data/transaction-schema.ts (which the OpenAPI spec is built from)."""

import re
from datetime import date
from typing import Annotated, Literal, NotRequired, Required, TypedDict

from pydantic import AfterValidator, Field, StrictInt, StrictStr, StringConstraints, TypeAdapter

from ledger_api.data.ulid import is_ulid

type Category = Literal[
    "groceries", "dining", "transport", "utilities", "rent", "health", "education", "shopping", "entertainment", "other"
]

# JavaScript's Number.MAX_SAFE_INTEGER: the largest amount the TypeScript side reads exactly.
MAX_SAFE_INTEGER = 2**53 - 1


def _iso_date(value: str) -> str:
    # fromisoformat alone also takes forms like "20261026"; the API's dates are YYYY-MM-DD only.
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Must be a date as YYYY-MM-DD")
    date.fromisoformat(value)
    return value


def _ulid(value: str) -> str:
    if not is_ulid(value):
        raise ValueError("Must be a ULID")
    return value


type IsoDate = Annotated[StrictStr, AfterValidator(_iso_date)]
type Merchant = Annotated[StrictStr, StringConstraints(strip_whitespace=True, max_length=100)]
type Item = Annotated[StrictStr, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
type AmountCents = Annotated[StrictInt, Field(gt=0, le=MAX_SAFE_INTEGER)]
type Note = Annotated[StrictStr, StringConstraints(strip_whitespace=True, max_length=1000)]


class NewTransaction(TypedDict):
    """What a client sends to record one; `id` and `currency` are fixed once created. Unknown keys are dropped."""

    id: Annotated[StrictStr, AfterValidator(_ulid)]
    date: IsoDate
    merchant: NotRequired[Merchant]
    category: Category
    item: Item
    amountCents: AmountCents
    currency: Literal["AUD"]
    note: NotRequired[Note]


class TransactionEdit(TypedDict, total=False):
    """A partial edit of the fields a customer edits, plus the version the client last read."""

    version: Required[Annotated[StrictInt, Field(gt=0)]]
    date: IsoDate
    merchant: Merchant
    category: Category
    item: Item
    amountCents: AmountCents
    note: Note


class Transaction(NewTransaction):
    version: int
    createdAt: str
    updatedAt: str


NEW_TRANSACTION = TypeAdapter(NewTransaction)
TRANSACTION_EDIT = TypeAdapter(TransactionEdit)
