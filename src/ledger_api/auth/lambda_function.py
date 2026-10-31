import os
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import boto3

from ledger_api.auth.handler import create_auth_handler
from ledger_api.auth.signing_secret import load_signing_secret
from ledger_api.auth.users_store import UsersStore
from ledger_api.db import dynamodb
from ledger_api.http import Response

if TYPE_CHECKING:
    # Dev-only stubs; the Lambda runtime has boto3 but not these.
    from mypy_boto3_ssm import SSMClient

# Only some services' stubs are installed, so boto3.client's overloads for the rest are unknown to pyright.
_ssm: "SSMClient" = boto3.client("ssm")  # pyright: ignore[reportUnknownMemberType]

_handler = create_auth_handler(
    users=UsersStore(dynamodb().Table(os.environ["USERS_TABLE"])),
    signing_secret=load_signing_secret(_ssm),
    now=lambda: datetime.now(UTC),
)


def handler(event: dict[str, Any], context: Any) -> Response:
    return _handler(event)
