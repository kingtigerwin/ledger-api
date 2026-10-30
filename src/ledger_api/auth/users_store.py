"""The Users table, as src/auth/users-store.ts reads and writes it (see src/auth/users-table.ts)."""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from boto3.dynamodb.conditions import Attr, Key

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

type Role = Literal["admin", "customer"]
type UserStatus = Literal["pending", "active", "disabled"]


@dataclass(frozen=True)
class User:
    id: str
    username: str
    role: Role
    status: UserStatus
    created_at: str
    # Customers give one when they register; the bootstrap admin and earlier users have none.
    email: str | None = None

    def as_json(self) -> dict[str, Any]:
        """The API's shape: camelCase, and no `email` key when there is none."""
        body: dict[str, Any] = {"id": self.id, "username": self.username}
        if self.email is not None:
            body["email"] = self.email
        return body | {"role": self.role, "status": self.status, "createdAt": self.created_at}


class UserNotFoundError(Exception):
    pass


def _profile_key(user_id: str) -> dict[str, str]:
    return {"pk": f"USER#{user_id}", "sk": "PROFILE"}


def _user(item: dict[str, Any]) -> User:
    return User(
        id=str(item["id"]),
        username=str(item["username"]),
        role=item["role"],
        status=item["status"],
        created_at=str(item["createdAt"]),
        email=str(item["email"]) if "email" in item else None,
    )


class UsersStore:
    def __init__(self, table: "Table") -> None:
        self._table = table

    def list_by_status(self, status: UserStatus) -> list[User]:
        """
        Scans the whole table. Fine at household-app scale (an admin listing a few sign-ups);
        a status index would be the upgrade if the table grows large.
        """
        users: list[User] = []
        # Table has no paginator, and the client's is typed for string expressions only, so follow the pages here.
        scan: dict[str, Any] = {"FilterExpression": Attr("sk").eq("PROFILE") & Attr("status").eq(status)}
        while True:
            page = self._table.scan(**scan)
            users.extend(_user(item) for item in page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            scan["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return sorted(users, key=lambda user: user.created_at)

    def get_by_id(self, user_id: str) -> User | None:
        item = self._table.get_item(Key=_profile_key(user_id), ConsistentRead=True).get("Item")
        return _user(item) if item else None

    def user_id_for(self, username: str) -> str | None:
        """The ID behind a username, from its claim item; usernames are stored lower-case."""
        item = self._table.get_item(Key={"pk": f"USERNAME#{username}", "sk": "USERNAME"}).get("Item")
        return str(item["userId"]) if item else None

    def usernames(self, user_ids: list[str]) -> dict[str, str]:
        """Usernames by user ID; IDs with no profile are left out. BatchGet takes at most 100 keys a call."""
        found: dict[str, str] = {}
        unique = list(dict.fromkeys(user_ids))
        name = self._table.name
        for start in range(0, len(unique), 100):
            keys: list[dict[str, Any]] = [_profile_key(user_id) for user_id in unique[start : start + 100]]
            while keys:
                res = self._table.meta.client.batch_get_item(
                    RequestItems={name: {"Keys": keys, "ProjectionExpression": "id, username"}}
                )
                found.update((str(item["id"]), str(item["username"])) for item in res["Responses"].get(name, []))
                unprocessed = res.get("UnprocessedKeys", {})
                keys = list(unprocessed[name]["Keys"]) if name in unprocessed else []
        return found

    def set_status(self, user_id: str, status: UserStatus) -> User:
        """Raises UserNotFoundError rather than creating a profile for an unknown ID."""
        try:
            res = self._table.update_item(
                Key=_profile_key(user_id),
                UpdateExpression="SET #status = :status",
                ConditionExpression=Attr("pk").exists(),
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": status},
                ReturnValues="ALL_NEW",
            )
        except self._table.meta.client.exceptions.ConditionalCheckFailedException:
            raise UserNotFoundError(user_id) from None
        return _user(res["Attributes"])

    def revoke_refresh_tokens(self, user_id: str) -> None:
        """Deletes every refresh token the user has, logging them out everywhere within one access-token lifetime."""
        query: dict[str, Any] = {
            "KeyConditionExpression": Key("pk").eq(f"USER#{user_id}") & Key("sk").begins_with("REFRESH#"),
            "ProjectionExpression": "pk, sk",
        }
        with self._table.batch_writer() as batch:
            while True:
                page = self._table.query(**query)
                for key in page.get("Items", []):
                    batch.delete_item(Key=key)
                if "LastEvaluatedKey" not in page:
                    break
                query["ExclusiveStartKey"] = page["LastEvaluatedKey"]
