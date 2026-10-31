"""The tools' own inputs, beyond the REST request schemas in ledger_api.data.schemas."""

from typing import Annotated, NotRequired, Required, TypedDict

from pydantic import Field, StrictStr, StringConstraints, TypeAdapter

from ledger_api.data.schemas import ListQuery, TransactionEdit


class ById(TypedDict):
    id: Annotated[StrictStr, Field(description="The transaction's id")]


class TransactionChange(TransactionEdit, total=False):
    """REST takes the id from the path; a tool takes it with the edit."""

    id: Required[Annotated[StrictStr, Field(description="The transaction's id")]]


class ListAllQuery(ListQuery):
    # As usernames are registered (ledger_api.auth.schemas): stored lower-case, so matched in any case.
    username: NotRequired[
        Annotated[
            StrictStr,
            StringConstraints(min_length=1, max_length=64, to_lower=True),
            Field(description="Only this customer's transactions"),
        ]
    ]


BY_ID = TypeAdapter(ById)
TRANSACTION_CHANGE = TypeAdapter(TransactionChange)
LIST_ALL_QUERY = TypeAdapter(ListAllQuery)
