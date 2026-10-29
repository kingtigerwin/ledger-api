import os
import uuid
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from mypy_boto3_dynamodb import DynamoDBClient
from mypy_boto3_dynamodbstreams import DynamoDBStreamsClient

# Runs against DynamoDB Local (`npm run db:up`).
_LOCAL: dict[str, Any] = {
    "endpoint_url": os.environ.get("DYNAMODB_ENDPOINT", "http://localhost:8000"),
    "region_name": "ap-southeast-2",
    "aws_access_key_id": "local",
    "aws_secret_access_key": "local",
}


@pytest.fixture
def dynamodb() -> DynamoDBClient:
    return boto3.client("dynamodb", **_LOCAL)


@pytest.fixture
def streams() -> DynamoDBStreamsClient:
    return boto3.client("dynamodbstreams", **_LOCAL)


@pytest.fixture
def users_table(dynamodb: DynamoDBClient) -> Iterator[str]:
    """A fresh Users table keyed and streamed like the stack's (`src/auth/users-table.ts`)."""
    name = f"users-{uuid.uuid4()}"
    dynamodb.create_table(
        TableName=name,
        KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
        StreamSpecification={"StreamEnabled": True, "StreamViewType": "NEW_AND_OLD_IMAGES"},
    )
    yield name
    dynamodb.delete_table(TableName=name)
