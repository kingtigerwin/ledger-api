from typing import Any

from mypy_boto3_dynamodb import DynamoDBClient
from mypy_boto3_dynamodbstreams import DynamoDBStreamsClient

from ledger_api.log import Level, LogEntry
from ledger_api.notify.emails import EmailSettings
from ledger_api.notify.handler import OutgoingEmail, create_notify_handler


def stream_records(dynamodb: DynamoDBClient, streams: DynamoDBStreamsClient, table: str) -> list[dict[str, Any]]:
    """Every record on the table's stream so far, oldest first, in the shape Lambda receives them."""
    stream_arn = dynamodb.describe_table(TableName=table)["Table"]["LatestStreamArn"]
    shards = streams.describe_stream(StreamArn=stream_arn)["StreamDescription"].get("Shards", [])
    records: list[dict[str, Any]] = []
    for shard in shards:
        iterator: str | None = streams.get_shard_iterator(
            StreamArn=stream_arn, ShardId=shard["ShardId"], ShardIteratorType="TRIM_HORIZON"
        )["ShardIterator"]
        while iterator:
            page = streams.get_records(ShardIterator=iterator)
            records.extend(dict(r) for r in page["Records"])
            # An open shard always hands back a next iterator; stop once it has nothing more.
            iterator = page.get("NextShardIterator") if page["Records"] else None
    return records


def set_status(dynamodb: DynamoDBClient, table: str, status: str) -> None:
    dynamodb.update_item(
        TableName=table,
        Key={"pk": {"S": "USER#u-1"}, "sk": {"S": "PROFILE"}},
        UpdateExpression="SET #status = :status",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":status": {"S": status}},
    )


class TestEmailsFromTheUsersTablesStream:
    class TestGivenACustomerWhoRegistersFailsALoginAndIsEnabledDisabledAndEnabledAgain:
        def test_emails_them_on_sign_up_and_first_approval_and_the_admin_on_sign_up(
            self, dynamodb: DynamoDBClient, streams: DynamoDBStreamsClient, users_table: str
        ) -> None:
            # The writes the auth and admin handlers make, in the store's item shapes.
            dynamodb.put_item(
                TableName=users_table, Item={"pk": {"S": "USERNAME#haoran"}, "sk": {"S": "USERNAME"}, "userId": {"S": "u-1"}}
            )
            dynamodb.put_item(
                TableName=users_table,
                Item={
                    "pk": {"S": "USER#u-1"},
                    "sk": {"S": "PROFILE"},
                    "id": {"S": "u-1"},
                    "username": {"S": "haoran"},
                    "email": {"S": "haoran@example.com"},
                    "role": {"S": "customer"},
                    "status": {"S": "pending"},
                    "createdAt": {"S": "2026-10-28T00:00:00.000Z"},
                    "passwordHash": {"S": "scrypt$..."},
                },
            )
            dynamodb.update_item(
                TableName=users_table,
                Key={"pk": {"S": "USER#u-1"}, "sk": {"S": "PROFILE"}},
                UpdateExpression="ADD failedLogins :one",
                ExpressionAttributeValues={":one": {"N": "1"}},
            )
            for status in ["active", "disabled", "active"]:
                set_status(dynamodb, users_table, status)
            sent: list[OutgoingEmail] = []

            def log(entry: LogEntry, level: Level = "info") -> None:
                pass

            notify = create_notify_handler(
                sender="noreply@haoran.cloud",
                settings=EmailSettings(api_url="https://api.haoran.cloud", admin_email="sisi@example.com"),
                send_email=sent.append,
                log=log,
            )

            res = notify({"Records": stream_records(dynamodb, streams, users_table)})

            assert res == {"batchItemFailures": []}
            assert [e.to for e in sent] == ["sisi@example.com", "haoran@example.com", "haoran@example.com"]
            assert "haoran" in sent[0].subject
            assert "waiting for approval" in sent[1].subject.lower()
            assert "approved" in sent[2].subject.lower()
