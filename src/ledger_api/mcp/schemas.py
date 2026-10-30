"""The tools' own inputs, beyond the REST request schemas in ledger_api.data.schemas."""

from typing import Annotated, Required, TypedDict

from pydantic import Field, StrictStr, TypeAdapter

from ledger_api.data.schemas import TransactionEdit


class ById(TypedDict):
    id: Annotated[StrictStr, Field(description="The transaction's id")]


class TransactionChange(TransactionEdit, total=False):
    """REST takes the id from the path; a tool takes it with the edit."""

    id: Required[Annotated[StrictStr, Field(description="The transaction's id")]]


BY_ID = TypeAdapter(ById)
TRANSACTION_CHANGE = TypeAdapter(TransactionChange)
