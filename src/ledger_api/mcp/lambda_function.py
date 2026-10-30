import os
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import boto3

from ledger_api.auth.signing_secret import load_signing_secret
from ledger_api.auth.users_store import UsersStore
from ledger_api.data.cursor import cursor_secret_from
from ledger_api.data.ledger import Ledger
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.db import dynamodb
from ledger_api.http import Response
from ledger_api.mcp.handler import create_mcp_handler

if TYPE_CHECKING:
    # Dev-only stubs; the Lambda runtime has boto3 but not these.
    from mypy_boto3_ssm import SSMClient

# Only some services' stubs are installed, so boto3.client's overloads for the rest are unknown to pyright.
_ssm: "SSMClient" = boto3.client("ssm")  # pyright: ignore[reportUnknownMemberType]
_db = dynamodb()

_handler = create_mcp_handler(
    ledger=Ledger(
        TransactionsStore(_db.Table(os.environ["DATA_TABLE"])),
        cursor_secret=cursor_secret_from(load_signing_secret(_ssm)),
        now=lambda: datetime.now(UTC),
    ),
    # Read-only: the usernames on the admin's cross-customer list.
    users=UsersStore(_db.Table(os.environ["USERS_TABLE"])),
    now=lambda: datetime.now(UTC),
)


def handler(event: dict[str, Any], context: Any) -> Response:
    return _handler(event)
