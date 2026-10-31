import os
from datetime import UTC, datetime
from functools import cache
from typing import TYPE_CHECKING, Any

import boto3

from ledger_api.auth.google import GoogleSignIn, exchange_code, load_client_secret
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


@cache
def _google_client_secret() -> str:
    return load_client_secret(_ssm)


def _google() -> GoogleSignIn | None:
    """Google sign-in, if the stack configured it."""
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    redirect_uri = os.environ.get("GOOGLE_REDIRECT_URI")
    if not client_id or not redirect_uri:
        return None

    def exchange(code: str, code_verifier: str) -> str:
        return exchange_code(
            code=code,
            code_verifier=code_verifier,
            client_id=client_id,
            client_secret=_google_client_secret(),
            redirect_uri=redirect_uri,
        )

    return GoogleSignIn(client_id=client_id, redirect_uri=redirect_uri, exchange_code=exchange)


_handler = create_auth_handler(
    users=UsersStore(dynamodb().Table(os.environ["USERS_TABLE"])),
    signing_secret=load_signing_secret(_ssm),
    now=lambda: datetime.now(UTC),
    google=_google(),
)


def handler(event: dict[str, Any], context: Any) -> Response:
    return _handler(event)
