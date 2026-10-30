import os
import uuid
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from mypy_boto3_dynamodb import DynamoDBClient
from mypy_boto3_dynamodb.service_resource import Table
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
    return boto3.client("dynamodb", **_LOCAL)  # pyright: ignore[reportUnknownMemberType]


@pytest.fixture
def streams() -> DynamoDBStreamsClient:
    return boto3.client("dynamodbstreams", **_LOCAL)  # pyright: ignore[reportUnknownMemberType]


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


@pytest.fixture
def table(users_table: str) -> Table:
    """The fresh Users table through DynamoDB's resource interface, as the Lambdas use it."""
    resource = boto3.resource("dynamodb", **_LOCAL)  # pyright: ignore[reportUnknownMemberType]
    return resource.Table(users_table)


@pytest.fixture
def data_table(dynamodb: DynamoDBClient) -> Iterator[Table]:
    """A fresh Data table with the stack's two indexes (`src/data/data-table.ts`), through the resource interface."""
    name = f"data-{uuid.uuid4()}"
    keys = ["pk", "sk", "gsi2pk", "gsi2sk", "gsi3pk", "gsi3sk"]
    dynamodb.create_table(
        TableName=name,
        KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        AttributeDefinitions=[{"AttributeName": key, "AttributeType": "S"} for key in keys],
        BillingMode="PAY_PER_REQUEST",
        GlobalSecondaryIndexes=[
            {
                "IndexName": index,
                "KeySchema": [{"AttributeName": pk, "KeyType": "HASH"}, {"AttributeName": sk, "KeyType": "RANGE"}],
                "Projection": {"ProjectionType": "ALL"},
            }
            for index, pk, sk in [("byCategory", "gsi2pk", "gsi2sk"), ("allByDate", "gsi3pk", "gsi3sk")]
        ],
    )
    yield boto3.resource("dynamodb", **_LOCAL).Table(name)  # pyright: ignore[reportUnknownMemberType]
    dynamodb.delete_table(TableName=name)
