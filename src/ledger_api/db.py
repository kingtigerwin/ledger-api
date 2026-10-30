import os
from typing import TYPE_CHECKING

import boto3

if TYPE_CHECKING:
    # Dev-only stubs; the Lambda runtime has boto3 but not these.
    from mypy_boto3_dynamodb import DynamoDBServiceResource


def dynamodb() -> "DynamoDBServiceResource":
    """DynamoDB's resource interface; DYNAMODB_ENDPOINT is only set for local runs and tests (DynamoDB Local)."""
    endpoint = os.environ.get("DYNAMODB_ENDPOINT")
    # Only some services' stubs are installed, so boto3.resource's overloads for the rest are unknown to pyright.
    return boto3.resource("dynamodb", endpoint_url=endpoint) if endpoint else boto3.resource("dynamodb")  # pyright: ignore[reportUnknownMemberType]
