import os
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import boto3

from ledger_api.auth.users_store import UsersStore
from ledger_api.bootstrap.handler import create_bootstrap_handler
from ledger_api.bootstrap.parameters import SsmParameterStore
from ledger_api.db import dynamodb

if TYPE_CHECKING:
    # Dev-only stubs; the Lambda runtime has boto3 but not these.
    from mypy_boto3_ssm import SSMClient

# Only some services' stubs are installed, so boto3.client's overloads for the rest are unknown to pyright.
_ssm: "SSMClient" = boto3.client("ssm")  # pyright: ignore[reportUnknownMemberType]

_handler = create_bootstrap_handler(
    users=UsersStore(dynamodb().Table(os.environ["USERS_TABLE"])),
    parameters=SsmParameterStore(_ssm),
    now=lambda: datetime.now(UTC),
)


def handler(event: dict[str, Any], context: Any) -> dict[str, str]:
    return _handler(event)
