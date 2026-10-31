"""The admin's query schema, for the OpenAPI spec; the handler checks it itself, giving zod's issue shape."""

from typing import TypedDict

from pydantic import TypeAdapter

from ledger_api.auth.users_store import UserStatus


class StatusQuery(TypedDict):
    status: UserStatus


STATUS_QUERY = TypeAdapter(StatusQuery)
