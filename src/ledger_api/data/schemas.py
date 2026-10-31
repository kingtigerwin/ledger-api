"""The transaction request schemas; the OpenAPI spec (ledger_api.docs) is built from them too."""

import re
from datetime import date
from typing import Annotated, Literal, NotRequired, Required, TypedDict

from pydantic import AfterValidator, Field, StrictInt, StrictStr, StringConstraints, TypeAdapter, WithJsonSchema

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


MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"


def _month(value: str) -> str:
    if not re.fullmatch(MONTH_PATTERN, value):
        raise ValueError("Must be YYYY-MM")
    return value


def _ulid(value: str) -> str:
    if not is_ulid(value):
        raise ValueError("Must be a ULID")
    return value


type IsoDate = Annotated[StrictStr, AfterValidator(_iso_date), WithJsonSchema({"type": "string", "format": "date"})]
type Merchant = Annotated[StrictStr, StringConstraints(strip_whitespace=True, max_length=100)]
type Item = Annotated[StrictStr, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
type AmountCents = Annotated[StrictInt, Field(gt=0, le=MAX_SAFE_INTEGER)]
type Note = Annotated[StrictStr, StringConstraints(strip_whitespace=True, max_length=1000)]


class TransactionFields(TypedDict):
    """The fields a customer edits. Unknown keys are dropped."""

    date: IsoDate
    merchant: NotRequired[Merchant]
    category: Category
    item: Item
    amountCents: AmountCents
    note: NotRequired[Note]


class NewTransaction(TransactionFields):
    """What a client sends to record one; `id` and `currency` are fixed once created."""

    id: Annotated[StrictStr, AfterValidator(_ulid)]
    currency: Literal["AUD"]


class TransactionEdit(TypedDict, total=False):
    """A partial edit of the fields a customer edits, plus the version the client last read."""

    version: Required[Annotated[StrictInt, Field(gt=0)]]
    date: IsoDate
    merchant: Merchant
    category: Category
    item: Item
    amountCents: AmountCents
    note: Note


DEFAULT_LIMIT = 50

# TypedDict, not a model: "from" is a keyword in Python but a key here.
ListQuery = TypedDict(
    "ListQuery",
    {
        "from": NotRequired[IsoDate],
        "to": NotRequired[IsoDate],
        "category": NotRequired[Category],
        # Query strings are text, so the page size is read as a number, not only taken as one.
        "limit": NotRequired[Annotated[int, Field(ge=1, le=100, json_schema_extra={"default": DEFAULT_LIMIT})]],
        "cursor": NotRequired[StrictStr],
    },
)


class SummaryQuery(TypedDict):
    # Checked in _month, for its message; the pattern is for the OpenAPI spec and MCP clients.
    month: Annotated[StrictStr, AfterValidator(_month), Field(json_schema_extra={"pattern": MONTH_PATTERN})]


class Transaction(NewTransaction):
    version: int
    createdAt: str
    updatedAt: str


TRANSACTION_FIELDS = TypeAdapter(TransactionFields)
NEW_TRANSACTION = TypeAdapter(NewTransaction)
TRANSACTION_EDIT = TypeAdapter(TransactionEdit)
LIST_QUERY = TypeAdapter(ListQuery)
SUMMARY_QUERY = TypeAdapter(SummaryQuery)
